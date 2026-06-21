'use strict';
'require form';
'require fs';
'require uci';
'require ui';
'require view';

const variant = 'xray_simple';
const initScript = '/etc/init.d/xray_simple';
// Import validation writes to a fixed temporary file because rpcd ACLs need
// explicit file paths; arbitrary upload paths would require broader privileges.
const importTestPath = '/tmp/xray-simple-import.json';

/**
 * 校验并解析一个正整数值。如果输入不是正整数，则返回本地化的报错字符串；校验通过则返回 true。
 * @param {any} value - 待校验的数值或字符串
 * @param {string} name - 字段名称，用于报错信息格式化
 * @returns {boolean|string} 校验结果
 */
function parsePositiveInteger(value, name) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
        return _('%s must be a positive integer').format(name);
    }
    return true;
}

/**
 * 校验输入的 IP/CIDR 地址格式是否合法。
 * @param {string} value - 待校验的 CIDR 字符串
 * @param {number} family - 地址族类型 (4 代表 IPv4, 6 代表 IPv6)
 * @returns {boolean|string} 校验通过返回 true，否则返回本地化的报错字符串
 */
function validateCidrList(value, family) {
    if (value === '') {
        return true;
    }

    const parts = value.split('/');
    if (parts.length > 2) {
        return _('Invalid CIDR value');
    }

    const maxPrefix = family === 4 ? 32 : 128;
    if (parts.length === 2) {
        const prefix = Number(parts[1]);
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
            return _('Invalid CIDR prefix length');
        }
    }

    if (family === 4) {
        return /^(\d{1,3}\.){3}\d{1,3}$/.test(parts[0]) || _('Invalid IPv4/CIDR value');
    }

    return parts[0].includes(':') || _('Invalid IPv6/CIDR value');
}

/**
 * 在前端浏览器中触发一段文本内容的下载（通常用于导出 Xray JSON 配置文件）。
 * @param {string} filename - 下载保存的文件名
 * @param {string} text - 待下载的文本内容
 */
function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * 解析底层命令执行失败时的错误输出，提取 stdout、stderr 或 message，拼接成可读的详细错误文本。
 * @param {Object|Error} err - 捕获的错误对象或含有标准输入输出流的 rpcd 错误响应
 * @returns {string} 格式化后的错误信息文本
 */
function commandErrorText(err) {
    const parts = [];
    if (err && err.stdout) {
        parts.push(err.stdout);
    }
    if (err && err.stderr) {
        parts.push(err.stderr);
    }
    if (parts.length === 0) {
        parts.push(err && err.message ? err.message : String(err));
    }
    return parts.join('\n').trim();
}

/**
 * 弹出模态框提示用户命令执行失败，并显示具体的错误堆栈或标准错误输出。
 * @param {string} title - 模态框标题
 * @param {Object|Error} err - 错误对象
 */
function showCommandError(title, err) {
    ui.showModal(title, [
        E('pre', { 'style': 'white-space: pre-wrap' }, commandErrorText(err) || _('Xray Simple command failed')),
        E('div', { 'class': 'right' }, [
            E('button', {
                'type': 'button',
                'class': 'btn',
                'click': function (ev) {
                    ev.preventDefault();
                    ui.hideModal();
                    return false;
                }
            }, _('Close command error'))
        ])
    ]);
}

/**
 * 弹出模态框提示用户命令执行完成，并展示输出结果。允许指定在关闭弹窗后是否刷新页面。
 * @param {string} title - 模态框标题
 * @param {string} text - 待展示的结果文本内容
 * @param {boolean} reloadAfterClose - 关闭弹窗后是否执行页面重载刷新
 */
function showCommandResult(title, text, reloadAfterClose) {
    // Delay reload until the user closes the modal so short-lived failures and
    // command output remain visible instead of flashing away immediately.
    ui.showModal(title, [
        E('pre', { 'style': 'white-space: pre-wrap' }, text || _('Xray Simple command completed')),
        E('div', { 'class': 'right' }, [
            E('button', {
                'type': 'button',
                'class': 'btn cbi-button cbi-button-apply',
                'click': function (ev) {
                    ev.preventDefault();
                    ui.hideModal();
                    if (reloadAfterClose) {
                        window.setTimeout(function () {
                            location.reload();
                        }, 1200);
                    }
                    return false;
                }
            }, _('OK'))
        ])
    ]);
}

/**
 * 稍后刷新页面，用于等待 LuCI 将 pending changes 写入浏览器端 change cache。
 */
function reloadSoon() {
    window.setTimeout(function () {
        location.reload();
    }, 250);
}

/**
 * 判断指定命令是否应以后台任务提交。防火墙重载和 procd 起停在真实路由器上可能超过 LuCI RPC 默认等待时间。
 * @param {string} command - 指令名称
 * @returns {boolean} 如果是长耗时控制类指令则返回 true，否则返回 false
 */
function shouldRunAsync(command) {
    return ['start_now', 'stop_now', 'restart_now', 'start_tproxy', 'stop_tproxy', 'switch_profile'].includes(command);
}

/**
 * 判断在执行完指定的命令行指令后，是否需要重载前端页面。
 * @param {string} command - 指令名称
 * @returns {boolean} 如果是起停或重启类的指令则返回 true，否则返回 false
 */
function shouldReloadAfter(command) {
    return ['start_now', 'stop_now', 'restart_now', 'start_tproxy', 'stop_tproxy', 'switch_profile'].includes(command);
}

/**
 * 封装调用后端的 init.d 脚本以执行指定的命令行命令，并在执行完成后统一处理成功或失败的弹窗呈现。
 * @param {string} command - 后端支持的指令名 (如 start_now, stop_now, test_config 等)
 * @param {Array<string>} args - 传递给后端指令的参数
 * @returns {Promise} rpcd 执行结果 Promise 对象
 */
function runCommand(command, args) {
    const commandArgs = [command].concat(args || []);
    const asyncCommand = shouldRunAsync(command);
    const execArgs = asyncCommand ? ['run_async'].concat(commandArgs) : commandArgs;

    return fs.exec(initScript, execArgs).then(function (res) {
        showCommandResult(asyncCommand ? _('Xray Simple command queued') : _('Xray Simple command completed'), res.stdout || _('Xray Simple command completed'), shouldReloadAfter(command));
    }).catch(function (err) {
        showCommandError(_('Xray Simple command failed'), err);
    });
}

/**
 * 在 LuCI Form Section 中创建一个自定义的按钮组（通常对应启动、停止、重载等动作按钮）。
 * @param {Object} section - LuCI 表单 section 实例对象
 * @param {string} tab - 当前所属标签页 ID
 * @param {string} id - 元素唯一识别符
 * @param {string} label - 标签文本
 * @param {Array<Object>} buttons - 按钮配置项列表 (含有 label, command, style 属性)
 * @returns {Object} 创建的 form.DummyValue 选项对象
 */
function commandGroup(section, tab, id, label, buttons) {
    const o = section.taboption(tab, form.DummyValue, '_' + id, label);
    o.rawhtml = true;
    o.renderWidget = function () {
        return E('div', { 'class': 'cbi-button-group' }, buttons.map(function (button) {
            return E('button', {
                'type': 'button',
                'class': 'btn cbi-button cbi-button-' + (button.style || 'button'),
                'click': function (ev) {
                    ev.preventDefault();
                    return runCommand(button.command);
                }
            }, button.label);
        }));
    };
    return o;
}

/**
 * 校验一段字符串是否是合法的 JSON 对象（且非 Array、非 null、必须是 JSON 对象结构）。
 * @param {string} value - 待校验的 JSON 配置文本
 * @returns {boolean|string} 如果合法返回 true，否则返回具体抛出的错误描述字符串
 */
function jsonObjectValidator(value) {
    try {
        const parsed = JSON.parse(value || '{}');
        if (Array.isArray(parsed) || parsed === null || typeof parsed !== 'object') {
            return _('Xray config must be a JSON object');
        }
        return true;
    } catch (e) {
        return e.message;
    }
}

/**
 * 解析后端传来的 geodata 检测输出文本。将其解析为一个包含资源路径、geoip 以及 geosite 存在状态的对象。
 * @param {string} output - 后端命令 geodata_status 的返回文本
 * @returns {Object} 解析后的状态结果结构体
 */
function parseGeodataStatus(output) {
    const status = {
        assetDir: '/usr/share/xray',
        geoip: false,
        geosite: false
    };

    (output || '').split(/\n/).forEach(function (line) {
        const parts = line.split(':');
        const key = parts.shift();
        const value = parts.join(':').trim();

        if (key === 'asset_dir') {
            status.assetDir = value || status.assetDir;
        } else if (key === 'geoip') {
            status.geoip = value === 'found';
        } else if (key === 'geosite') {
            status.geosite = value === 'found';
        }
    });

    return status;
}

return view.extend({
    /**
     * LuCI 视图的生命周期函数：在渲染页面前预先加载所需的后端数据。
     * 加载的内容包括：UCI 配置、后端 geodata 检测状态、后端服务状态、以及已生成的 nftables 规则文件内容。
     * @returns {Promise<Array>} 返回包含多个异步任务结果的 Promise
     */
    load: function () {
        // The view needs both UCI data and live init-script status. Missing
        // runtime files are expected before the service has ever started.
        return uci.load(variant).then(function () {
            return Promise.all([
                L.resolveDefault(fs.exec(initScript, ['geodata_status']), { stdout: '', stderr: '' }),
                L.resolveDefault(fs.exec(initScript, ['status']), { stdout: _('Xray Simple status unavailable'), stderr: '' }),
                L.resolveDefault(fs.read('/var/etc/xray-simple/fw4/01_xray_simple.nft'), '').then(function (fw4Rules) {
                    if (fw4Rules) {
                        return fw4Rules;
                    }
                    return L.resolveDefault(fs.read('/var/etc/xray-simple/direct_xray_simple.nft'), '');
                })
            ]);
        });
    },

    /**
     * LuCI 视图的生命周期函数：根据 load 阶段返回的数据渲染并生成前端表单 DOM。
     * 涵盖：系统设置、Xray配置与 profile 管理、进程状态管理等 3 个子标签页及保存时的 Xray 配置语法校验逻辑。
     * @param {Array} loadResult - 含有 geodata_status, status, nft_rules 结果的数组
     * @returns {Node} 渲染后的 DOM 树节点
     */
    render: function (loadResult) {
        const geodataStatus = parseGeodataStatus(loadResult[0].stdout);
        const status = loadResult[1];
        const generatedNft = loadResult[2];
        const profiles = uci.sections(variant, 'profile') || [];
        const generalConfig = (uci.sections(variant, 'general') || [])[0] || {};
        const nftMode = generalConfig.nft_mode || 'firewall4';
        const m = new form.Map(variant, _('Xray Simple'), _('Minimal Xray TProxy management. Xray JSON remains user-owned; this page only manages process and TProxy plumbing.'));
        let s, ss, o;

        s = m.section(form.TypedSection, 'general');
        s.anonymous = true;
        s.addremove = false;

        s.tab('system', _('System Settings'));
        s.tab('process', _('Process Management'));
        s.tab('logs', _('Logs'));

        o = s.taboption('system', form.Flag, 'enabled', _('Enable Xray Simple'));
        o.default = '0';
        o.rmempty = false;

        o = s.taboption('system', form.Flag, 'system_log', _('Write Xray output to system log'), _('Send Xray stdout and stderr to the OpenWrt system log. Restart Xray after changing this setting.'));
        o.default = '1';
        o.rmempty = false;

        o = s.taboption('system', form.Value, 'xray_bin', _('Xray binary'));
        o.default = '/usr/bin/xray';
        o.rmempty = false;

        o = s.taboption('system', form.Value, 'asset_dir', _('Xray asset directory'), _('Default geodata download directory. Xray Simple sets XRAY_LOCATION_ASSET to this directory when validating and running Xray.'));
        o.default = '/usr/share/xray';
        o.rmempty = false;

        o = s.taboption('system', form.DummyValue, '_geodata_notice', _('Geo database'));
        o.rawhtml = true;
        o.renderWidget = function () {
            const missing = [];
            if (!geodataStatus.geoip) {
                missing.push('geoip.dat');
            }
            if (!geodataStatus.geosite) {
                missing.push('geosite.dat');
            }

            if (missing.length === 0) {
                return E('div', {
                    'class': 'cbi-value-description',
                    'style': 'border-left: 4px solid #5cb85c; background: rgba(92, 184, 92, 0.10); padding: .75rem 1rem; border-radius: 6px; max-width: 70em'
                }, _('Geo database files found in %s.').format(geodataStatus.assetDir));
            }

            return E('div', {
                'class': 'cbi-value-description',
                'style': 'border-left: 4px solid #f0ad4e; background: rgba(240, 173, 78, 0.12); padding: .75rem 1rem; border-radius: 6px; max-width: 70em; line-height: 1.55'
            }, [
                E('strong', {}, _('Geo database required: ')),
                _('Missing %s in %s. If your JSON uses geoip: or geosite: rules, install geodata packages or download the files and place them in this directory.').format(missing.join(', '), geodataStatus.assetDir),
                E('br'),
                E('code', {}, 'opkg update && opkg install v2ray-geoip v2ray-geosite'),
                E('br'),
                E('span', {}, _('Download sources: ')),
                E('a', { 'href': 'https://github.com/v2fly/geoip', 'target': '_blank', 'rel': 'noopener noreferrer' }, 'geoip.dat'),
                E('span', {}, ' / '),
                E('a', { 'href': 'https://github.com/v2fly/domain-list-community', 'target': '_blank', 'rel': 'noopener noreferrer' }, 'geosite.dat')
            ]);
        };

        o = s.taboption('system', form.ListValue, 'nft_mode', _('Rule loading mode'));
        o.value('firewall4', _('firewall4 include'));
        o.value('direct', _('direct nft load'));
        o.default = 'firewall4';
        o.rmempty = false;

        o = s.taboption('system', form.Value, 'tproxy_port', _('TProxy port'));
        o.default = '12345';
        o.datatype = 'port';
        o.rmempty = false;

        o = s.taboption('system', form.Value, 'mark', _('Policy routing mark'));
        o.default = '1';
        o.rmempty = false;
        o.validate = function (sectionId, value) {
            return parsePositiveInteger(value, _('Policy routing mark'));
        };

        o = s.taboption('system', form.Value, 'outbound_mark', _('Xray outbound bypass mark'));
        o.default = '255';
        o.rmempty = false;
        o.validate = function (sectionId, value) {
            return parsePositiveInteger(value, _('Xray outbound bypass mark'));
        };

        o = s.taboption('system', form.Value, 'route_table_v4', _('IPv4 route table'));
        o.default = '100';
        o.rmempty = false;
        o.validate = function (sectionId, value) {
            return parsePositiveInteger(value, _('IPv4 route table'));
        };

        o = s.taboption('system', form.Value, 'route_table_v6', _('IPv6 route table'));
        o.default = '106';
        o.rmempty = false;
        o.validate = function (sectionId, value) {
            return parsePositiveInteger(value, _('IPv6 route table'));
        };

        o = s.taboption('system', form.Flag, 'proxy_lan_dns', _('Proxy LAN DNS UDP/53'));
        o.default = '1';
        o.rmempty = false;

        o = s.taboption('system', form.Flag, 'proxy_router_output', _('Proxy router-local traffic'));
        o.default = '1';
        o.rmempty = false;

        o = s.taboption('system', form.DynamicList, 'lan_ifaces', _('LAN interfaces'));
        o.placeholder = 'br-lan';

        o = s.taboption('system', form.DynamicList, 'bypass_uids', _('Bypass UIDs'));
        o.validate = function (sectionId, value) {
            return value === '' || /^\d+$/.test(value) || _('UID must be numeric');
        };

        o = s.taboption('system', form.DynamicList, 'bypass_gids', _('Bypass GIDs'));
        o.validate = function (sectionId, value) {
            return value === '' || /^\d+$/.test(value) || _('GID must be numeric');
        };

        o = s.taboption('system', form.DynamicList, 'bypass_ipv4', _('Bypass IPv4/CIDR'));
        o.validate = function (sectionId, value) {
            return validateCidrList(value, 4);
        };

        o = s.taboption('system', form.DynamicList, 'bypass_ipv6', _('Bypass IPv6/CIDR'));
        o.validate = function (sectionId, value) {
            return validateCidrList(value, 6);
        };

        ss = m.section(form.GridSection, 'profile', _('Xray Simple profiles'), _('Add a profile to import JSON, then use Switch & Restart for one-click switching.'));
        ss.anonymous = true;
        ss.addremove = true;
        ss.modaladd = true;
        ss.rowactions = true;
        ss.sortable = true;
        ss.nodescriptions = true;
        ss.handleModalSave = function (modalMap, ev) {
            return modalMap.save(null, true).then(function () {
                return uci.save();
            }).then(function () {
                delete this.map.addedSection;
                ui.hideModal();
                reloadSoon();
            }.bind(this)).catch(function (err) {
                showCommandError(_('Profile save failed'), err);
            });
        };
        ss.handleModalCancel = function (modalMap, ev, isSaving) {
            if (this.map.addedSection != null && !isSaving) {
                uci.remove(variant, this.map.addedSection);
            }
            delete this.map.addedSection;
            ui.hideModal();
            return this.map.reset();
        };
        ss.handleRemove = function (sectionId, ev) {
            uci.remove(variant, sectionId);
            return uci.save().then(function () {
                reloadSoon();
            });
        };

        o = ss.option(form.Value, 'name', _('Profile name'));
        o.rmempty = false;

        o = ss.option(form.DummyValue, '_profile_summary', _('Description'));
        o.modalonly = false;
        o.textvalue = function (sectionId) {
            const description = uci.get(variant, sectionId, 'description') || '';
            return description || E('em', {}, _('No description'));
        };

        o = ss.option(form.Value, 'description', _('Description'));
        o.modalonly = true;
        o.rmempty = true;

        o = ss.option(form.DummyValue, '_outbound_mark_notice', _('Outbound mark reminder'));
        o.modalonly = true;
        o.rawhtml = true;
        o.cfgvalue = function () {
            const outboundMark = generalConfig.outbound_mark || '255';
            return E('div', {
                'style': 'border-left: 4px solid #f0ad4e; background: rgba(240, 173, 78, 0.12); padding: .6rem .9rem; border-radius: 6px; margin-bottom: .25rem'
            }, [
                E('strong', {}, _('Important: ')),
                _('All Xray outbounds must set streamSettings.sockopt.mark to the Xray outbound bypass mark, otherwise traffic may loop back into TProxy. Current bypass mark: %s.').format(outboundMark)
            ]);
        };

        o = ss.option(form.TextValue, 'json_config', _('Profile JSON'));
        o.modalonly = true;
        o.rows = 20;
        o.wrap = 'off';
        o.rmempty = false;
        o.renderWidget = function (sectionId, optionId, value) {
            const node = form.TextValue.prototype.renderWidget.call(this, sectionId, optionId, value);
            const textarea = node.querySelector('textarea') || (node.tagName === 'TEXTAREA' ? node : null);
            if (textarea) {
                textarea.setAttribute('spellcheck', 'false');
                textarea.setAttribute('autocorrect', 'off');
                textarea.setAttribute('autocapitalize', 'off');
            }
            return node;
        };
        o.cfgvalue = function (sectionId) {
            return uci.get(variant, sectionId, 'json_config') || '{}';
        };
        o.validate = function (sectionId, value) {
            return jsonObjectValidator(value);
        };

        o = ss.option(form.DummyValue, '_profile_actions', _('Profile actions'));
        o.modalonly = false;
        o.rawhtml = true;
        o.textvalue = function (sectionId) {
            return E('div', { 'class': 'cbi-button-group' }, [
                E('button', {
                    'type': 'button',
                    'class': 'btn cbi-button cbi-button-apply',
                    'click': function (ev) {
                        ev.preventDefault();
                        return uci.save().then(function () {
                            return ui.changes.apply();
                        }).then(function () {
                            return runCommand('switch_profile', [sectionId]);
                        });
                    }
                }, _('Switch & Restart')),
                E('button', {
                    'type': 'button',
                    'class': 'btn cbi-button cbi-button-action',
                    'click': function (ev) {
                        ev.preventDefault();
                        const name = uci.get(variant, sectionId, 'name') || sectionId;
                        const json = uci.get(variant, sectionId, 'json_config') || '{}';
                        downloadText('xray-simple-' + name.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json', json);
                    }
                }, _('Export profile'))
            ]);
        };

        o = s.taboption('process', form.DummyValue, '_status', _('Xray Simple status'));
        o.rawhtml = true;
        o.cfgvalue = function () {
            return E('pre', { 'style': 'white-space: pre-wrap' }, (status.stdout || _('Xray Simple status unavailable')) + (status.stderr ? '\n' + status.stderr : ''));
        };

        commandGroup(s, 'process', 'xray_actions', _('Xray'), [
            { label: _('Start'), command: 'start_now', style: 'apply' },
            { label: _('Stop'), command: 'stop_now', style: 'reset' },
            { label: _('Restart'), command: 'restart_now', style: 'reload' }
        ]);
        commandGroup(s, 'process', 'tproxy_actions', _('TProxy'), [
            { label: _('Start TProxy'), command: 'start_tproxy', style: 'apply' },
            { label: _('Stop TProxy'), command: 'stop_tproxy', style: 'reset' }
        ]);
        commandGroup(s, 'process', 'tool_actions', _('Tools'), [
            { label: _('Validate Xray config'), command: 'test_config', style: 'action' },
            { label: _('Show nftables status'), command: 'nft_status', style: 'action' }
        ]);

        o = s.taboption('process', form.DummyValue, '_generated_nft', nftMode === 'direct' ? _('Generated direct nftables rules') : _('Generated firewall4 nftables rules'));
        o.rawhtml = true;
        o.cfgvalue = function () {
            return E('pre', { 'style': 'max-height: 32em; overflow: auto; white-space: pre-wrap' }, generatedNft || _('No generated rules yet'));
        };

        o = s.taboption('logs', form.DummyValue, '_logs_view', _('Xray runtime logs'));
        o.rawhtml = true;
        o.renderWidget = function () {
            let requestSerial = 0;
            let refreshButton;
            const logPre = E('pre', {
                'id': 'xray-simple-log-output',
                'style': 'min-height: 20em; max-height: 45em; overflow: auto; white-space: pre-wrap; word-break: break-all; background: #0d1117; color: #c9d1d9; padding: 1rem; border-radius: 6px; font-size: 0.82em; font-family: monospace; margin: 0'
            }, _('Loading…'));

            function fetchLogs() {
                const serial = ++requestSerial;
                refreshButton.disabled = true;
                logPre.textContent = _('Loading…');

                return fs.exec(initScript, ['recent_xray_logs']).then(function (res) {
                    if (serial !== requestSerial) {
                        return;
                    }
                    const text = ((res.stdout || '') + (res.stderr || '')).trim();
                    logPre.textContent = text || _('No recent Xray log entries found.');
                    logPre.scrollTop = logPre.scrollHeight;
                }).catch(function (err) {
                    if (serial !== requestSerial) {
                        return;
                    }
                    logPre.textContent = commandErrorText(err) || _('Failed to read logs.');
                }).then(function () {
                    if (serial === requestSerial) {
                        refreshButton.disabled = false;
                    }
                });
            }

            refreshButton = E('button', {
                'type': 'button',
                'class': 'btn cbi-button cbi-button-action',
                'click': function (ev) {
                    ev.preventDefault();
                    fetchLogs();
                }
            }, _('Refresh'));

            const view = E('div', {}, [
                E('div', { 'style': 'margin-bottom: 0.6rem; display: flex; gap: 0.5rem' }, [
                    refreshButton,
                    E('button', {
                        'type': 'button',
                        'class': 'btn cbi-button',
                        'click': function (ev) {
                            ev.preventDefault();
                            requestSerial++;
                            refreshButton.disabled = false;
                            logPre.textContent = '';
                        }
                    }, _('Clear'))
                ]),
                logPre
            ]);

            window.setTimeout(fetchLogs, 0);
            return view;
        };

        m.save = function () {
            return this.parse().then(function () {
                const configsToTest = [];
                const sections = uci.sections(variant, 'profile') || [];
                sections.forEach(function (s) {
                    const name = s.name || s['.name'];
                    const json = s.json_config;
                    if (json) {
                        configsToTest.push({ label: _('Profile: %s').format(name), value: json });
                    }
                });

                let chain = Promise.resolve();
                configsToTest.forEach(function (item) {
                    chain = chain.then(function () {
                        const jsonErr = jsonObjectValidator(item.value);
                        if (jsonErr !== true) {
                            return Promise.reject(_('Syntax error in %s: %s').format(item.label, jsonErr));
                        }
                        return fs.write(importTestPath, item.value).then(function () {
                            return fs.exec(initScript, ['test_json_file', importTestPath]);
                        }).catch(function (err) {
                            const detail = commandErrorText(err) || _('Validation failed');
                            return Promise.reject(_('%s test failed:\n\n%s').format(item.label, detail));
                        });
                    });
                });

                return chain;
            }).then(function () {
                return uci.save();
            }).catch(function (err) {
                ui.showModal(_('Xray Configuration Validation Failed'), [
                    E('pre', { 'style': 'white-space: pre-wrap; word-break: break-all; max-height: 24em; overflow: auto' }, String(err)),
                    E('div', { 'class': 'right' }, [
                        E('button', {
                            'class': 'btn',
                            'click': function () { ui.hideModal(); }
                        }, _('Close'))
                    ])
                ]);
                return Promise.reject(err);
            });
        };

        return m.render();
    }
});

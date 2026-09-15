'use strict';
'require form';
'require fs';
'require network';
'require tools.widgets as widgets';
'require uci';
'require ui';
'require view';

const variant = 'xray_simple';
const initScript = '/etc/init.d/xray_simple';
// The package replaces this filename with a content fingerprint at install time.
// Wait for CSS before rendering, and surface load errors instead of an unstyled form.
function loadStyles() {
    const href = L.resource('view/xray-simple/style.css');
    const previous = document.getElementById('xray-simple-styles');
    if (previous && previous.getAttribute('href') === href && previous.sheet) {
        return Promise.resolve();
    }
    if (previous) {
        previous.remove();
    }
    return new Promise(function (resolve, reject) {
        const link = E('link', { id: 'xray-simple-styles', rel: 'stylesheet', href: href });
        const timeout = window.setTimeout(failed, 15000);
        function failed() {
            window.clearTimeout(timeout);
            link.remove();
            reject(new Error(_('Unable to load Xray Simple styles. Please reload the page.')));
        }
        link.onload = function () {
            window.clearTimeout(timeout);
            resolve();
        };
        link.onerror = failed;
        document.head.appendChild(link);
    });
}

// Argon injects dark CSS without a theme attribute. Use the rendered page's
// foreground brightness, so an explicit light theme also wins over OS dark mode.
function syncTheme() {
    const rgb = window.getComputedStyle(document.body).color.match(/[\d.]+/g);
    if (!rgb || rgb.length < 3) {
        return;
    }
    const brightness = 0.2126 * Number(rgb[0]) + 0.7152 * Number(rgb[1]) + 0.0722 * Number(rgb[2]);
    document.documentElement.setAttribute('data-xray-simple-theme', brightness > 150 ? 'dark' : 'light');
}

syncTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
const themeObserver = new MutationObserver(syncTheme);
[document.documentElement, document.body].forEach(function (node) {
    themeObserver.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-darkmode'] });
});

function showModal(title, children) {
    return ui.showModal(title, [E('div', { 'class': 'xray-simple-ui xray-simple-dialog' }, children)]);
}

const longRunningCommands = ['start_now', 'stop_now', 'restart_now', 'start_tproxy', 'stop_tproxy', 'switch_profile', 'update_xray_core', 'update_geodata', 'update_resources'];

/**
 * 校验并解析一个正整数值。如果输入不是正整数，则返回本地化的报错字符串；校验通过则返回 true。
 * @param {any} value - 待校验的数值或字符串
 * @param {string} name - 字段名称，用于报错信息格式化
 * @returns {boolean|string} 校验结果
 */
function parseIntegerRange(value, name, min, max) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        return _('%s must be an integer between %s and %s').format(name, min, max);
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
        const octets = parts[0].split('.');
        return octets.length === 4 && octets.every(function (octet) {
            return /^\d{1,3}$/.test(octet) && Number(octet) <= 255;
        }) || _('Invalid IPv4/CIDR value');
    }

    try {
        new URL('http://[' + parts[0] + ']/');
        return true;
    } catch (e) {
        return _('Invalid IPv6/CIDR value');
    }
}

function validateRouteTable(value, name) {
    const rangeResult = parseIntegerRange(value, name, 1, 4294967295);
    if (rangeResult !== true) {
        return rangeResult;
    }
    return ![253, 254, 255].includes(Number(value)) || _('Route tables 253, 254, and 255 are reserved');
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
function showCommandError(title, err, reloadAfterClose) {
    showModal(title, [
        E('pre', { 'class': 'xray-simple-code' }, commandErrorText(err) || _('Xray Simple command failed')),
        E('div', { 'class': 'xray-simple-dialog-actions' }, [
            E('button', {
                'type': 'button',
                'class': 'btn',
                'click': function (ev) {
                    ev.preventDefault();
                    ui.hideModal();
                    if (reloadAfterClose) {
                        window.setTimeout(function () {
                            location.reload();
                        }, 500);
                    }
                    return false;
                }
            }, _('Close command error'))
        ])
    ]);
}

function showCommandPending() {
    showModal(_('Xray Simple command is running'), [
        E('p', { 'class': 'spinning', 'role': 'status' }, _('Waiting for the background command to finish…'))
    ]);
}

function waitForAsyncCommand(command, attempt) {
    const currentAttempt = attempt || 0;
    return fs.exec(initScript, ['async_status']).then(function (res) {
        const output = ((res.stdout || '') + (res.stderr || '')).trim();
        const match = output.match(/^exit=(\d+) command=([^\s]+)$/m);
        if (match && match[2] === command) {
            return {
                exitCode: Number(match[1]),
                output: output
            };
        }
        if (currentAttempt >= 180) {
            return Promise.reject(_('Command status polling timed out. The command may still be running.'));
        }
        return new Promise(function (resolve) {
            window.setTimeout(resolve, 1000);
        }).then(function () {
            return waitForAsyncCommand(command, currentAttempt + 1);
        });
    });
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
    showModal(title, [
        E('pre', { 'class': 'xray-simple-code' }, text || _('Xray Simple command completed')),
        E('div', { 'class': 'xray-simple-dialog-actions' }, [
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

function showDnsmasqModal(sectionId) {
    const dnsmasq_upstream = uci.get('xray_simple', sectionId, 'dnsmasq_upstream') || '0';
    const dnsmasq_xray_port = uci.get('xray_simple', sectionId, 'dnsmasq_xray_port') || '5353';

    const enabledInput = E('input', {
        'type': 'checkbox',
        'id': 'dnsmasq_upstream_cb',
        'checked': dnsmasq_upstream === '1' ? 'checked' : null,
        'change': function() {
            const portDiv = document.getElementById('dnsmasq_port_container');
            if (portDiv) {
                portDiv.style.display = this.checked ? '' : 'none';
            }
        }
    });

    const portInput = E('input', {
        'type': 'text',
        'id': 'dnsmasq_xray_port_input',
        'class': 'cbi-input-text',
        'value': dnsmasq_xray_port,
        'placeholder': '5353'
    });

    const portContainer = E('div', {
        'id': 'dnsmasq_port_container',
        'class': 'cbi-value',
        'style': dnsmasq_upstream === '1' ? '' : 'display:none'
    }, [
        E('label', { 'class': 'cbi-value-title', 'for': 'dnsmasq_xray_port_input' }, _('Xray DNS inbound port')),
        E('div', { 'class': 'cbi-value-field' }, [
            portInput,
            E('div', { 'class': 'cbi-value-description' }, _('The active Xray JSON must provide a DNS inbound listening on 127.0.0.1 at this port. Port 53 is reserved for dnsmasq.'))
        ])
    ]);

    const example = '{\n' +
        '  "inbounds": [\n' +
        '    {\n' +
        '      "tag": "dns-in",\n' +
        '      "port": 5353,\n' +
        '      "listen": "127.0.0.1",\n' +
        '      "protocol": "dokodemo-door"\n' +
        '    }\n' +
        '  ],\n' +
        '  "routing": {\n' +
        '    "rules": [\n' +
        '      {\n' +
        '        "type": "field",\n' +
        '        "inboundTag": [\n' +
        '          "dns-in"\n' +
        '        ],\n' +
        '        "outboundTag": "dns-out"\n' +
        '      }\n' +
        '    ]\n' +
        '  },\n' +
        '  "outbounds": [\n' +
        '    {\n' +
        '      "tag": "dns-out",\n' +
        '      "protocol": "dns"\n' +
        '    }\n' +
        '  ]\n' +
        '}';

    const content = E('div', { 'class': 'xray-simple-dns-form' }, [
        E('div', { 'class': 'cbi-map-descr', 'style': 'margin-bottom: 1.5rem' }, _('Use dnsmasq as the LAN DNS frontend and forward its queries to a local Xray DNS inbound.')),
        
        E('div', { 'class': 'cbi-value' }, [
            E('label', { 'class': 'cbi-value-title', 'for': 'dnsmasq_upstream_cb' }, _('Enable dnsmasq upstream')),
            E('div', { 'class': 'cbi-value-field' }, [
                enabledInput,
                E('div', { 'class': 'cbi-value-description' }, _('Let dnsmasq built-in DNS hijacking receive LAN UDP/53 and use the local Xray DNS inbound as upstream. This requires dnsmasq DNS redirect to be enabled. Restart Xray after changing this setting.'))
            ])
        ]),

        portContainer,

        E('div', { 'class': 'cbi-value' }, [
            E('label', { 'class': 'cbi-value-title' }, _('Runtime behavior')),
            E('div', { 'class': 'cbi-value-field' }, [
                E('div', {
                    'class': 'xray-simple-notice is-info'
                }, _('Xray Simple keeps /etc/config/dhcp unchanged. It installs a temporary dnsmasq fragment only while Xray is running and removes it when Xray stops or fails to start.'))
            ])
        ]),

        E('div', { 'class': 'cbi-value' }, [
            E('label', { 'class': 'cbi-value-title' }, _('Required Xray JSON configuration')),
            E('div', { 'class': 'cbi-value-field' }, [
                E('div', {
                    'class': 'cbi-value-description',
                    'style': 'margin-bottom:.75rem'
                }, _('Merge the following inbound, routing rule, and outbound into the active Xray JSON yourself. The configured Xray DNS inbound port must match this inbound, and the existing top-level dns configuration must define the required upstream servers.')),
                E('pre', {
                    'class': 'xray-simple-code'
                }, example)
            ])
        ]),

        E('div', { 'class': 'xray-simple-dialog-actions' }, [
            E('button', {
                'type': 'button',
                'class': 'btn cbi-button',
                'click': function () {
                    ui.hideModal();
                }
            }, _('Close')),
            ' ',
            E('button', {
                'type': 'button',
                'class': 'btn cbi-button cbi-button-action',
                'click': function () {
                    const isEnabled = enabledInput.checked ? '1' : '0';
                    const port = portInput.value.trim();

                    if (isEnabled === '1') {
                        if (!port || isNaN(port) || parseInt(port) <= 0 || parseInt(port) > 65535) {
                            alert(_('Invalid port number'));
                            return;
                        }
                        if (port === '53') {
                            alert(_('Port 53 is reserved for dnsmasq'));
                            return;
                        }
                    }

                    uci.set('xray_simple', sectionId, 'dnsmasq_upstream', isEnabled);
                    uci.set('xray_simple', sectionId, 'dnsmasq_xray_port', port);
                    if (isEnabled === '1') {
                        uci.set('xray_simple', sectionId, 'proxy_lan_dns', '0');
                    }

                    uci.save().then(function() {
                        ui.hideModal();
                        location.reload();
                    }).catch(function(err) {
                        alert(_('Failed to save configuration: ') + err.message);
                    });
                }
            }, _('Save'))
        ])
    ]);

    showModal(_('dnsmasq upstream'), [ content ]);

    window.setTimeout(function() {
        let p = content.parentNode;
        while (p && !p.classList.contains('modal')) {
            p = p.parentNode;
        }
        if (p) {
            p.style.width = '60rem';
            p.style.maxWidth = '95%';
        }
    }, 50);
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
    return longRunningCommands.includes(command);
}

/**
 * 判断在执行完指定的命令行指令后，是否需要重载前端页面。
 * @param {string} command - 指令名称
 * @returns {boolean} 如果是起停或重启类的指令则返回 true，否则返回 false
 */
function shouldReloadAfter(command) {
    return shouldRunAsync(command);
}

/**
 * 封装调用后端的 init.d 脚本以执行指定的命令行命令，并在执行完成后统一处理成功或失败的弹窗呈现。
 * @param {string} command - 后端支持的指令名 (如 start_now、stop_now 等)
 * @param {Array<string>} args - 传递给后端指令的参数
 * @returns {Promise} rpcd 执行结果 Promise 对象
 */
function runCommand(command, args) {
    const commandArgs = [command].concat(args || []);
    const asyncCommand = shouldRunAsync(command);
    const execArgs = asyncCommand ? ['run_async'].concat(commandArgs) : commandArgs;

    return fs.exec(initScript, execArgs).then(function (res) {
        if (!asyncCommand) {
            showCommandResult(_('Xray Simple command completed'), res.stdout || _('Xray Simple command completed'), shouldReloadAfter(command));
            return;
        }

        showCommandPending();
        return waitForAsyncCommand(command).then(function (result) {
            if (result.exitCode !== 0) {
                return Promise.reject(result.output);
            }
            showCommandResult(_('Xray Simple command completed'), result.output, shouldReloadAfter(command));
        });
    }).catch(function (err) {
        showCommandError(_('Xray Simple command failed'), err, asyncCommand && shouldReloadAfter(command));
    });
}

/**
 * 将 init 脚本的状态文本解析为适合概览卡片展示的结构。原始文本仍会保留在
 * “诊断详情”中，避免后端新增字段时前端丢失信息。
 */
function parseProcessStatus(result) {
    const stdout = (result && result.stdout || '').trim();
    const stderr = (result && result.stderr || '').trim();
    const fields = {};
    let running = false;
    let available = false;
    let pid = '';

    stdout.split(/\n/).forEach(function (line, index) {
        const runningMatch = line.match(/^Xray Simple running, pid\s+(.+)$/);
        const fieldMatch = line.match(/^([^:]+):\s*(.*)$/);

        if (runningMatch) {
            running = true;
            available = true;
            pid = runningMatch[1].trim();
        } else if (/^Xray Simple is not running$/.test(line)) {
            available = true;
        } else if (index > 0 && fieldMatch) {
            fields[fieldMatch[1].trim().toLowerCase()] = fieldMatch[2].trim();
        }
    });

    return {
        available: available,
        running: running,
        pid: pid,
        fields: fields,
        error: stderr,
        raw: [stdout, stderr].filter(Boolean).join('\n') || _('Xray Simple status unavailable')
    };
}

/**
 * 渲染进程管理面板：突出最重要的运行状态，把操作按用途分区，并将长文本诊断
 * 与 nftables 规则收进可按需展开的详情面板。
 */
function renderProcessDashboard(initialStatus, generatedNft, nftTitle) {
    let currentStatus = parseProcessStatus(initialStatus);
    let refreshButton;

    const overview = E('div', { 'class': 'xray-simple-process-overview' });
    const rawStatus = E('pre', { 'class': 'xray-simple-process-code' });
    const updatedAt = E('span', { 'class': 'xray-simple-process-updated' });

    function valueOrDash(value) {
        return value || '—';
    }

    function infoCard(label, value, wide) {
        return E('div', { 'class': 'xray-simple-process-info' + (wide ? ' is-wide' : '') }, [
            E('span', { 'class': 'xray-simple-process-info-label' }, label),
            E('span', { 'class': 'xray-simple-process-info-value', 'title': valueOrDash(value) }, [valueOrDash(value)])
        ]);
    }

    function renderOverview() {
        const fields = currentStatus.fields;
        const stateClass = !currentStatus.available ? 'is-unknown' : currentStatus.running ? 'is-running' : 'is-stopped';
        const stateTitle = !currentStatus.available
            ? _('Xray status is unavailable')
            : currentStatus.running ? _('Xray is running') : _('Xray is stopped');
        const stateDescription = !currentStatus.available
            ? _('The current process state could not be read.')
            : currentStatus.running
                ? _('The core process is active and managed by Xray Simple.')
                : _('The core process is not currently running.');
        overview.replaceChildren(
            E('div', { 'class': 'xray-simple-process-hero ' + stateClass }, [
                E('div', { 'class': 'xray-simple-process-state' }, [
                    E('span', { 'class': 'xray-simple-process-state-dot', 'aria-hidden': 'true' }),
                    E('div', {}, [
                        E('strong', {}, stateTitle),
                        E('span', {}, stateDescription)
                    ])
                ]),
                currentStatus.pid ? E('span', { 'class': 'xray-simple-process-pid' }, ['PID ' + currentStatus.pid]) : ''
            ]),
            currentStatus.error ? E('div', { 'class': 'xray-simple-process-warning' }, [currentStatus.error]) : '',
            E('div', { 'class': 'xray-simple-process-grid' }, [
                infoCard(_('Active profile'), fields['active profile']),
                infoCard(_('Rule loading mode'), fields['nft mode']),
                infoCard(_('TProxy port'), fields['tproxy port']),
                infoCard(_('Policy routing mark'), fields.mark),
                infoCard(_('DNS mode'), fields['dns mode'], true),
                infoCard(_('System log'), fields['system log'] === '1' ? _('Enabled') : fields['system log'] === '0' ? _('Disabled') : fields['system log']),
                infoCard(_('FakeDNS auto-detect'), fields['fakedns auto-detect'] === '1' ? _('Enabled') : fields['fakedns auto-detect'] === '0' ? _('Disabled') : fields['fakedns auto-detect']),
                infoCard(_('Asset directory'), fields['asset dir'], true),
                fields['detected fakedns pools']
                    ? infoCard(_('Detected FakeDNS pools'), fields['detected fakedns pools'], true)
                    : ''
            ])
        );
        rawStatus.textContent = currentStatus.raw;
        updatedAt.textContent = _('Last updated: %s').format(new Date().toLocaleTimeString());
    }

    function actionButton(label, command, style) {
        const button = E('button', {
            'type': 'button',
            'class': 'btn cbi-button cbi-button-' + style,
            'click': function (ev) {
                ev.preventDefault();
                button.disabled = true;
                return runCommand(command).then(function () {
                    button.disabled = false;
                });
            }
        }, label);
        return button;
    }

    function actionCard(title, description, buttons, wide) {
        return E('section', { 'class': 'xray-simple-process-action' + (wide ? ' is-wide' : '') }, [
            E('div', { 'class': 'xray-simple-process-action-copy' }, [
                E('strong', {}, title),
                E('span', {}, description)
            ]),
            E('div', { 'class': 'xray-simple-process-buttons' }, buttons)
        ]);
    }

    refreshButton = E('button', {
        'type': 'button',
        'class': 'btn cbi-button cbi-button-action',
        'click': function (ev) {
            ev.preventDefault();
            refreshButton.disabled = true;
            return fs.exec(initScript, ['status']).then(function (result) {
                currentStatus = parseProcessStatus(result);
                renderOverview();
            }).catch(function (err) {
                currentStatus = parseProcessStatus({ stderr: commandErrorText(err) });
                renderOverview();
            }).then(function () {
                refreshButton.disabled = false;
            });
        }
    }, _('Refresh status'));

    const dashboard = E('div', { 'class': 'xray-simple-process-dashboard' }, [
        E('div', { 'class': 'xray-simple-process-toolbar' }, [
            E('h3', {}, _('Runtime overview')),
            E('div', { 'class': 'xray-simple-process-toolbar-meta' }, [updatedAt, refreshButton])
        ]),
        overview,
        E('div', { 'class': 'xray-simple-process-actions' }, [
            actionCard(_('Xray process'), _('Control the Xray core process.'), [
                actionButton(_('Start'), 'start_now', 'apply'),
                actionButton(_('Stop'), 'stop_now', 'reset'),
                actionButton(_('Restart'), 'restart_now', 'reload')
            ]),
            actionCard(_('TProxy rules'), _('Manage transparent proxy rules separately.'), [
                actionButton(_('Start TProxy'), 'start_tproxy', 'apply'),
                actionButton(_('Stop TProxy'), 'stop_tproxy', 'reset')
            ]),
            actionCard(_('Component updates'), _('Download and safely install the latest Xray core and Geo database.'), [
                actionButton(_('Update Xray core'), 'update_xray_core', 'action'),
                actionButton(_('Update Geo database'), 'update_geodata', 'action'),
                actionButton(_('Update all'), 'update_resources', 'apply')
            ], true),
            E('section', { 'class': 'xray-simple-process-action is-wide' }, [
                E('div', { 'class': 'xray-simple-process-action-copy' }, [
                    E('strong', {}, _('Diagnostics')),
                    E('span', {}, _('Inspect the currently applied nftables state.'))
                ]),
                E('div', { 'class': 'xray-simple-process-buttons' }, [
                    actionButton(_('Show nftables status'), 'nft_status', 'action')
                ])
            ])
        ]),
        E('details', { 'class': 'xray-simple-process-details' }, [
            E('summary', {}, _('Detailed runtime status')),
            rawStatus
        ]),
        E('details', { 'class': 'xray-simple-process-details' }, [
            E('summary', {}, nftTitle),
            E('pre', { 'class': 'xray-simple-process-code' }, [generatedNft || _('No generated rules yet')])
        ])
    ]);

    renderOverview();
    return dashboard;
}

/**
 * 将系统设置标签页中的普通 LuCI 选项整理为原生 details 折叠面板。
 * 选项节点本身只会被移动，不会被重新创建，因此其依赖、校验和保存行为保持不变。
 * @param {Node} root - form.Map 渲染后的根节点
 * @param {string} sectionId - general UCI section 的实际 ID
 * @param {Array<Object>} groups - 折叠分组定义
 */
function groupSystemSettings(root, sectionId, groups) {
    const optionNode = function (optionId) {
        const frameId = 'cbi-' + variant + '-' + sectionId + '-' + optionId;
        const widgetId = 'widget.cbid.' + variant + '.' + sectionId + '.' + optionId;
        const nodes = root.querySelectorAll('[id]');

        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].id === frameId) {
                return nodes[i];
            }
            if (nodes[i].id === widgetId) {
                return nodes[i].closest('.cbi-value');
            }
        }
        return null;
    };

    const anchor = optionNode(groups[0].options[0]);
    if (!anchor || !anchor.parentNode) {
        return;
    }

    const host = E('div', { 'class': 'xray-simple-settings-groups' });
    anchor.parentNode.insertBefore(host, anchor);

    groups.forEach(function (group, index) {
        const content = E('div', { 'class': 'xray-simple-settings-group-content' });
        const attributes = { 'class': 'xray-simple-settings-group' };
        if (index === 0) {
            attributes.open = 'open';
        }
        const details = E('details', attributes, [
            E('summary', {}, [
                E('div', { 'class': 'xray-simple-settings-group-title-wrapper' }, [
                    E('span', { 'class': 'xray-simple-settings-group-title' }, group.title),
                    E('span', { 'class': 'xray-simple-settings-group-description' }, group.description)
                ]),
                E('span', { 'class': 'xray-simple-settings-group-arrow' })
            ]),
            content
        ]);

        group.options.forEach(function (optionId) {
            const node = optionNode(optionId);
            if (node) {
                content.appendChild(node);
            }
        });
        host.appendChild(details);
    });

    // Native validation events are not shown inside a closed details element.
    // Open the owning group before LuCI focuses or reports the invalid field.
    host.addEventListener('invalid', function (ev) {
        const details = ev.target.closest('details');
        if (details) {
            details.open = true;
        }
    }, true);

    // LuCI also reports some datatype failures by toggling this CSS class.
    const observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
            const target = mutation.target;
            if (target.classList && target.classList.contains('cbi-input-invalid')) {
                const details = target.closest('details');
                if (details) {
                    details.open = true;
                }
            }
        });
    });
    observer.observe(host, { subtree: true, attributes: true, attributeFilter: ['class'] });
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
        return Promise.all([loadStyles(), uci.load(variant)]).then(function () {
            syncTheme();
            return Promise.all([
                L.resolveDefault(fs.exec(initScript, ['geodata_status']), { stdout: '', stderr: '' }),
                L.resolveDefault(fs.exec(initScript, ['status']), { stdout: _('Xray Simple status unavailable'), stderr: '' }),
                L.resolveDefault(fs.read('/var/etc/xray-simple/fw4/01_xray_simple.nft'), ''),
                L.resolveDefault(fs.read('/var/etc/xray-simple/direct_xray_simple.nft'), ''),
                L.resolveDefault(fs.exec(initScript, ['dnsmasq_status']), { stdout: '', stderr: '' })
            ]);
        });
    },

    /**
     * LuCI 视图的生命周期函数：根据 load 阶段返回的数据渲染并生成前端表单 DOM。
     * 涵盖：系统设置、Xray配置与 profile 管理、进程状态管理等 3 个子标签页。
     * @param {Array} loadResult - 含有 geodata_status, status, nft_rules 结果的数组
     * @returns {Node} 渲染后的 DOM 树节点
     */
    render: function (loadResult) {
        const geodataStatus = parseGeodataStatus(loadResult[0].stdout);
        const status = loadResult[1];
        const generalConfig = (uci.sections(variant, 'general') || [])[0] || {};
        const nftMode = generalConfig.nft_mode || 'firewall4';
        const generatedNft = nftMode === 'direct' ? loadResult[3] : loadResult[2];
        const dnsmasqStatus = loadResult[4];
        const m = new form.Map(variant, _('Xray Simple'), _('Manage your Xray service, traffic policies, and configuration profiles in one place.'));
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

        o = s.taboption('system', form.Flag, 'system_log', _('Write Xray output to system log'), _('When enabled, send Xray stdout and stderr to the OpenWrt system log. When disabled, keep them only in the Xray runtime log tab. Restart Xray after changing this setting.'));
        o.default = '1';
        o.rmempty = false;

        o = s.taboption('system', form.Value, 'runtime_log_file', _('Xray runtime log file'), _('Absolute path used when system log output is disabled.'));
        o.default = '/var/etc/xray-simple/xray.log';
        o.rmempty = false;
        o.depends('system_log', '0');
        o.validate = function (sectionId, value) {
            return value && value.charAt(0) === '/' ? true : _('The runtime log path must be absolute.');
        };

        o = s.taboption('system', form.Value, 'xray_bin', _('Xray binary'));
        o.default = '/usr/bin/xray';
        o.rmempty = false;

        o = s.taboption('system', form.Value, 'asset_dir', _('Xray asset directory'), _('Default geodata download directory. Xray Simple sets XRAY_LOCATION_ASSET to this directory when running Xray.'));
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
                    'class': 'xray-simple-notice is-success'
                }, _('Geo database files found in %s.').format(geodataStatus.assetDir));
            }

            return E('div', {
                'class': 'xray-simple-notice is-warning'
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
            return parseIntegerRange(value, _('Policy routing mark'), 1, 4294967295);
        };

        o = s.taboption('system', form.Value, 'outbound_mark', _('Xray outbound bypass mark'));
        o.default = '255';
        o.rmempty = false;
        o.validate = function (sectionId, value) {
            return parseIntegerRange(value, _('Xray outbound bypass mark'), 1, 4294967295);
        };

        o = s.taboption('system', form.Value, 'route_table_v4', _('IPv4 route table'));
        o.default = '100';
        o.rmempty = false;
        o.validate = function (sectionId, value) {
            return validateRouteTable(value, _('IPv4 route table'));
        };

        o = s.taboption('system', form.Value, 'route_table_v6', _('IPv6 route table'));
        o.default = '106';
        o.rmempty = false;
        o.validate = function (sectionId, value) {
            return validateRouteTable(value, _('IPv6 route table'));
        };

        o = s.taboption('system', form.DummyValue, '_dnsmasq_upstream', _('dnsmasq upstream'));
        o.rawhtml = true;
        o.renderWidget = function (sectionId) {
            const configured = (generalConfig.dnsmasq_upstream || '0') === '1';
            const active = configured && /status: active/.test(dnsmasqStatus.stdout || '');
            const stateLabel = !configured ? _('Disabled') : active ? _('Active') : _('Inactive');
            const stateClass = !configured ? 'is-muted' : active ? 'is-success' : 'is-warning';

            return E('div', {
                'class': 'xray-simple-inline-actions'
            }, [
                E('span', {
                    'class': 'xray-simple-badge ' + stateClass
                }, [
                    stateLabel
                ]),
                E('button', {
                    'type': 'button',
                    'class': 'btn cbi-button cbi-button-action',
                    'click': function (ev) {
                        ev.preventDefault();
                        showDnsmasqModal(sectionId);
                    }
                }, _('Configure'))
            ]);
        };

        o = s.taboption('system', form.Flag, 'proxy_lan_dns', _('Proxy LAN DNS UDP/53 directly through TProxy'));
        o.default = '1';
        o.rmempty = false;

        o = s.taboption('system', form.Flag, 'proxy_router_output', _('Proxy router-local traffic'));
        o.default = '1';
        o.rmempty = false;

        o = s.taboption('system', form.Flag, 'fakedns_auto_detect', _('Automatically proxy Xray FakeDNS pools'), _('Extract IPv4 and IPv6 ipPool values from fakedns in the active Xray JSON and force them through TProxy before private-address and bypass rules. If this is disabled while FakeDNS is in use, add every FakeDNS pool to the additional proxied IPv4/IPv6 lists manually.'));
        o.default = '1';
        o.rmempty = false;

        o = s.taboption('system', form.DynamicList, 'proxy_ipv4', _('Additional proxied IPv4/CIDR'), _('Always send these IPv4 ranges through Xray. They are merged with automatically detected FakeDNS pools and take priority over bypass ranges.'));
        o.validate = function (sectionId, value) {
            return validateCidrList(value, 4);
        };

        o = s.taboption('system', form.DynamicList, 'proxy_ipv6', _('Additional proxied IPv6/CIDR'), _('Always send these IPv6 ranges through Xray. They are merged with automatically detected FakeDNS pools and take priority over ULA and bypass ranges.'));
        o.validate = function (sectionId, value) {
            return validateCidrList(value, 6);
        };

        o = s.taboption('system', widgets.DeviceSelect, 'lan_ifaces', _('Proxy interfaces'), _('Select the network interfaces whose incoming traffic should be handled by Xray TProxy.'));
        o.noaliases = true;
        // Preserve configured devices which are temporarily absent (USB, tunnels).
        // DeviceSelect drops these values when nocreate is true.
        o.nocreate = false;
        o.multiple = true;
        o.rmempty = false;
        o.validate = function (sectionId, value) {
            const rawValue = String(value || '').trim();
            const names = Array.isArray(value) ? value : (rawValue ? rawValue.split(/\s+/) : []);
            return names.every(function (name) {
                return /^[A-Za-z0-9_.:-]{1,15}$/.test(name || '');
            }) || _('Invalid network interface name');
        };

        o = s.taboption('system', form.DynamicList, 'bypass_uids', _('Bypass UIDs'));
        o.validate = function (sectionId, value) {
            return value === '' || parseIntegerRange(value, _('UID'), 0, 4294967295);
        };

        o = s.taboption('system', form.DynamicList, 'bypass_gids', _('Bypass GIDs'));
        o.validate = function (sectionId, value) {
            return value === '' || parseIntegerRange(value, _('GID'), 0, 4294967295);
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
        ss.renderMoreOptionsModal = function (sectionId, ev) {
            return form.GridSection.prototype.renderMoreOptionsModal.call(this, sectionId, ev).then(function () {
                const modalMap = this.getActiveModalMap();
                if (modalMap) {
                    modalMap.classList.add('xray-simple-ui');
                    const actions = modalMap.parentNode.querySelector('.right');
                    if (actions) {
                        actions.classList.add('xray-simple-ui', 'xray-simple-dialog-actions');
                    }
                }
            }.bind(this));
        };
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
            const remaining = (uci.sections(variant, 'profile') || []).filter(function (profile) {
                return profile['.name'] !== sectionId;
            });
            if (remaining.length === 0) {
                showCommandError(_('Profile deletion failed'), _('At least one Xray profile is required.'));
                return Promise.resolve();
            }
            if (generalConfig['.name'] && uci.get(variant, generalConfig['.name'], 'active_profile') === sectionId) {
                uci.set(variant, generalConfig['.name'], 'active_profile', remaining[0]['.name']);
            }
            uci.remove(variant, sectionId);
            return uci.save().then(function () {
                reloadSoon();
            }).catch(function (err) {
                showCommandError(_('Profile deletion failed'), err);
            });
        };

        o = ss.option(form.Value, 'name', _('Profile name'));
        o.rmempty = false;

        o = ss.option(form.DummyValue, '_profile_state', _('Status'));
        o.modalonly = false;
        o.textvalue = function (sectionId) {
            const active = generalConfig.active_profile === sectionId;
            return E('span', {
                'class': 'xray-simple-badge ' + (active ? 'is-info' : 'is-muted')
            }, active ? _('Selected profile') : _('Standby'));
        };

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
                'class': 'xray-simple-ui xray-simple-notice is-warning'
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
                textarea.classList.add('xray-simple-ui', 'xray-simple-editor');
                textarea.setAttribute('spellcheck', 'false');
                textarea.setAttribute('autocorrect', 'off');
                textarea.setAttribute('autocapitalize', 'off');
            }
            return node;
        };
        o.cfgvalue = function (sectionId) {
            return uci.get(variant, sectionId, 'json_config') || '{}';
        };

        o = ss.option(form.DummyValue, '_profile_actions', _('Profile actions'));
        o.modalonly = false;
        o.rawhtml = true;
        o.textvalue = function (sectionId) {
            return E('div', { 'class': 'xray-simple-inline-actions' }, [
                E('button', {
                    'type': 'button',
                    'class': 'btn cbi-button cbi-button-apply',
                    'click': function (ev) {
                        ev.preventDefault();
                        return uci.save().then(function () {
                            return ui.changes.apply();
                        }).then(function () {
                            return runCommand('switch_profile', [sectionId]);
                        }).catch(function (err) {
                            showCommandError(_('Profile switch failed'), err);
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

        o = s.taboption('process', form.DummyValue, '_process_dashboard', _('Process Management'));
        o.rawhtml = true;
        o.renderWidget = function () {
            return renderProcessDashboard(
                status,
                generatedNft,
                nftMode === 'direct' ? _('Generated direct nftables rules') : _('Generated firewall4 nftables rules')
            );
        };

        o = s.taboption('logs', form.DummyValue, '_logs_view', _('Xray runtime logs'));
        o.rawhtml = true;
        o.renderWidget = function () {
            let requestSerial = 0;
            let refreshButton;
            const logPre = E('pre', {
                'id': 'xray-simple-log-output',
                'class': 'xray-simple-code xray-simple-log-output',
                'tabindex': '0',
                'aria-label': _('Xray runtime logs')
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

            const view = E('div', { 'class': 'xray-simple-logs' }, [
                E('div', { 'class': 'xray-simple-process-toolbar' }, [
                    E('h3', {}, _('Xray runtime logs')),
                    E('div', { 'class': 'xray-simple-inline-actions' }, [
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
                    ])
                ]),
                logPre
            ]);

            window.setTimeout(fetchLogs, 0);
            return view;
        };

        m.save = function () {
            return this.parse().then(function () {
                const currentGeneral = (uci.sections(variant, 'general') || [])[0] || {};
                if (String(currentGeneral.mark || '1') === String(currentGeneral.outbound_mark || '255')) {
                    return Promise.reject(_('Policy routing mark and Xray outbound bypass mark must be different.'));
                }
                const lanInterfaces = Array.isArray(currentGeneral.lan_ifaces)
                    ? currentGeneral.lan_ifaces
                    : [currentGeneral.lan_ifaces];
                if (!lanInterfaces.some(function (iface) { return !!iface; })) {
                    return Promise.reject(_('At least one proxy interface is required.'));
                }

                return true;
            }).then(function () {
                return uci.save();
            });
        };

        // Reapply grouping after LuCI resets or redraws the map as well.
        const renderContents = m.renderContents;
        m.renderContents = function () {
            return Promise.resolve(renderContents.apply(this, arguments)).then(function (node) {
                groupSystemSettings(node, generalConfig['.name'], [
                    {
                        title: _('Basic Settings'),
                        description: _('Enable the service and configure the Xray runtime paths.'),
                        options: ['enabled', 'xray_bin', 'asset_dir', '_geodata_notice']
                    },
                    {
                        title: _('Logging Settings'),
                        description: _('Choose where Xray writes its runtime output.'),
                        options: ['system_log', 'runtime_log_file']
                    },
                    {
                        title: _('DNS & Forced Proxy'),
                        description: _('Configure LAN DNS handling, FakeDNS detection, and always-proxied networks.'),
                        options: ['_dnsmasq_upstream', 'proxy_lan_dns', 'fakedns_auto_detect', 'proxy_ipv4', 'proxy_ipv6']
                    },
                    {
                        title: _('Traffic Policy'),
                        description: _('Choose the proxy interfaces and which router-local traffic is proxied or bypassed.'),
                        options: ['lan_ifaces', 'proxy_router_output', 'bypass_uids', 'bypass_gids', 'bypass_ipv4', 'bypass_ipv6']
                    },
                    {
                        title: _('TProxy Advanced Settings'),
                        description: _('Low-level nftables and policy-routing parameters. The defaults are recommended.'),
                        options: ['nft_mode', 'tproxy_port', 'mark', 'outbound_mark', 'route_table_v4', 'route_table_v6']
                    }
                ]);
                node.classList.add('xray-simple-ui', 'xray-simple-page');
                node.querySelectorAll('.xray-simple-process-dashboard, .xray-simple-logs').forEach(function (panel) {
                    const frame = panel.closest('.cbi-value');
                    if (frame) {
                        frame.classList.add('xray-simple-full-width');
                    }
                });
                return node;
            });
        };
        return m.render();
    }
});

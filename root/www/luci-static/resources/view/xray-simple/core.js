'use strict';
'require form';
'require fs';
'require uci';
'require ui';
'require view';

const variant = 'xray_simple';
const initScript = '/etc/init.d/xray_simple';
const importTestPath = '/tmp/xray-simple-import.json';

function parsePositiveInteger(value, name) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
        return _('%s must be a positive integer').format(name);
    }
    return true;
}

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

function profileLabel(profile) {
    return profile.name || profile['.name'];
}

function profileBySection(profiles, sectionId) {
    for (const profile of profiles) {
        if (profile['.name'] === sectionId) {
            return profile;
        }
    }
    return null;
}

function currentProfileSection(profiles, configuredSection) {
    if (profileBySection(profiles, configuredSection)) {
        return configuredSection;
    }
    return profiles.length ? profiles[0]['.name'] : '';
}

function configFilename(name) {
    return 'xray-simple-' + (name || 'current').replace(/[^A-Za-z0-9_.-]/g, '_') + '.json';
}

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

function showCommandError(title, err) {
    ui.showModal(title, [
        E('pre', { 'style': 'white-space: pre-wrap' }, commandErrorText(err) || _('Xray Simple command failed')),
        E('div', { 'class': 'right' }, [
            E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close command error'))
        ])
    ]);
}

function showCommandResult(title, text, reloadAfterClose) {
    ui.showModal(title, [
        E('pre', { 'style': 'white-space: pre-wrap' }, text || _('Xray Simple command completed')),
        E('div', { 'class': 'right' }, [
            E('button', {
                'class': 'btn cbi-button cbi-button-apply',
                'click': function () {
                    ui.hideModal();
                    if (reloadAfterClose) {
                        location.reload();
                    }
                }
            }, _('OK'))
        ])
    ]);
}

function shouldReloadAfter(command) {
    return ['start_now', 'stop_now', 'restart_now', 'start_tproxy', 'stop_tproxy'].includes(command);
}

function runCommand(command) {
    return fs.exec(initScript, [command]).then(function (res) {
        showCommandResult(_('Xray Simple command completed'), res.stdout || _('Xray Simple command completed'), shouldReloadAfter(command));
    }).catch(function (err) {
        showCommandError(_('Xray Simple command failed'), err);
    });
}

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
    load: function () {
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

    render: function (loadResult) {
        const geodataStatus = parseGeodataStatus(loadResult[0].stdout);
        const status = loadResult[1];
        const generatedNft = loadResult[2];
        const profiles = uci.sections(variant, 'profile') || [];
        const generalConfig = (uci.sections(variant, 'general') || [])[0] || {};
        const nftMode = generalConfig.nft_mode || 'firewall4';
        const m = new form.Map(variant, _('Xray Simple'), _('Minimal Xray TProxy management. Xray JSON remains user-owned; this page only manages process and TProxy plumbing.'));
        let s, ss, o, activeProfileOpt, jsonConfigOpt, importNameOpt, importDescriptionOpt, importJsonOpt;

        s = m.section(form.TypedSection, 'general');
        s.anonymous = true;
        s.addremove = false;

        s.tab('system', _('System Settings'));
        s.tab('config', _('Xray Config'));
        s.tab('process', _('Process Management'));

        o = s.taboption('system', form.Flag, 'enabled', _('Enable Xray Simple'));
        o.default = '0';
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

        o = s.taboption('config', form.DummyValue, '_outbound_mark_notice', _('Outbound mark reminder'));
        o.rawhtml = true;
        o.cfgvalue = function () {
            const outboundMark = generalConfig.outbound_mark || '255';
            return E('div', {
                'class': 'cbi-value-description',
                'style': 'border-left: 4px solid #f0ad4e; background: rgba(240, 173, 78, 0.12); padding: .75rem 1rem; border-radius: 6px; max-width: 70em'
            }, [
                E('strong', {}, _('Important: ')),
                _('All Xray outbounds must set streamSettings.sockopt.mark to the Xray outbound bypass mark, otherwise traffic may loop back into TProxy. Current bypass mark: %s.').format(outboundMark)
            ]);
        };

        activeProfileOpt = s.taboption('config', form.ListValue, 'active_profile', _('Active profile'));
        for (const profile of profiles) {
            activeProfileOpt.value(profile['.name'], profileLabel(profile));
        }
        activeProfileOpt.rmempty = false;
        activeProfileOpt.cfgvalue = function (sectionId) {
            return currentProfileSection(profiles, uci.get(variant, sectionId, 'active_profile') || '');
        };

        jsonConfigOpt = s.taboption('config', form.TextValue, 'json_config', _('Xray JSON configuration'));
        jsonConfigOpt.rows = 28;
        jsonConfigOpt.wrap = 'off';
        jsonConfigOpt.rmempty = false;
        jsonConfigOpt.cfgvalue = function (sectionId) {
            const profileId = currentProfileSection(profiles, uci.get(variant, sectionId, 'active_profile') || '');
            const profile = profileBySection(profiles, profileId);
            if (profile) {
                return profile.json_config || '{}';
            }
            return uci.get(variant, sectionId, 'json_config') || '{}';
        };
        jsonConfigOpt.write = function (sectionId, value) {
            const profileId = currentProfileSection(profiles, activeProfileOpt.formvalue(sectionId) || '');
            if (profileBySection(profiles, profileId)) {
                uci.set(variant, profileId, 'json_config', value);
            } else {
                uci.set(variant, sectionId, 'json_config', value);
            }
        };
        jsonConfigOpt.validate = function (sectionId, value) {
            return jsonObjectValidator(value);
        };
        activeProfileOpt.onchange = function (ev, sectionId, value) {
            const profile = profileBySection(profiles, value);
            const editor = document.getElementById(jsonConfigOpt.cbid(sectionId));
            if (profile && editor) {
                editor.value = profile.json_config || '{}';
            }
        };

        o = s.taboption('config', form.Button, '_export_current', _('Export current JSON'));
        o.inputstyle = 'action';
        o.onclick = function (sectionId) {
            const profileId = currentProfileSection(profiles, activeProfileOpt.formvalue(sectionId) || '');
            const profile = profileBySection(profiles, profileId);
            downloadText(configFilename(profile ? profileLabel(profile) : 'current'), jsonConfigOpt.formvalue(sectionId) || '{}');
        };

        importNameOpt = s.taboption('config', form.Value, 'import_profile_name', _('Import profile name'));
        importNameOpt.placeholder = 'new-profile';
        importNameOpt.rmempty = true;

        importDescriptionOpt = s.taboption('config', form.Value, 'import_profile_description', _('Import profile description'));
        importDescriptionOpt.placeholder = _('Optional short profile note');
        importDescriptionOpt.rmempty = true;

        importJsonOpt = s.taboption('config', form.TextValue, 'import_json', _('Import JSON as profile'));
        importJsonOpt.rows = 12;
        importJsonOpt.wrap = 'off';
        importJsonOpt.rmempty = true;
        importJsonOpt.validate = function (sectionId, value) {
            return true;
        };

        o = s.taboption('config', form.Button, '_import_profile', _('Import as new profile'));
        o.inputstyle = 'apply';
        o.onclick = function (sectionId) {
            const name = importNameOpt.formvalue(sectionId) || 'imported';
            const description = importDescriptionOpt.formvalue(sectionId) || '';
            const json = importJsonOpt.formvalue(sectionId) || '';

            return fs.write(importTestPath, json).then(function () {
                return fs.exec(initScript, ['test_json_file', importTestPath]);
            }).then(function () {
                const profileId = uci.add(variant, 'profile');
                uci.set(variant, profileId, 'name', name);
                uci.set(variant, profileId, 'description', description);
                uci.set(variant, profileId, 'json_config', json);
                uci.set(variant, sectionId, 'active_profile', profileId);
                uci.set(variant, sectionId, 'import_profile_name', '');
                uci.set(variant, sectionId, 'import_profile_description', '');
                uci.set(variant, sectionId, 'import_json', '');

                return uci.save().then(function () {
                    return ui.changes.apply();
                }).then(function () {
                    showCommandResult(_('Import profile completed'), _('Xray Simple profile imported'), true);
                });
            }).catch(function (err) {
                ui.showModal(_('Import profile failed'), [
                    E('pre', { 'style': 'white-space: pre-wrap' }, commandErrorText(err) || _('Import profile failed')),
                    E('div', { 'class': 'right' }, [
                        E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close import error'))
                    ])
                ]);
            });
        };

        ss = m.section(form.GridSection, 'profile', _('Xray Simple profiles'), _('Add a profile to import JSON, then use Switch & Restart for one-click switching.'));
        ss.anonymous = true;
        ss.addremove = true;
        ss.sortable = true;
        ss.nodescriptions = true;

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

        o = ss.option(form.TextValue, 'json_config', _('Profile JSON'));
        o.modalonly = true;
        o.rows = 20;
        o.wrap = 'off';
        o.rmempty = false;
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
                            return fs.exec(initScript, ['switch_profile', sectionId]);
                        }).then(function (res) {
                            showCommandResult(_('Xray Simple profile switched'), res.stdout || _('Xray Simple profile switched'), true);
                        }).catch(function (err) {
                            showCommandError(_('Xray Simple command failed'), err);
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

        return m.render();
    }
});

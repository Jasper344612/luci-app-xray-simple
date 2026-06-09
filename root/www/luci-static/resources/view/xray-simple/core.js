'use strict';
'require form';
'require fs';
'require uci';
'require ui';
'require view';

const variant = 'xray_simple';
const initScript = '/etc/init.d/xray_simple';

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

function commandButton(section, tab, label, command, style) {
    const o = section.taboption(tab, form.Button, '_' + command, label);
    o.inputstyle = style || 'button';
    o.onclick = function () {
        return fs.exec(initScript, [command]).then(function (res) {
            ui.addNotification(null, E('pre', {}, res.stdout || _('Command completed')), 'info');
        }).catch(function (err) {
            ui.addNotification(null, E('pre', {}, err.message || String(err)), 'danger');
        });
    };
    return o;
}

return view.extend({
    load: function () {
        return Promise.all([
            uci.load(variant),
            L.resolveDefault(fs.exec(initScript, ['status']), { stdout: _('Status unavailable'), stderr: '' }),
            L.resolveDefault(fs.read('/var/etc/xray-simple/fw4/01_xray_simple.nft'), '').then(function (fw4Rules) {
                if (fw4Rules) {
                    return fw4Rules;
                }
                return L.resolveDefault(fs.read('/var/etc/xray-simple/direct_xray_simple.nft'), '');
            })
        ]);
    },

    render: function (loadResult) {
        const status = loadResult[1];
        const generatedNft = loadResult[2];
        const profiles = uci.sections(variant, 'profile') || [];
        const m = new form.Map(variant, _('Xray Simple'), _('Minimal Xray TProxy management. Xray JSON remains user-owned; this page only manages process and TProxy plumbing.'));
        let s, ss, o, importNameOpt, importJsonOpt;

        s = m.section(form.TypedSection, 'general');
        s.anonymous = true;
        s.addremove = false;

        s.tab('system', _('System Settings'));
        s.tab('config', _('Xray Config'));
        s.tab('process', _('Process'));

        o = s.taboption('system', form.Flag, 'enabled', _('Enable'));
        o.default = '0';
        o.rmempty = false;

        o = s.taboption('system', form.Value, 'xray_bin', _('Xray binary'));
        o.default = '/usr/bin/xray';
        o.rmempty = false;

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

        o = s.taboption('system', form.Flag, 'proxy_lan_dns', _('Proxy LAN DNS port 53'));
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
        o.placeholder = '202.204.0.0/16';
        o.validate = function (sectionId, value) {
            return validateCidrList(value, 4);
        };

        o = s.taboption('system', form.DynamicList, 'bypass_ipv6', _('Bypass IPv6/CIDR'));
        o.placeholder = '2001:da8::/32';
        o.validate = function (sectionId, value) {
            return validateCidrList(value, 6);
        };

        o = s.taboption('config', form.ListValue, 'active_profile', _('Active profile'));
        o.value('', _('Use legacy JSON below'));
        for (const profile of profiles) {
            o.value(profile['.name'], profile.name || profile['.name']);
        }
        o.rmempty = true;

        o = s.taboption('config', form.TextValue, 'json_config', _('Xray JSON configuration'));
        o.rows = 28;
        o.wrap = 'off';
        o.rmempty = false;
        o.validate = function (sectionId, value) {
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed) || parsed === null || typeof parsed !== 'object') {
                    return _('Xray config must be a JSON object');
                }
                return true;
            } catch (e) {
                return e.message;
            }
        };

        o = s.taboption('config', form.Button, '_export_legacy', _('Export legacy JSON'));
        o.inputstyle = 'action';
        o.onclick = function () {
            const general = uci.sections(variant, 'general')[0];
            downloadText('xray-simple-legacy.json', uci.get(variant, general['.name'], 'json_config') || '{}');
        };

        importNameOpt = s.taboption('config', form.Value, 'import_profile_name', _('Import profile name'));
        importNameOpt.placeholder = 'new-profile';
        importNameOpt.rmempty = true;

        importJsonOpt = s.taboption('config', form.TextValue, 'import_json', _('Import JSON as profile'));
        importJsonOpt.rows = 12;
        importJsonOpt.wrap = 'off';
        importJsonOpt.rmempty = true;
        importJsonOpt.validate = function (sectionId, value) {
            if (value === '') {
                return true;
            }
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed) || parsed === null || typeof parsed !== 'object') {
                    return _('Xray config must be a JSON object');
                }
                return true;
            } catch (e) {
                return e.message;
            }
        };

        o = s.taboption('config', form.Button, '_import_profile', _('Import as new profile'));
        o.inputstyle = 'apply';
        o.onclick = function (sectionId) {
            const name = importNameOpt.formvalue(sectionId) || 'imported';
            const json = importJsonOpt.formvalue(sectionId) || '';
            try {
                const parsed = JSON.parse(json);
                if (Array.isArray(parsed) || parsed === null || typeof parsed !== 'object') {
                    throw new Error(_('Xray config must be a JSON object'));
                }
            } catch (e) {
                ui.addNotification(null, E('pre', {}, e.message), 'danger');
                return Promise.resolve();
            }

            const profileId = uci.add(variant, 'profile');
            uci.set(variant, profileId, 'name', name);
            uci.set(variant, profileId, 'json_config', json);
            uci.set(variant, sectionId, 'import_profile_name', '');
            uci.set(variant, sectionId, 'import_json', '');

            return uci.save().then(function () {
                return ui.changes.apply();
            }).then(function () {
                location.reload();
            });
        };

        ss = m.section(form.GridSection, 'profile', _('Profiles'), _('Add a profile to import JSON, then use Switch & Restart for one-click switching.'));
        ss.anonymous = true;
        ss.addremove = true;
        ss.sortable = true;
        ss.nodescriptions = true;

        o = ss.option(form.Value, 'name', _('Name'));
        o.rmempty = false;

        o = ss.option(form.TextValue, 'json_config', _('JSON'));
        o.rows = 16;
        o.wrap = 'off';
        o.rmempty = false;
        o.validate = function (sectionId, value) {
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed) || parsed === null || typeof parsed !== 'object') {
                    return _('Xray config must be a JSON object');
                }
                return true;
            } catch (e) {
                return e.message;
            }
        };

        o = ss.option(form.Button, '_switch', _('Switch & Restart'));
        o.inputstyle = 'apply';
        o.onclick = function (sectionId) {
            return uci.save().then(function () {
                return ui.changes.apply();
            }).then(function () {
                return fs.exec(initScript, ['switch_profile', sectionId]);
            }).then(function (res) {
                ui.addNotification(null, E('pre', {}, res.stdout || _('Profile switched')), 'info');
                return location.reload();
            }).catch(function (err) {
                ui.addNotification(null, E('pre', {}, err.message || String(err)), 'danger');
            });
        };

        o = ss.option(form.Button, '_export', _('Export'));
        o.inputstyle = 'action';
        o.onclick = function (sectionId) {
            const name = uci.get(variant, sectionId, 'name') || sectionId;
            const json = uci.get(variant, sectionId, 'json_config') || '{}';
            downloadText('xray-simple-' + name.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json', json);
        };

        o = s.taboption('process', form.DummyValue, '_status', _('Status'));
        o.rawhtml = true;
        o.cfgvalue = function () {
            return E('pre', { 'style': 'white-space: pre-wrap' }, (status.stdout || _('Status unavailable')) + (status.stderr ? '\n' + status.stderr : ''));
        };

        commandButton(s, 'process', _('Start'), 'start_now', 'apply');
        commandButton(s, 'process', _('Stop'), 'stop_now', 'reset');
        commandButton(s, 'process', _('Restart'), 'restart_now', 'reload');
        commandButton(s, 'process', _('Validate config'), 'test_config', 'action');
        commandButton(s, 'process', _('nftables status'), 'nft_status', 'action');

        o = s.taboption('process', form.DummyValue, '_generated_nft', _('Generated nftables rules'));
        o.rawhtml = true;
        o.cfgvalue = function () {
            return E('pre', { 'style': 'max-height: 32em; overflow: auto; white-space: pre-wrap' }, generatedNft || _('No generated rules yet'));
        };

        return m.render();
    }
});

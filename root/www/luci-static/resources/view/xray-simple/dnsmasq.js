'use strict';
'require form';
'require fs';
'require uci';
'require view';

const variant = 'xray_simple';
const initScript = '/etc/init.d/xray_simple';

return view.extend({
    load: function () {
        return Promise.all([
            uci.load(variant),
            L.resolveDefault(fs.exec(initScript, ['dnsmasq_status']), { stdout: _('dnsmasq status unavailable'), stderr: '' })
        ]);
    },

    render: function (loadResult) {
        const status = loadResult[1];
        const m = new form.Map(variant, _('dnsmasq upstream'), _('Use dnsmasq as the LAN DNS frontend and forward its queries to a local Xray DNS inbound.'));
        let s, o;

        s = m.section(form.TypedSection, 'general');
        s.anonymous = true;
        s.addremove = false;

        o = s.option(form.DummyValue, '_navigation', _('Navigation'));
        o.rawhtml = true;
        o.renderWidget = function () {
            return E('button', {
                'type': 'button',
                'class': 'btn cbi-button cbi-button-neutral',
                'click': function (ev) {
                    ev.preventDefault();
                    window.location.href = L.url('admin/services/xray_simple');
                }
            }, _('Back to Xray Simple'));
        };

        o = s.option(form.DummyValue, '_status', _('Activation status'));
        o.rawhtml = true;
        o.renderWidget = function () {
            return E('pre', {
                'style': 'white-space:pre-wrap; margin:0; max-width:70em'
            }, (status.stdout || status.stderr || _('dnsmasq status unavailable')).trim());
        };

        o = s.option(form.Flag, 'dnsmasq_upstream', _('Enable dnsmasq upstream'));
        o.default = '0';
        o.rmempty = false;
        o.description = _('Redirect LAN UDP/53 to dnsmasq and use the local Xray DNS inbound as upstream. Enabling this option automatically disables direct LAN DNS UDP/53 TProxy. Restart Xray after changing this setting.');
        o.write = function (sectionId, value) {
            uci.set(variant, sectionId, 'dnsmasq_upstream', value);
            if (value === '1')
                uci.set(variant, sectionId, 'proxy_lan_dns', '0');
        };

        o = s.option(form.Value, 'dnsmasq_xray_port', _('Xray DNS inbound port'));
        o.default = '5353';
        o.datatype = 'port';
        o.rmempty = false;
        o.depends('dnsmasq_upstream', '1');
        o.description = _('The active Xray JSON must provide a DNS inbound listening on 127.0.0.1 at this port. Port 53 is reserved for dnsmasq.');
        o.validate = function (sectionId, value) {
            return value !== '53' || _('Port 53 is reserved for dnsmasq');
        };

        o = s.option(form.DummyValue, '_behavior', _('Runtime behavior'));
        o.rawhtml = true;
        o.renderWidget = function () {
            return E('div', {
                'class': 'cbi-value-description',
                'style': 'border-left:4px solid #4b74c6; background:rgba(75,116,198,.09); padding:.75rem 1rem; max-width:70em; line-height:1.55'
            }, _('Xray Simple keeps /etc/config/dhcp unchanged. It installs a temporary dnsmasq fragment only while Xray is running and removes it when Xray stops or fails to start.'));
        };

        o = s.option(form.DummyValue, '_xray_dns_example', _('Required Xray JSON configuration'));
        o.rawhtml = true;
        o.renderWidget = function () {
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

            return E('div', { 'style': 'max-width:70em' }, [
                E('div', {
                    'class': 'cbi-value-description',
                    'style': 'margin-bottom:.75rem'
                }, _('Merge the following inbound, routing rule, and outbound into the active Xray JSON yourself. The configured Xray DNS inbound port must match this inbound, and the existing top-level dns configuration must define the required upstream servers.')),
                E('pre', {
                    'style': 'white-space:pre; overflow:auto; max-height:34rem; margin:0'
                }, example)
            ]);
        };

        return m.render();
    }
});

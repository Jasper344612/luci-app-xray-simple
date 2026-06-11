# luci-app-xray-simple

Minimal LuCI application for running Xray with transparent proxy plumbing on OpenWrt / ImmortalWrt.

The app intentionally keeps Xray configuration user-owned: you edit and switch full JSON profiles, while LuCI only manages process control, nftables/firewall4 rules, policy routing, and a few common safety settings.

## Features

- Three LuCI tabs: system settings, Xray JSON configuration, and process management.
- Multiple JSON profiles with one-click switch and restart.
- Import/export profile JSON.
- Xray config validation using the installed Xray binary.
- TProxy rule generation for `firewall4` include mode or direct `nft` mode.
- LAN interface selection, bypass IPv4/IPv6 CIDR lists, bypass UID/GID, policy mark and route table settings.
- nftables status view with generated rule preview.
- Geo database reminder for `geoip.dat` and `geosite.dat`.
- Optional Chinese translation package: `luci-app-xray-simple-zh`.

## Requirements

Runtime packages:

```sh
opkg install luci-base firewall4 kmod-nft-tproxy xray-core
```

If your Xray JSON uses `geoip:` or `geosite:` rules, install geodata too:

```sh
opkg update
opkg install v2ray-geoip v2ray-geosite
```

The default Xray asset directory is:

```text
/usr/share/xray
```

`xray_simple` sets `XRAY_LOCATION_ASSET` to this directory when validating and running Xray. You can change the directory in LuCI under **System Settings -> Xray asset directory**.

## Installation

Install or upgrade the generated package directly:

```sh
opkg install ./luci-app-xray-simple_*.ipk
```

For Chinese UI strings:

```sh
opkg install ./luci-app-xray-simple-zh_*.ipk
```

After installation, open:

```text
LuCI -> Services -> Xray Simple
```

The package post-install script reloads `rpcd` and clears LuCI caches so upgrades should be installable over the previous package without uninstalling first.

## Xray JSON Notes

Every outbound in your Xray JSON must set `streamSettings.sockopt.mark` to the configured **Xray outbound bypass mark**. The default mark is `255`.

Example:

```json
{
  "protocol": "freedom",
  "tag": "direct",
  "streamSettings": {
    "sockopt": {
      "mark": 255
    }
  }
}
```

Without this mark, Xray outbound traffic can be captured by the TProxy rules again and loop back into Xray.

The default profile includes a local `dokodemo-door` TProxy inbound on port `12345`.

## TProxy Behavior

The generated nftables rules use these defaults:

- TProxy listen port: `12345`
- policy routing mark: `1`
- Xray outbound bypass mark: `255`
- IPv4 route table: `100`
- IPv6 route table: `106`
- LAN interface: `br-lan`

Private IPv4 ranges are bypassed:

```text
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
```

IPv6 ULA is bypassed:

```text
fc00::/7
```

When **Proxy LAN DNS UDP/53** is enabled, LAN-side UDP/53 traffic is intercepted before private-range bypass rules. TCP/53 is not intercepted by the DNS-specific rule.

## Rule Loading Modes

### firewall4 include

This is the default mode. The service writes:

```text
/var/etc/xray-simple/fw4/01_xray_simple.nft
```

and installs a firewall4 table-pre include:

```text
/usr/share/nftables.d/table-pre/xray_simple.nft
```

firewall4 then loads the generated chains when the firewall restarts.

### direct nft load

Direct mode writes and loads a standalone table:

```text
/var/etc/xray-simple/direct_xray_simple.nft
table inet xray_simple
```

Use this mode only when you want `xray_simple` to manage its own nft table outside firewall4.

## Useful Commands

```sh
/etc/init.d/xray_simple start
/etc/init.d/xray_simple stop
/etc/init.d/xray_simple restart
/etc/init.d/xray_simple status
/etc/init.d/xray_simple test_config
/etc/init.d/xray_simple nft_status
/etc/init.d/xray_simple geodata_status
```

Start or stop only the TProxy rules and policy routes:

```sh
/etc/init.d/xray_simple start_tproxy
/etc/init.d/xray_simple stop_tproxy
```

Export the active profile JSON:

```sh
/etc/init.d/xray_simple export_profile
```

## GitHub Builds

The workflow builds packages for:

- `x86_64`
- `armv8a`

Each push stamps `PKG_RELEASE` with the GitHub run number so artifacts from newer commits can be installed as upgrades.

Download artifacts from the latest GitHub Actions run:

```text
https://github.com/Jasper344612/luci-app-xray-simple/actions
```

## Local Checks

From this repository:

```sh
node --check root/www/luci-static/resources/view/xray-simple/core.js
sh -n root/etc/init.d/xray_simple
sh -n root/etc/uci-defaults/xray_simple
jq . root/usr/share/rpcd/acl.d/luci-app-xray-simple.json
msgfmt --check-format -o /tmp/xray-simple.mo po/zh_Hans/xray-simple.po
```

## License

The OpenWrt package metadata declares MPL-2.0. Keep `LICENSE` aligned with that metadata when publishing releases.

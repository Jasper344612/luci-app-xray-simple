# luci-app-xray-simple

[English](README.md) | [简体中文](README.zh-CN.md)

Minimal LuCI application for running Xray with transparent proxy plumbing on OpenWrt / ImmortalWrt.

The app intentionally keeps Xray configuration user-owned: you edit and switch full JSON profiles, while LuCI only manages process control, nftables/firewall4 rules, policy routing, and a few common safety settings.

## Features

- Three LuCI tabs: system settings, process management, and runtime logs.
- Multiple JSON profiles with one-click switch and restart.
- Import/export profile JSON.
- TProxy rule generation for `firewall4` include mode or direct `nft` mode.
- LAN interface selection, bypass IPv4/IPv6 CIDR lists, bypass UID/GID, policy mark and route table settings.
- Automatic extraction of Xray `fakedns[].ipPool` plus manual forced-proxy IPv4/IPv6 CIDRs.
- nftables status view with generated rule preview.
- Xray runtime logs remain available in LuCI, with optional forwarding to the OpenWrt system log.
- The private runtime log path is configurable and defaults to `/var/etc/xray-simple/xray.log`.
- Optional dnsmasq frontend with a local Xray DNS inbound as its upstream.
- Geo database reminder for `geoip.dat` and `geosite.dat`.
- Optional Chinese translation package: `luci-app-xray-simple-zh`.

## Requirements

Install the runtime packages provided by OpenWrt:

```sh
opkg install luci-base firewall4 ip-full kmod-nft-tproxy
```

Xray is intentionally not a package dependency because Xray Core releases
frequently. Install the version you need yourself, or place an executable Xray
binary at the path configured under **System Settings -> Xray binary**. The
default path is `/usr/bin/xray`.

OpenWrt 25.12 uses `apk`; install its runtime packages with:

```sh
apk add luci-base firewall4 ip-full kmod-nft-tproxy
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

`xray_simple` sets `XRAY_LOCATION_ASSET` to this directory when running Xray. You can change the directory in LuCI under **System Settings -> Xray asset directory**.

## Installation

Install or upgrade the generated package directly:

```sh
opkg install ./luci-app-xray-simple_*.ipk
```

On OpenWrt 25.12:

```sh
apk add --allow-untrusted ./luci-app-xray-simple-*.apk
```

For Chinese UI strings:

```sh
opkg install ./luci-app-xray-simple-zh_*.ipk
```

Use the corresponding `luci-app-xray-simple-zh-*.apk` artifact on OpenWrt
25.12.

After installation, open:

```text
LuCI -> Services -> Xray Simple
```

The package post-install script reloads `rpcd` and clears LuCI caches so upgrades should be installable over the previous package without uninstalling first.

Saving and applying LuCI settings only commits UCI configuration. It does not
restart Xray or firewall4. Use **Restart** or the TProxy controls after changing
runtime settings; this separation prevents LuCI's apply-confirm transaction
from timing out during a firewall restart.

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

IPv4 link-local, IPv6 link-local, and IPv6 multicast destinations are also
bypassed. At least one valid LAN interface is required; an empty interface list
never falls back to intercepting every ingress interface.

**Automatically proxy Xray FakeDNS pools** is enabled by default. At startup,
the service extracts IPv4 and IPv6 `fakedns[].ipPool` values from the active
materialized JSON and merges them with the manually configured additional
proxied CIDRs. The generated `proxy_ipv4` and `proxy_ipv6` nft sets are handled
before private, ULA, and user bypass rules, so pools such as `198.18.0.0/15` and
`fc00::/18` are always delivered to Xray. Forced-proxy ranges take priority over
bypass ranges.

When **Proxy LAN DNS UDP/53** is enabled, LAN-side UDP/53 traffic is intercepted before private-range bypass rules. TCP/53 is not intercepted by the DNS-specific rule.

### dnsmasq upstream mode

When **Use dnsmasq as Xray DNS frontend** is enabled, Xray Simple:

- explicitly returns LAN UDP/53 from the earlier TProxy prerouting chain so it cannot enter Xray `all-in`;
- relies on dnsmasq's later built-in DNS redirect rule to deliver UDP/53 to the local resolver; `dns_redirect=1` must be enabled in `/etc/config/dhcp`;
- disables the direct UDP/53 TProxy exception;
- writes a runtime-only dnsmasq fragment using `127.0.0.1:5353` (or the configured port) as upstream;
- removes the fragment and restarts dnsmasq when Xray stops or fails to start.

The active Xray JSON must contain a DNS inbound bound to `127.0.0.1` on the configured port. Xray Simple does not modify user JSON. The runtime fragment is stored in the conf-dir of each active dnsmasq instance; `/etc/config/dhcp` is not changed.

The System Settings tab shows the live dnsmasq upstream activation state. Use
its **Configure** button to open the dedicated dnsmasq settings page.

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
/etc/init.d/xray_simple nft_status
/etc/init.d/xray_simple geodata_status
/etc/init.d/xray_simple recent_xray_logs
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

GitHub Actions runs automatically for every push to every branch and tag. It
also runs for pull requests, and can be started manually with
`workflow_dispatch` from the Actions page.

The workflow builds packages for OpenWrt 23.05.5 and 25.12.5 on:

- `x86_64`
- `armv8a`

OpenWrt 23.05 artifacts use `.ipk`; OpenWrt 25.12 artifacts use `.apk`.
Artifact names include both the OpenWrt version and architecture so builds from
different SDKs can be downloaded together without filename collisions.

Each push stamps `PKG_RELEASE` with the GitHub run number so artifacts from newer commits can be installed as upgrades.

Download artifacts from the latest GitHub Actions run:

```text
https://github.com/Jasper344612/luci-app-xray-simple/actions
```

## Local Checks

From this repository:

```sh
find root/www/luci-static/resources/view/xray-simple -name '*.js' -exec node --check {} \;
sh -n root/etc/init.d/xray_simple
sh -n root/etc/uci-defaults/xray_simple
jq . root/usr/share/rpcd/acl.d/luci-app-xray-simple.json
msgfmt --check-format -o /tmp/xray-simple.mo po/zh_Hans/xray-simple.po
bash tests/test-init.sh
```

## License

This project is licensed under the Mozilla Public License Version 2.0. See [LICENSE](LICENSE).

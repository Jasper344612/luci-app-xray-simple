# luci-app-xray-simple

[English](README.md) | [简体中文](README.zh-CN.md)

用于在 OpenWrt / ImmortalWrt 上运行 Xray 透明代理的轻量 LuCI 应用。

本应用以用户维护的 Xray 配置为主：用户可以编辑和切换完整 JSON 配置，LuCI 仅管理进程、nftables/firewall4 规则、策略路由以及少量常用安全设置。

## 功能

- 系统设置、进程管理和运行日志三个 LuCI 标签页。
- 管理多个 JSON 配置，并可一键切换和重启。
- 导入、导出配置 JSON。
- 支持通过 `firewall4` include 或直接 `nft` 两种模式加载 TProxy 规则。
- 支持选择 LAN 接口、绕过 IPv4/IPv6 CIDR、UID/GID、策略标记和路由表。
- 查看 nftables 状态和生成的规则。
- LuCI 始终提供 Xray 运行日志，并可选择是否同时写入 OpenWrt 系统日志。
- 私有运行日志路径可以自定义，默认为 `/var/etc/xray-simple/xray.log`。
- 可将 dnsmasq 作为 DNS 前端，并使用本地 Xray DNS 入站作为上游。
- 提醒安装 `geoip.dat` 和 `geosite.dat`。
- 提供可选中文语言包 `luci-app-xray-simple-zh`。

## 运行依赖

安装 OpenWrt 提供的运行依赖：

```sh
opkg install luci-base firewall4 ip-full kmod-nft-tproxy
```

本软件包不再依赖 Xray Core，因为 Xray Core 更新频繁。请自行安装所需版本，或将具有执行权限的 Xray 二进制文件放到 **系统设置 -> Xray 程序路径** 指定的位置。默认路径为 `/usr/bin/xray`。

OpenWrt 25.12 使用 `apk`，其运行依赖安装命令为：

```sh
apk add luci-base firewall4 ip-full kmod-nft-tproxy
```

如果 Xray JSON 使用了 `geoip:` 或 `geosite:` 规则，还需要安装 Geo 数据库：

```sh
opkg update
opkg install v2ray-geoip v2ray-geosite
```

默认 Xray 资源目录为 `/usr/share/xray`。启动 Xray 时，`xray_simple` 会将 `XRAY_LOCATION_ASSET` 设置为该目录。可在 **系统设置 -> Xray 资源目录** 中修改。

## 安装与升级

可直接安装或覆盖升级生成的软件包，无需先卸载旧版本：

```sh
opkg install ./luci-app-xray-simple_*.ipk
```

OpenWrt 25.12 使用：

```sh
apk add --allow-untrusted ./luci-app-xray-simple-*.apk
```

安装中文语言包：

```sh
opkg install ./luci-app-xray-simple-zh_*.ipk
```

OpenWrt 25.12 请安装对应的 `luci-app-xray-simple-zh-*.apk` 构建产物。

安装后打开 **LuCI -> 服务 -> Xray Simple**。安装脚本会重载 `rpcd` 并清理 LuCI 缓存。

LuCI 的“保存并应用”只提交 UCI 设置，不会重启 Xray 或 firewall4。修改运行参数后，请使用进程管理页中的 **重启** 或 TProxy 控制按钮。这样可以避免 firewall4 重启导致 LuCI 的应用确认操作超时。

## Xray JSON 注意事项

每个 Xray 出站都必须将 `streamSettings.sockopt.mark` 设置为系统设置中的 **Xray 出站绕过标记**，默认值为 `255`：

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

缺少此标记时，Xray 的出站流量可能会再次被 TProxy 捕获并形成回环。默认配置包含一个监听 `12345` 端口的本地 `dokodemo-door` TProxy 入站。

## TProxy 行为

默认参数：

- TProxy 监听端口：`12345`
- 策略路由标记：`1`
- Xray 出站绕过标记：`255`
- IPv4 路由表：`100`
- IPv6 路由表：`106`
- LAN 接口：`br-lan`

规则会绕过 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` 和 IPv6 ULA `fc00::/7`，并绕过 IPv4 link-local、IPv6 link-local 和 IPv6 multicast 目的地址。

必须至少配置一个有效 LAN 接口；接口列表为空时不会退化为拦截所有入站接口。启用 **代理 LAN DNS UDP/53** 后，来自 LAN 的 UDP/53 流量会在私有地址绕过规则之前被捕获。DNS 专用规则不会捕获 TCP/53。

### dnsmasq 上游模式

启用 **使用 dnsmasq 作为 Xray DNS 前端** 后，Xray Simple 会：

- 将 LAN UDP/53 重定向到路由器上的 dnsmasq；
- 关闭 UDP/53 直接进入 TProxy 的例外规则；
- 生成仅在运行期间有效的 dnsmasq 配置片段，将 `127.0.0.1:5353`（或用户配置的端口）设为上游；
- 在 Xray 停止或启动失败时删除该片段并重启 dnsmasq，恢复原有上游。

当前 Xray JSON 必须包含一个绑定到 `127.0.0.1` 对应端口的 DNS 入站。Xray Simple 不会修改用户的 JSON。临时配置写入每个活动 dnsmasq 实例的 conf-dir，不会修改 `/etc/config/dhcp`。

系统设置页会显示 dnsmasq 上游的实时激活状态。点击 **配置** 按钮可进入独立的 dnsmasq 设置子页面。

## 规则加载模式

### firewall4 include

默认模式。服务生成：

```text
/var/etc/xray-simple/fw4/01_xray_simple.nft
```

并通过以下 firewall4 table-pre include 加载：

```text
/usr/share/nftables.d/table-pre/xray_simple.nft
```

firewall4 重启时会加载生成的规则链。

### direct nft load

直接模式生成并加载独立 nftables 表：

```text
/var/etc/xray-simple/direct_xray_simple.nft
table inet xray_simple
```

仅在希望 `xray_simple` 脱离 firewall4、独立管理 nftables 表时使用此模式。

## 常用命令

```sh
/etc/init.d/xray_simple start
/etc/init.d/xray_simple stop
/etc/init.d/xray_simple restart
/etc/init.d/xray_simple status
/etc/init.d/xray_simple nft_status
/etc/init.d/xray_simple geodata_status
/etc/init.d/xray_simple recent_xray_logs
```

仅启动或停止 TProxy 规则和策略路由：

```sh
/etc/init.d/xray_simple start_tproxy
/etc/init.d/xray_simple stop_tproxy
```

导出当前配置：

```sh
/etc/init.d/xray_simple export_profile
```

## GitHub 构建

所有分支和标签的每次 push 都会自动运行 GitHub Actions。Pull Request 也会触发构建，还可以在 Actions 页面通过 `workflow_dispatch` 手动运行。

工作流使用 OpenWrt 23.05.5 和 25.12.5 SDK 构建以下架构的软件包：

- `x86_64`
- `armv8a`

OpenWrt 23.05 构建产物为 `.ipk`，OpenWrt 25.12 构建产物为 `.apk`。产物名称包含 OpenWrt 版本和架构，多个 SDK 生成的文件不会相互覆盖。

每次 push 都使用 GitHub run number 更新 `PKG_RELEASE`，因此较新提交生成的软件包可以直接覆盖升级。构建产物可从 [GitHub Actions](https://github.com/Jasper344612/luci-app-xray-simple/actions) 下载。

## 本地检查

```sh
find root/www/luci-static/resources/view/xray-simple -name '*.js' -exec node --check {} \;
sh -n root/etc/init.d/xray_simple
sh -n root/etc/uci-defaults/xray_simple
jq . root/usr/share/rpcd/acl.d/luci-app-xray-simple.json
msgfmt --check-format -o /tmp/xray-simple.mo po/zh_Hans/xray-simple.po
bash tests/test-init.sh
```

## 许可证

本项目使用 Mozilla Public License Version 2.0，详见 [LICENSE](LICENSE)。

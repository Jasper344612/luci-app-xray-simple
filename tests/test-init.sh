#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
runtime_dir="$(mktemp -d)"
trap 'rc=$?; rm -rf "$runtime_dir"; exit "$rc"' EXIT

extra_command() { :; }
# shellcheck source=/dev/null
. "$repo_dir/root/etc/init.d/xray_simple"

RUNDIR="$runtime_dir"
NFT_FILE="$RUNDIR/fw4/01_xray_simple.nft"
ROUTE_LOG="$RUNDIR/route.log"
ROUTE_STATE="$RUNDIR/route.state"
ASYNC_STATUS="$RUNDIR/last_command.status"
ASYNC_LOG="$RUNDIR/last_command.log"
ASYNC_LOCK="$RUNDIR/command.lock"
DNSMASQ_STATE="$RUNDIR/dnsmasq-fragments"
DNSMASQ_CONFIG_GLOB="$RUNDIR/generated-dnsmasq.conf.*"
DNSMASQ_RUNTIME_GLOB="$RUNDIR/dnsmasq*.d"
DNSMASQ_INIT=/usr/bin/true

cfg_mode=direct
cfg_lan=br-lan
cfg_mark=1
cfg_outbound_mark=255
cfg_dnsmasq=0
cfg_dnsmasq_port=5353

uci_get() {
	case "$1" in
		nft_mode) echo "$cfg_mode" ;;
		tproxy_port) echo 12345 ;;
		mark) echo "$cfg_mark" ;;
		outbound_mark) echo "$cfg_outbound_mark" ;;
		route_table_v4) echo 100 ;;
		route_table_v6) echo 106 ;;
		proxy_lan_dns) echo 1 ;;
		dnsmasq_upstream) echo "$cfg_dnsmasq" ;;
		dnsmasq_xray_port) echo "$cfg_dnsmasq_port" ;;
		proxy_router_output) echo 1 ;;
		*) echo "${2:-}" ;;
	esac
}

uci_list() {
	case "$1" in
		lan_ifaces) echo "$cfg_lan" ;;
		bypass_ipv4) echo "8.8.8.0/24" ;;
		bypass_ipv6) echo "2001:db8::/32" ;;
		bypass_uids) echo "0 65534" ;;
		bypass_gids) echo "1000" ;;
	esac
}

write_nft
direct_rules="$RUNDIR/direct_xray_simple.nft"
grep -Fq 'table inet xray_simple' "$direct_rules"
grep -Fq 'iifname { "br-lan" } meta l4proto { tcp, udp }' "$direct_rules"
grep -Fq 'ip daddr { 10.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } udp dport != 53 return' "$direct_rules"
grep -Fq 'ip6 daddr { ::1/128, fe80::/10, ff00::/8 } return' "$direct_rules"
if grep -Fq 'tcp dport != 53' "$direct_rules"; then
	echo 'TCP/53 must not receive the DNS-specific exception' >&2
	exit 1
fi

cfg_dnsmasq=1
write_nft
grep -Fq 'chain xray_simple_dns_prerouting' "$direct_rules"
grep -Fq 'iifname { "br-lan" } udp dport 53 redirect to :53' "$direct_rules"
if grep -Fq 'udp dport != 53' "$direct_rules"; then
	echo 'dnsmasq mode unexpectedly retained direct UDP/53 TProxy rules' >&2
	exit 1
fi

dnsmasq_dir="$RUNDIR/dnsmasq.test.d"
mkdir -p "$dnsmasq_dir"
printf 'conf-dir=%s\n' "$dnsmasq_dir" >"$RUNDIR/generated-dnsmasq.conf.test"
setup_dnsmasq_upstream
grep -Fq 'no-resolv' "$dnsmasq_dir/$DNSMASQ_FRAGMENT"
grep -Fq 'server=127.0.0.1#5353' "$dnsmasq_dir/$DNSMASQ_FRAGMENT"
xray_pids() { echo 12345; }
dnsmasq_status >"$RUNDIR/dnsmasq-status-active.out"
grep -Fq 'status: active' "$RUNDIR/dnsmasq-status-active.out"
restore_dnsmasq_upstream
test ! -e "$dnsmasq_dir/$DNSMASQ_FRAGMENT"
dnsmasq_status >"$RUNDIR/dnsmasq-status-inactive.out"
grep -Fq 'status: inactive' "$RUNDIR/dnsmasq-status-inactive.out"
cfg_dnsmasq_port=53
if validate_settings >"$RUNDIR/dnsmasq-port.out" 2>&1; then
	echo 'dnsmasq port conflict validation unexpectedly succeeded' >&2
	exit 1
fi
grep -Fq 'conflicts with dnsmasq' "$RUNDIR/dnsmasq-port.out"
cfg_dnsmasq_port=5353
cfg_dnsmasq=0

cfg_mode=firewall4
write_nft
fw4_rules="$RUNDIR/fw4/01_xray_simple.nft"
if grep -Fq 'table inet xray_simple' "$fw4_rules"; then
	echo 'firewall4 include must not define a second inet table' >&2
	exit 1
fi
grep -Fq 'chain xray_simple_prerouting' "$fw4_rules"

cfg_lan=''
if write_nft >"$RUNDIR/empty-lan.out" 2>&1; then
	echo 'empty LAN interface validation unexpectedly succeeded' >&2
	exit 1
fi
grep -Fq 'at least one LAN interface is required' "$RUNDIR/empty-lan.out"

cfg_lan='br-lan;drop'
if write_nft >"$RUNDIR/bad-interface.out" 2>&1; then
	echo 'unsafe interface name validation unexpectedly succeeded' >&2
	exit 1
fi
grep -Fq 'invalid LAN interface name' "$RUNDIR/bad-interface.out"

cfg_lan=br-lan
cfg_outbound_mark=1
if write_nft >"$RUNDIR/equal-marks.out" 2>&1; then
	echo 'equal policy and outbound marks unexpectedly succeeded' >&2
	exit 1
fi
grep -Fq 'must be different' "$RUNDIR/equal-marks.out"

valid_route_table 100
for table in 0 253 254 255; do
	if valid_route_table "$table"; then
		echo "reserved route table $table unexpectedly succeeded" >&2
		exit 1
	fi
done

ip_calls="$RUNDIR/ip.calls"
ip() {
	printf '%s\n' "$*" >>"$ip_calls"
	case "$*" in
		*'rule del'*) return 1 ;;
	esac
	return 0
}
printf '9 109 119\n' >"$ROUTE_STATE"
flush_routes
grep -Fq 'rule del fwmark 9 table 109' "$ip_calls"
grep -Fq -- '-6 route del local ::/0 dev lo table 119' "$ip_calls"
setup_routes
test "$(cat "$ROUTE_STATE")" = '1 100 106'

start_now() {
	sleep 0.2
	echo started
}
run_async start_now >/dev/null
if run_async stop_now >"$RUNDIR/concurrent.out" 2>&1; then
	echo 'concurrent async command unexpectedly succeeded' >&2
	exit 1
fi
grep -Fq 'another Xray Simple command is still running' "$RUNDIR/concurrent.out"
for _ in $(seq 1 20); do
	grep -Fq 'exit=0 command=start_now' "$ASYNC_STATUS" && break
	sleep 0.05
done
grep -Fq 'exit=0 command=start_now' "$ASYNC_STATUS"
for _ in $(seq 1 20); do
	[ ! -e "$ASYNC_LOCK" ] && break
	sleep 0.05
done
test ! -e "$ASYNC_LOCK"

pid_state="$RUNDIR/xray-pid-state"
xray_pids() {
	local remaining
	remaining="$(cat "$pid_state")"
	if [ "$remaining" -gt 0 ]; then
		echo 4242
		echo $((remaining - 1)) >"$pid_state"
	fi
}
echo 1 >"$pid_state"
wait_for_xray_exit 2
test "$(cat "$pid_state")" = 0

kill_calls="$RUNDIR/kill.calls"
kill() {
	printf '%s\n' "$*" >>"$kill_calls"
	echo 0 >"$pid_state"
}
echo 2 >"$pid_state"
terminate_xray_processes
grep -Fq '4242' "$kill_calls"

reload_order="$RUNDIR/reload.order"
stop() { echo stop >>"$reload_order"; }
start() { echo start >>"$reload_order"; }
echo 0 >"$pid_state"
reload_service
test "$(sed -n '1p' "$reload_order")" = stop
test "$(sed -n '2p' "$reload_order")" = start

echo 'init script regression tests: OK'

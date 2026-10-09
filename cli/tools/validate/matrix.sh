#!/usr/bin/env bash
# WaveKit CLI validation (spec §13.4): tmux capture matrix, resize, transitions,
# Esc handling, sustained flow and cost.
#
# Talks ONLY to the local mock core (cli/source/test/mock-api/server.ts), started
# here on a free loopback port and verified through a mock-only route before any
# key is sent. Never point it at a live core.
#
# Usage: cli/tools/validate/matrix.sh [all|matrix|resize|transitions|esc|perf]
# Env:   WAVEKIT_VALIDATE_OUT   capture dir (default $TMPDIR/wavekit-cli-validate)
#        WAVEKIT_MOCK_PORT      mock port (default: a free port)
#        WAVEKIT_VALIDATE_SKIP_BUILD=1  use the existing cli/dist build
#        WAVEKIT_VALIDATE_SCENARIOS / WAVEKIT_VALIDATE_SIZES  space-separated matrix subsets
#        WAVEKIT_VALIDATE_PERF_SECONDS  length of each perf run (default 60, the spec's budget window)
#        WAVEKIT_VALIDATE_IDLE_SECONDS  length of the idle run (default 100, the R87 heap window)
# tmux runs on a private socket (-L) so other tmux sessions are never touched;
# the socket's server and the mock are killed on exit, INT and TERM.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${WAVEKIT_VALIDATE_OUT:-${TMPDIR:-/tmp}/wavekit-cli-validate}"
MODE="${1:-all}"
SOCK="wkv-$$"
SOCK_PATH="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SOCK"
PERF_SECONDS="${WAVEKIT_VALIDATE_PERF_SECONDS:-60}"
PERF_WARMUP_S="${WAVEKIT_VALIDATE_PERF_WARMUP:-15}"
SESSION="wkv"
SCENARIOS=(live idle api-down api-down-cached ws-only rest-only dropping crash-loop legacy long-text burst iq-stale iq-disconnected decoder-faulted contracts tuner-unknown)
VIEWS=(overview decoders messages receiver system)
SIZES=(60x16 60x20 80x24 120x40 200x50)
# Optional subsets for quick runs, e.g. WAVEKIT_VALIDATE_SCENARIOS="live burst" WAVEKIT_VALIDATE_SIZES="80x24"
if [ -n "${WAVEKIT_VALIDATE_SCENARIOS:-}" ]; then read -r -a SCENARIOS <<<"$WAVEKIT_VALIDATE_SCENARIOS"; fi
if [ -n "${WAVEKIT_VALIDATE_SIZES:-}" ]; then read -r -a SIZES <<<"$WAVEKIT_VALIDATE_SIZES"; fi
FAILS=0

case "$MODE" in
	all | matrix | resize | transitions | esc | perf) ;;
	*)
		echo "usage: $0 [all|matrix|resize|transitions|esc|perf]" >&2
		exit 2
		;;
esac

need() { command -v "$1" >/dev/null 2>&1 || {
	echo "missing tool: $1" >&2
	exit 1
}; }
need tmux
need node
need curl
need perl
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' ||
	{
		echo "node >= 22.18 required for type stripping (have $(node --version))" >&2
		exit 1
	}

free_port() { node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'; }
PORT="${WAVEKIT_MOCK_PORT:-$(free_port)}"
if [ "$PORT" = "9000" ] || [ "$PORT" = "4713" ]; then
	echo "refusing port $PORT: that is where a real core or relay listens" >&2
	exit 2
fi
API="http://127.0.0.1:${PORT}"

mkdir -p "$OUT"
CHECK="$OUT/check-capture.mjs"
# Width and banned-copy rules come from the built CLI (cli/dist/ui/text.js and
# copy-rules.js), so the script can never drift from what the views enforce.
cat >"$CHECK" <<JS
// usage: node check-capture.mjs <file> <cols> <rows>
import { readFileSync } from "node:fs"
import { cellWidth } from "$ROOT/cli/dist/ui/text.js"
import { findBanned } from "$ROOT/cli/dist/ui/copy-rules.js"
const [file, cols, rows] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])]
const lines = readFileSync(file, "utf8").replace(/\n\$/, "").split("\n")
const errs = []
lines.forEach((l, i) => {
	const w = cellWidth(l)
	if (w > cols) errs.push(\`line \${i + 1} is \${w} wide (> \${cols})\`)
	for (const id of findBanned(l)) errs.push(\`line \${i + 1} has banned copy "\${id}"\`)
})
const used = lines.length - [...lines].reverse().findIndex(l => l.trim() !== "")
if (!lines.some(l => l.trim() !== "")) errs.push("empty frame")
else if (used > rows - 1) errs.push(\`frame uses \${used} rows (> \${rows - 1})\`)
if (errs.length) {
	console.error(\`FAIL \${file}\n  \${errs.join("\n  ")}\`)
	process.exit(1)
}
JS

ms() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
tm() { LC_ALL=en_US.UTF-8 tmux -u -L "$SOCK" "$@"; }
mock() { curl -fsS --max-time 5 -X POST -H 'content-type: application/json' -d "$2" "$API/__mock/$1" >/dev/null; }
capture() {
	tm capture-pane -p -t "$SESSION" >"$1.txt"
	tm capture-pane -p -e -t "$SESSION" >"$1.ansi"
}
check() { node "$CHECK" "$1.txt" "$2" "$3" || FAILS=$((FAILS + 1)); }
fail() {
	echo "FAIL $*" >&2
	FAILS=$((FAILS + 1))
}
key() {
	tm send-keys -t "$SESSION" "$@"
	sleep 0.6
}
# Waits (max 5 s) until the pane shows something, then lets data settle.
wait_frame() {
	local tries=0
	until [ -n "$(tm capture-pane -p -t "$SESSION" | tr -d '[:space:]')" ] || [ "$tries" -ge 50 ]; do
		sleep 0.1
		tries=$((tries + 1))
	done
	sleep "${1:-1.5}"
}
start_cli() { # cols rows view [node flags] [env assignments]
	tm kill-session -t "$SESSION" 2>/dev/null || true
	tm new-session -d -s "$SESSION" -x "$1" -y "$2" \
		"exec env -u WAVEKIT_WS_URL -u WAVEKIT_WS_URLS -u WAVEKIT_API_URL -u NO_COLOR -u WAVEKIT_ASCII LC_ALL=en_US.UTF-8 ${5:-} node ${4:-} '$ROOT/cli/dist/cli.js' --api '$API' --view '$3'"
	wait_frame
}
cli_pid() { tm list-panes -t "$SESSION" -F '#{pane_pid}' | head -1; }

MOCK_PID=""
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
	tm kill-server 2>/dev/null || true
	rm -f "$SOCK_PATH"
	if [ -n "$MOCK_PID" ]; then
		kill "$MOCK_PID" 2>/dev/null || true
		wait "$MOCK_PID" 2>/dev/null || true
	fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "${WAVEKIT_VALIDATE_SKIP_BUILD:-}" != "1" ]; then
	(cd "$ROOT" && pnpm --filter @wavekit/cli build >/dev/null)
fi
# Never adopt a foreign server: the port must be empty before our mock starts, and
# readiness is our own mock's listening line, not any answer on the port.
if curl -s --max-time 1 "$API/" >/dev/null 2>&1; then
	echo "port $PORT already answers; refusing to use it (set WAVEKIT_MOCK_PORT)" >&2
	exit 1
fi
node "$ROOT/cli/source/test/mock-api/server.ts" --port "$PORT" --scenario live >"$OUT/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 100); do
	grep -q "wavekit mock core on $API " "$OUT/mock.log" 2>/dev/null && break
	kill -0 "$MOCK_PID" 2>/dev/null || break
	sleep 0.1
done
grep -q "wavekit mock core on $API " "$OUT/mock.log" 2>/dev/null || {
	echo "our mock core did not start on $API, see $OUT/mock.log" >&2
	exit 1
}
# Still ours and alive; /__mock/calls exists only on the mock.
kill -0 "$MOCK_PID" 2>/dev/null || {
	echo "mock core exited (port $PORT taken?), see $OUT/mock.log" >&2
	exit 1
}
curl -fsS --max-time 2 "$API/__mock/calls" | grep -q '^\[' || {
	echo "no mock core on $API (see $OUT/mock.log)" >&2
	exit 1
}

# Loads a scenario. Cached failure states need a CLI that saw data first, so the
# mock serves them healthy until `degrade` applies the scenario's failure modes.
load() {
	case "$1" in
		# Same REST data as live; loading live keeps the WS replay on for the warm-up.
		api-down-cached | ws-only | rest-only) mock scenario '{"name":"live"}' ;;
		*) mock scenario "{\"name\":\"$1\"}" ;;
	esac
}
degrade() {
	case "$1" in
		api-down-cached)
			mock rest '{"mode":"fail"}'
			mock ws '{"mode":"drop"}'
			;;
		ws-only) mock rest '{"mode":"hang"}' ;;
		rest-only) mock ws '{"mode":"drop"}' ;;
		*) return 0 ;;
	esac
	sleep 3
}

run_matrix() {
	local sc size cols rows view i f
	for sc in "${SCENARIOS[@]}"; do
		for size in "${SIZES[@]}"; do
			cols="${size%x*}"
			rows="${size#*x}"
			load "$sc"
			start_cli "$cols" "$rows" overview
			degrade "$sc"
			i=0
			for view in "${VIEWS[@]}"; do
				i=$((i + 1))
				key "$i"
				f="$OUT/matrix-$sc-$view-$size"
				capture "$f"
				check "$f" "$cols" "$rows"
			done
		done
	done
	load live
}

run_resize() {
	local i=0 size cols rows
	load live
	start_cli 120 40 overview
	for size in 120x40 60x20 200x50 80x24 59x15 120x40; do
		cols="${size%x*}"
		rows="${size#*x}"
		i=$((i + 1))
		tm resize-window -t "$SESSION" -x "$cols" -y "$rows"
		sleep 0.3
		capture "$OUT/resize-$i-$size-0.3s"
		sleep 1.7
		capture "$OUT/resize-$i-$size-2s"
		if [ "$size" = "59x15" ]; then
			grep -Eq "too small \((minimum|min) 60×16\)" "$OUT/resize-$i-$size-2s.txt" || fail "resize: no too-small line at 59x15"
		else
			check "$OUT/resize-$i-$size-2s" "$cols" "$rows"
		fi
	done
}

# Drop cells (R38, spec §10.6): drop now stays computed while either the WS or
# REST fanout feed is fresh; it becomes "?" only after 15 s with neither.
DROP_NUM='drops? !?[<>]?[0-9]+%'
DROP_UNKNOWN='drops? \?'
drops_numeric() { grep -Eq "$DROP_NUM" "$1.txt"; }
drops_unknown() { grep -Eq "$DROP_UNKNOWN" "$1.txt"; }
# SGR sequences that switch on dim (parameter 2) in an -e capture.
dim_count() { perl -ne 'while (/\e\[([0-9;]*)m/g) { $n++ if grep { $_ eq "2" } split /;/, $1 } END { print $n + 0 }' "$1.ansi"; }

# shellcheck disable=SC2329 # called through await
gap_closed() { grep -q "not replayed" "$1.txt" && ! grep -q "gap since" "$1.txt"; }
# Captures $1 every second until "$3 $1" holds or $2 seconds pass; logs how long it took.
await() {
	local base="$1" limit="$2" t=0
	shift 2
	while :; do
		capture "$base"
		if "$@" "$base"; then
			echo "ok   ${base##*/}: after ${t}s" >>"$OUT/timings.txt"
			return 0
		fi
		if [ "$t" -ge "$limit" ]; then
			echo "miss ${base##*/}: not within ${limit}s" >>"$OUT/timings.txt"
			return 1
		fi
		sleep 1
		t=$((t + 1))
	done
}
# The ws client's backoff (1, 2, 4, 8, 15 s, ±20 %) decides when a socket comes back:
# up to 18 s, plus two fanout snapshots for drop now.
WS_BACK_S=22

run_transitions() {
	local t="$OUT/transition"
	load live
	start_cli 120 40 overview
	sleep 3 # two fanout snapshots >= 2 s apart
	capture "$t-0-live"
	drops_numeric "$t-0-live" || fail "transitions: live drop cells are not numeric"
	# 1. WS drop, REST fresh: the gap opens, drop now keeps coming from REST fanout polls.
	mock ws '{"mode":"drop"}'
	sleep 2
	capture "$t-1-ws-drop-2s"
	sleep 14
	capture "$t-1-ws-drop-16s"
	grep -q "gap since" "$t-1-ws-drop-16s.txt" || fail "transitions: no open gap after ws drop"
	drops_numeric "$t-1-ws-drop-16s" || fail "transitions: drop cells not numeric 16 s after ws drop with REST fresh"
	if drops_unknown "$t-1-ws-drop-16s"; then fail "transitions: drop cells went ? while REST fanout was fresh"; fi
	# 2. WS up: once the client's backoff retries, the gap closes and drop cells are
	#    numeric again within two snapshots.
	mock ws '{"mode":"up"}'
	await "$t-2-ws-up" "$WS_BACK_S" gap_closed || fail "transitions: gap did not close within ${WS_BACK_S}s of ws up"
	await "$t-2-ws-up" 3 drops_numeric || fail "transitions: drop cells not numeric after ws up"
	# 3. REST hang, WS live: banner, REST-fed cells dimmed (spec §13.4); WS keeps drops numeric.
	mock rest '{"mode":"hang"}'
	sleep 20
	capture "$t-3-rest-hang"
	grep -q "REST failing" "$t-3-rest-hang.txt" || fail "transitions: no REST banner"
	# Compared with the nearest healthy capture (t-2, WS just back, REST fresh).
	[ "$(dim_count "$t-3-rest-hang")" -gt "$(dim_count "$t-2-ws-up")" ] || fail "transitions: no REST-fed cell dimmed under rest hang"
	drops_numeric "$t-3-rest-hang" || fail "transitions: drop cells not numeric under rest hang with WS live"
	# 4. REST back: the banner clears.
	mock rest '{"mode":"ok"}'
	sleep 8
	capture "$t-4-rest-ok"
	if grep -q "REST failing" "$t-4-rest-ok.txt"; then fail "transitions: REST banner still shown after recovery"; fi
	# 5. WS and REST both stale for more than 15 s: drop now is unknown.
	mock ws '{"mode":"drop"}'
	mock rest '{"mode":"hang"}'
	sleep 20
	capture "$t-5-both-stale"
	drops_unknown "$t-5-both-stale" || fail "transitions: drop cells not ? after 20 s without any fanout sample"
	# 6. WS alone back (REST still hanging): WS fanout snapshots alone make drop now
	#    numeric again within two snapshots (about 3 s).
	mock ws '{"mode":"up"}'
	await "$t-6-ws-only-recovered" "$WS_BACK_S" drops_numeric || fail "transitions: drop cells not numeric within backoff + 2 WS snapshots, REST still down"
	# 7. REST back too: banner gone, still numeric.
	mock rest '{"mode":"ok"}'
	sleep 8
	capture "$t-7-recovered"
	drops_numeric "$t-7-recovered" || fail "transitions: drop cells not numeric after recovery"
	if grep -q "REST failing" "$t-7-recovered.txt"; then fail "transitions: REST banner still shown after full recovery"; fi
	return 0
}

# R12: Esc must close the decoder detail. A detail-only label pins that the detail
# was open before Esc, so a detail that never opened cannot pass.
# tmux's escape-time applies only to keys typed into an attached client, never to
# send-keys, so it cannot be exercised here. Instead, case "esc+down" writes ESC
# and the next key's sequence in one send-keys call (one PTY write), the Esc/Alt
# ambiguity an app sees when keys arrive together. ESC split across reads is
# covered by the Ink harness test (T45).
DETAIL_ONLY="branch decoder-|server health"
run_esc() {
	local c before after
	load live
	for c in lone esc+down; do
		start_cli 120 40 decoders
		key Down
		key Enter
		capture "$OUT/esc-$c-open"
		before=$(grep -Ec "$DETAIL_ONLY" "$OUT/esc-$c-open.txt" || true)
		if [ "$c" = "lone" ]; then key Escape; else key Escape Down; fi
		capture "$OUT/esc-$c-closed"
		after=$(grep -Ec "$DETAIL_ONLY" "$OUT/esc-$c-closed.txt" || true)
		[ "$before" -gt 0 ] || fail "esc ($c): detail did not open"
		if [ "$after" -ne 0 ]; then
			if [ "$c" = "lone" ]; then
				fail "esc ($c): Esc did not close the detail"
			else
				# Ink reads ESC and the next key in one read as Alt+key; recorded, not failed.
				echo "esc+down in one write: read as Alt+Down, detail stays open" >>"$OUT/findings.txt"
			fi
		fi
	done
}

# Timestamps every PTY read; a frame is a burst of writes separated by > 20 ms (R39).
TAP="$OUT/tap.pl"
cat >"$TAP" <<'PL'
use strict;
use warnings;
use Time::HiRes qw(time);
my ($raw, $times) = @ARGV;
open(my $r, '>>', $raw) or die "$raw: $!";
open(my $t, '>>', $times) or die "$times: $!";
binmode STDIN;
binmode $r;
$r->autoflush(1);
$t->autoflush(1);
my $buf;
while (my $n = sysread(STDIN, $buf, 65536)) {
	print $r $buf;
	printf $t "%.4f %d\n", time, $n;
}
PL

# R87 heap budget: retained heap (heapUsed right after a forced GC), logged every 5 s.
# Only the idle run loads it: forced GCs would flatter the RSS of the burst runs.
HEAPLOG="$OUT/heaplog.mjs"
cat >"$HEAPLOG" <<'JS'
import { appendFileSync } from "node:fs"
const file = process.env["WK_HEAPLOG"]
if (file && typeof globalThis.gc === "function") {
	const t0 = Date.now()
	setInterval(() => {
		globalThis.gc()
		const m = process.memoryUsage()
		appendFileSync(file, `${Date.now() - t0} ${(m.heapUsed / 1048576).toFixed(1)} ${(m.rss / 1048576).toFixed(0)}\n`)
	}, 5000).unref()
}
JS
loadavg() { sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}' || uptime | awk -F'load averages?: ' '{print $2}' | awk '{print $1}'; }

perf_run() { # name view burstPerSecond pause seconds heap
	local name="$1" view="$2" rate="$3" pause="$4" secs="${5:-$PERF_SECONDS}" heap="${6:-no}"
	local log="$OUT/perf-$1.tty" samples="$OUT/perf-$1.samples" heapf="$OUT/perf-$1.heap"
	: >"$log"
	: >"$log.times"
	: >"$samples"
	: >"$heapf"
	load live
	if [ "$heap" = "yes" ]; then
		start_cli 120 40 "$view" "--expose-gc --import '$HEAPLOG'" "WK_HEAPLOG='$heapf'"
	else
		start_cli 120 40 "$view"
	fi
	# Startup heap growth is not a leak: sample after a warm-up (reported in perf.md).
	sleep "$PERF_WARMUP_S"
	if [ "$pause" = "yes" ]; then key p; fi
	local w0 w1
	w0="$(ms)"
	tm pipe-pane -o -t "$SESSION" "perl '$TAP' '$log' '$log.times'"
	if [ "$rate" -gt 0 ]; then mock burst "{\"perSecond\":$rate,\"seconds\":$secs}"; fi
	local pid load0 load1
	pid="$(cli_pid)"
	load0="$(loadavg)"
	for _ in $(seq 1 "$secs"); do
		ps -o %cpu=,rss= -p "$pid" >>"$samples" || true
		sleep 1
	done
	w1="$(ms)"
	load1="$(loadavg)"
	# R3: key 4 opens Receiver; FANOUT appears on no other view.
	local t0 tries=0
	t0="$(ms)"
	tm send-keys -t "$SESSION" 4
	until tm capture-pane -p -t "$SESSION" | grep -q "FANOUT" || [ "$tries" -ge 200 ]; do
		sleep 0.05
		tries=$((tries + 1))
	done
	local latency="$(($(ms) - t0)) ms"
	if [ "$tries" -ge 200 ]; then
		latency="timeout (10 s)"
		fail "perf $name: no Receiver frame within 10 s of key 4"
	fi
	tm pipe-pane -t "$SESSION"
	sleep 0.3
	local frames clears cpu rss0 rss1 rssmax heapgrow window
	# Bursts before the key press, over the measured window (not the nominal one).
	frames=$(awk -v end="$w1" '$1 * 1000 <= end { if (n == 0 || $1 - prev > 0.020) n++; prev = $1 } END { print n + 0 }' "$log.times")
	window=$(awk -v a="$w0" -v b="$w1" 'BEGIN { printf "%.1f", (b - a) / 1000 }')
	# grep exits 1 on no match; pipefail would abort the run, so count with grep -c over -o lines.
	clears=$(grep -o $'\x1b\\[2J' "$log" | grep -c . || true)
	cpu=$(awk '{s+=$1} END {printf "%.1f", (NR ? s/NR : 0)}' "$samples")
	rss0=$(head -1 "$samples" | awk '{print $2}')
	rss1=$(tail -1 "$samples" | awk '{print $2}')
	rssmax=$(awk '$2 > m {m = $2} END {print int(m / 1024)}' "$samples")
	# Retained heap: last post-GC sample minus the first one inside the window.
	heapgrow=$(awk -v from="$((PERF_WARMUP_S * 1000))" '$1 >= from { if (!n++) h0 = $2; h1 = $2 } END {if (n >= 2) printf "%+.1f MB (%.1f → %.1f)", h1 - h0, h0, h1; else print "—"}' "$heapf")
	printf '| %s | %s–%s | %s | %s | %s %% | %s MB | %s MB | %s | %s | %s s |\n' "$name" "$load0" "$load1" \
		"$(awk -v f="$frames" -v s="$window" 'BEGIN {printf "%.1f", (s > 0 ? f / s : 0)}')" "$clears" "$cpu" \
		"$(((${rss1:-0} - ${rss0:-0}) / 1024))" "$rssmax" "$heapgrow" "$latency" "$window" >>"$OUT/perf.md"
}

run_perf() {
	printf 'Sampled at 120x40 after a %s s warm-up; load is the 1-min average at the start and end of the window.\n\n' "$PERF_WARMUP_S" >"$OUT/perf.md"
	printf '| run | load | frames/s | ESC[2J | CPU avg | RSS growth | RSS max | retained heap | key→frame | window |\n|---|---|---|---|---|---|---|---|---|---|\n' >>"$OUT/perf.md"
	# CPU is judged without forced GCs; R87's retained-heap growth over 100 s idle has
	# its own run (a forced GC every 5 s, which costs CPU of its own).
	perf_run idle-live overview 0 no
	perf_run idle-heap overview 0 no "${WAVEKIT_VALIDATE_IDLE_SECONDS:-100}" yes
	perf_run burst-50 overview 50 no
	perf_run burst-500 messages 500 no
	perf_run burst-500-paused messages 500 yes
	cat "$OUT/perf.md"
}

case "$MODE" in
	all)
		run_matrix
		run_resize
		run_transitions
		run_esc
		run_perf
		;;
	matrix) run_matrix ;;
	resize) run_resize ;;
	transitions) run_transitions ;;
	esc) run_esc ;;
	perf) run_perf ;;
esac
echo "captures in $OUT · failed checks: $FAILS"
exit $((FAILS > 0 ? 1 : 0))

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
# tmux runs on a private socket (-L) so other tmux sessions are never touched;
# the socket's server and the mock are killed on exit, INT and TERM.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${WAVEKIT_VALIDATE_OUT:-${TMPDIR:-/tmp}/wavekit-cli-validate}"
MODE="${1:-all}"
SOCK="wkv-$$"
SOCK_PATH="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$SOCK"
PERF_SECONDS="${WAVEKIT_VALIDATE_PERF_SECONDS:-60}"
SESSION="wkv"
SCENARIOS=(live idle api-down api-down-cached ws-only rest-only dropping crash-loop legacy long-text burst)
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
cat >"$CHECK" <<'JS'
// usage: node check-capture.mjs <file> <cols> <rows>
import { readFileSync } from "node:fs"
const [file, cols, rows] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])]
const lines = readFileSync(file, "utf8").replace(/\n$/, "").split("\n")
const wide = cp => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff)
const width = s => [...s].reduce((w, ch) => w + (/\p{Mn}/u.test(ch) ? 0 : wide(ch.codePointAt(0)) ? 2 : 1), 0)
// Keep in sync with cli/source/ui/copy-rules.ts
const banned = [/\bWaiting for\b/i, /\bNo\b.*\byet\b/, /\bLoading\b/i, /\bOK\b/, /\b(?:un)?healthy\b/i, /\bstable\b/i, /\ball good\b/i, /\bStatus:/, /\bn\/a\b/i, /\bunavailable\b(?! ·)/i, /\bsuccessfully\b/i, /\bplease\b/i, /[A-Za-z0-9)]!(?=\s|$)/, /360°/, /\bpress \S+ to view\b/i, /\bConnected\b/, /\bslow\b/i, /\blagging\b/i, /\boverloaded\b/i, /\bbottleneck\b/i, /\p{Emoji_Presentation}/u]
const errs = []
lines.forEach((l, i) => {
	if (width(l) > cols) errs.push(`line ${i + 1} is ${width(l)} wide (> ${cols})`)
	const plain = l.replace(/"[^"\n]*"/g, '""')
	for (const re of banned) if (re.test(plain)) errs.push(`line ${i + 1} has banned copy ${re}`)
})
const used = lines.length - [...lines].reverse().findIndex(l => l.trim() !== "")
if (!lines.some(l => l.trim() !== "")) errs.push("empty frame")
else if (used > rows - 1) errs.push(`frame uses ${used} rows (> ${rows - 1})`)
if (errs.length) {
	console.error(`FAIL ${file}\n  ${errs.join("\n  ")}`)
	process.exit(1)
}
JS

ms() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
tm() { LC_ALL=en_US.UTF-8 tmux -u -L "$SOCK" "$@"; }
mock() { curl -fsS -X POST -H 'content-type: application/json' -d "$2" "$API/__mock/$1" >/dev/null; }
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
start_cli() { # cols rows view
	tm kill-session -t "$SESSION" 2>/dev/null || true
	tm new-session -d -s "$SESSION" -x "$1" -y "$2" \
		"exec env -u WAVEKIT_WS_URL -u WAVEKIT_WS_URLS -u WAVEKIT_API_URL -u NO_COLOR -u WAVEKIT_ASCII LC_ALL=en_US.UTF-8 node $ROOT/cli/dist/cli.js --api $API --view $3"
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
node "$ROOT/cli/source/test/mock-api/server.ts" --port "$PORT" --scenario live >"$OUT/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do
	curl -fsS "$API/health" >/dev/null 2>&1 && break
	sleep 0.1
done
# /__mock/calls exists only on the mock: proves nothing else answers on this port.
curl -fsS "$API/__mock/calls" | grep -q '^\[' || {
	echo "no mock core on $API (see $OUT/mock.log)" >&2
	exit 1
}

# Loads a scenario. Cached failure states need a CLI that saw data first, so the
# mock serves them healthy until `degrade` applies the scenario's failure modes.
load() {
	mock scenario "{\"name\":\"$1\"}"
	case "$1" in
		api-down-cached | ws-only | rest-only)
			mock rest '{"mode":"ok"}'
			mock ws '{"mode":"up"}'
			;;
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

run_transitions() {
	load live
	start_cli 120 40 overview
	capture "$OUT/transition-0-live"
	mock ws '{"mode":"drop"}'
	sleep 2
	capture "$OUT/transition-1-ws-drop-2s"
	sleep 14
	capture "$OUT/transition-1-ws-drop-16s"
	grep -q "gap since" "$OUT/transition-1-ws-drop-16s.txt" || fail "transitions: no open gap after ws drop"
	mock ws '{"mode":"up"}'
	sleep 8
	capture "$OUT/transition-2-ws-up"
	grep -q "not replayed" "$OUT/transition-2-ws-up.txt" || fail "transitions: gap did not close"
	grep -q "gap since" "$OUT/transition-2-ws-up.txt" && fail "transitions: gap still open after ws up"
	mock rest '{"mode":"hang"}'
	sleep 20
	capture "$OUT/transition-3-rest-hang"
	grep -q "REST failing" "$OUT/transition-3-rest-hang.txt" || fail "transitions: no REST banner"
	mock rest '{"mode":"ok"}'
	sleep 8
	capture "$OUT/transition-4-rest-ok"
	grep -q "REST failing" "$OUT/transition-4-rest-ok.txt" && fail "transitions: REST banner still shown after recovery"
	return 0
}

# R12: Esc must close the decoder detail even when tmux delivers ESC alone
# (escape-time 0) or late (500 ms). A detail-only label pins that the detail was
# open before Esc, so a detail that never opened cannot pass.
DETAIL_ONLY="branch decoder-|server health"
run_esc() {
	local et before after
	load live
	for et in 0 500; do
		start_cli 120 40 decoders
		tm set -g escape-time "$et"
		key Down
		key Enter
		capture "$OUT/esc-$et-open"
		before=$(grep -Ec "$DETAIL_ONLY" "$OUT/esc-$et-open.txt" || true)
		key Escape
		capture "$OUT/esc-$et-closed"
		after=$(grep -Ec "$DETAIL_ONLY" "$OUT/esc-$et-closed.txt" || true)
		[ "$before" -gt 0 ] || fail "esc (escape-time $et): detail did not open"
		[ "$after" -eq 0 ] || fail "esc (escape-time $et): Esc did not close the detail"
	done
}

perf_run() { # name view burstPerSecond pause
	local name="$1" view="$2" rate="$3" pause="$4"
	local log="$OUT/perf-$1.tty" samples="$OUT/perf-$1.samples"
	: >"$log"
	: >"$samples"
	load live
	start_cli 120 40 "$view"
	if [ "$pause" = "yes" ]; then key p; fi
	tm pipe-pane -o -t "$SESSION" "cat >> $log"
	if [ "$rate" -gt 0 ]; then mock burst "{\"perSecond\":$rate,\"seconds\":$PERF_SECONDS}"; fi
	local pid
	pid="$(cli_pid)"
	for _ in $(seq 1 "$PERF_SECONDS"); do
		ps -o %cpu=,rss= -p "$pid" >>"$samples" || true
		sleep 1
	done
	# R3: key 4 opens Receiver; FANOUT appears on no other view.
	local t0 tries=0
	t0="$(ms)"
	tm send-keys -t "$SESSION" 4
	until tm capture-pane -p -t "$SESSION" | grep -q "FANOUT" || [ "$tries" -ge 200 ]; do
		sleep 0.05
		tries=$((tries + 1))
	done
	local latency="$(($(ms) - t0)) ms"
	if [ "$tries" -ge 200 ]; then latency="timeout (10 s)"; fi
	tm pipe-pane -t "$SESSION"
	local frames clears cpu rss0 rss1
	# grep exits 1 on no match; pipefail would abort the run, so count with grep -c over -o lines.
	frames=$(grep -o ' api ' "$log" | grep -c . || true)
	clears=$(grep -o $'\x1b\\[2J' "$log" | grep -c . || true)
	cpu=$(awk '{s+=$1} END {printf "%.1f", (NR ? s/NR : 0)}' "$samples")
	rss0=$(head -1 "$samples" | awk '{print $2}')
	rss1=$(tail -1 "$samples" | awk '{print $2}')
	printf '| %s | %s | %s | %s %% | %s MB | %s |\n' "$name" "$(awk -v f="$frames" -v s="$PERF_SECONDS" 'BEGIN {printf "%.1f", f / s}')" "$clears" "$cpu" \
		"$(((${rss1:-0} - ${rss0:-0}) / 1024))" "$latency" >>"$OUT/perf.md"
}

run_perf() {
	printf '| run | frames/s | ESC[2J | CPU avg | RSS growth | key→frame |\n|---|---|---|---|---|---|\n' >"$OUT/perf.md"
	perf_run idle-live overview 0 no
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

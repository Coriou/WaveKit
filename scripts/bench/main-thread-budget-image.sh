#!/usr/bin/env bash
# main-thread-budget-image.sh: the main-thread budget harness, tier B (an image in a scratch
# container with recorded IQ; measurement only, never a CI gate).
#
# The container runs with --network none and --cpus=1.5. Inside it, budget-fake-rtltcp.mjs
# serves the playlist on 127.0.0.1, budget-ws-client.mjs plays the web clients and
# budget-preload.mjs (loaded by NODE_OPTIONS into the core only) measures the window. Every
# API call goes through `docker exec ... curl` to the container's own loopback; nothing is
# reachable from the host network. The container is created with `docker create` (its ID kept
# in $BUDGET_OUT/container.id), always removed by that ID at the end, and the script exits
# non-zero if a container of its name is still present afterwards. The core's inspector is
# opened on demand (SIGUSR1) only when a profile or counts collector starts.
#
# Required environment:
#   BUDGET_IMAGE      image to measure
#   BUDGET_CONFIG     YAML config: its rtl_tcp source points at 127.0.0.1:$BUDGET_FAKE_PORT and
#                     its access mode is protected, API on 127.0.0.1:$BUDGET_API_PORT
#   BUDGET_PLAYLIST   playlist for the fake: `/iq/<file> <rateHz> [seconds]` lines
#   BUDGET_IQ_DIR     directory of the CU8 files, mounted read-only at /iq
#   BUDGET_OUT        out directory (created; must be new or empty)
#   BUDGET_API_PORT   the API port the config binds inside the container
#   BUDGET_SOURCE_ID  the config's source id (spectrum subscription, optional retune)
# Optional:
#   BUDGET_FAKE_PORT  (17234)        BUDGET_NAME (wk-scratch-budget; ^wk-scratch-[A-Za-z0-9_.-]+$)
#   BUDGET_SECONDS    (300)          BUDGET_WARMUP (60)       BUDGET_CLIENTS (0, 1 or 2; 1)
#   BUDGET_PASSIVE    (on|off; on)   BUDGET_PROFILE (0|1; 0)  BUDGET_COUNTS (0|1; 0)
#   BUDGET_LABEL      (image)        BUDGET_TUNE_HZ (a frequency to set once connected; none)
#   BUDGET_DIST_OVERLAY  a directory: each regular file directly inside it (names
#                     ^[A-Za-z0-9._-]+$) is bind-mounted read-only over /app/dist/<name>, so a
#                     JS-only change runs in the base image. Listed with sha256 in overlay.json;
#                     an index.js in it is the bundle the manifest describes.
#
# Afterwards (also run at the end when the bundle exists):
#   node output/bench/main-thread-budget.mjs --finish-image "$BUDGET_OUT"
set -u

die() {
	echo "main-thread-budget-image: $*" >&2
	exit 2
}

for v in BUDGET_IMAGE BUDGET_CONFIG BUDGET_PLAYLIST BUDGET_IQ_DIR BUDGET_OUT BUDGET_API_PORT BUDGET_SOURCE_ID; do
	[ -n "${!v:-}" ] || die "$v is required"
done
NAME="${BUDGET_NAME:-wk-scratch-budget}"
[[ "$NAME" =~ ^wk-scratch-[A-Za-z0-9_.-]+$ ]] || die "refusing container name $NAME (must match ^wk-scratch-[A-Za-z0-9_.-]+\$)"
FAKE_PORT="${BUDGET_FAKE_PORT:-17234}"
SECONDS_WIN="${BUDGET_SECONDS:-300}"
WARMUP="${BUDGET_WARMUP:-60}"
CLIENTS="${BUDGET_CLIENTS:-1}"
PASSIVE="${BUDGET_PASSIVE:-on}"
PROFILE="${BUDGET_PROFILE:-0}"
COUNTS="${BUDGET_COUNTS:-0}"
LABEL="${BUDGET_LABEL:-image}"
TUNE_HZ="${BUDGET_TUNE_HZ:-}"
OVERLAY="${BUDGET_DIST_OVERLAY:-}"
API_PORT="$BUDGET_API_PORT"
SRC="$BUDGET_SOURCE_ID"
case "$CLIENTS" in 0 | 1 | 2) ;; *) die "BUDGET_CLIENTS must be 0, 1 or 2" ;; esac
case "$PASSIVE" in on | off) ;; *) die "BUDGET_PASSIVE must be on or off" ;; esac
case "$PROFILE" in 0 | 1) ;; *) die "BUDGET_PROFILE must be 0 or 1" ;; esac
case "$COUNTS" in 0 | 1) ;; *) die "BUDGET_COUNTS must be 0 or 1" ;; esac
for n in "$FAKE_PORT" "$API_PORT" "$SECONDS_WIN" "$WARMUP"; do
	case "$n" in '' | *[!0-9]*) die "not a number: $n" ;; esac
done
[ -z "$TUNE_HZ" ] || case "$TUNE_HZ" in *[!0-9]*) die "BUDGET_TUNE_HZ must be an integer" ;; esac
[[ "$SRC" =~ ^[A-Za-z0-9_.-]+$ ]] || die "BUDGET_SOURCE_ID must match ^[A-Za-z0-9_.-]+\$"
[ -f "$BUDGET_CONFIG" ] || die "no config at $BUDGET_CONFIG"
[ -f "$BUDGET_PLAYLIST" ] || die "no playlist at $BUDGET_PLAYLIST"
[ -d "$BUDGET_IQ_DIR" ] || die "no IQ dir at $BUDGET_IQ_DIR"
[ -z "$OVERLAY" ] || [ -d "$OVERLAY" ] || die "BUDGET_DIST_OVERLAY is not a directory: $OVERLAY"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
if [ -e "$BUDGET_OUT" ] && [ -n "$(ls -A "$BUDGET_OUT" 2>/dev/null)" ]; then
	die "$BUDGET_OUT exists and is not empty"
fi
mkdir -p "$BUDGET_OUT/state" "$BUDGET_OUT/preload" "$BUDGET_OUT/ws" || die "cannot create $BUDGET_OUT"
OUT="$(cd "$BUDGET_OUT" && pwd)"
CONFIG="$(cd "$(dirname "$BUDGET_CONFIG")" && pwd)/$(basename "$BUDGET_CONFIG")"
IQ_DIR="$(cd "$BUDGET_IQ_DIR" && pwd)"
cp "$BUDGET_PLAYLIST" "$OUT/playlist.txt" || die "cannot copy the playlist"

sha256_of() {
	local h
	h="$(shasum -a 256 "$1" 2>/dev/null || sha256sum "$1")" || return 1
	printf '%s' "${h%% *}"
}

# The overlay: one read-only bind mount per regular file directly inside the directory.
OVERLAY_MOUNTS=()
OVERLAY_HAS_INDEX=0
if [ -n "$OVERLAY" ]; then
	OVERLAY="$(cd "$OVERLAY" && pwd)"
	OVERLAY_ARGS=()
	for f in "$OVERLAY"/* "$OVERLAY"/.[!.]*; do
		[ -e "$f" ] || [ -L "$f" ] || continue
		[ -f "$f" ] && [ ! -L "$f" ] || continue
		b="$(basename "$f")"
		[[ "$b" =~ ^[A-Za-z0-9._-]+$ ]] || die "overlay file name not allowed: $b"
		h="$(sha256_of "$f")" || die "cannot hash $f"
		OVERLAY_MOUNTS+=(-v "$f:/app/dist/$b:ro")
		OVERLAY_ARGS+=("$b" "$h")
		[ "$b" = index.js ] && OVERLAY_HAS_INDEX=1
	done
	node -e 'const [o, ...a] = process.argv.slice(1); const files = []; for (let i = 0; i < a.length; i += 2) files.push({ file: a[i], sha256: a[i + 1] }); require("fs").writeFileSync(o, JSON.stringify(files, null, 2))' \
		"$OUT/overlay.json" ${OVERLAY_ARGS[@]+"${OVERLAY_ARGS[@]}"} || die "cannot write overlay.json"
	if [ "$OVERLAY_HAS_INDEX" = 1 ]; then
		cp "$OVERLAY/index.js" "$OUT/index.js" || die "cannot copy the overlay's index.js"
	fi
fi

name_present() {
	[ -n "$(docker ps -a --filter "name=^/${NAME}\$" --format '{{.Names}}')" ]
}
if name_present; then
	die "a container named $NAME exists; remove it first"
fi
IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$BUDGET_IMAGE")" || die "no image $BUDGET_IMAGE"

# Sleeps that INT and TERM interrupt at once (the trap runs as soon as `wait` returns).
nap() {
	sleep "$1" &
	wait $!
}

SAMPLER_PID=""
STARTED=0
CID=""
cleanup() {
	local rc=0
	if [ -n "$SAMPLER_PID" ]; then kill "$SAMPLER_PID" 2>/dev/null; fi
	SAMPLER_PID=""
	if [ "$STARTED" = 1 ] && [ -n "$CID" ]; then
		if [ "$OVERLAY_HAS_INDEX" != 1 ]; then
			docker cp "$CID:/app/dist/index.js" "$OUT/index.js" >/dev/null 2>&1 || echo "could not copy the bundle" >&2
		fi
		docker logs "$CID" >"$OUT/core.log" 2>&1
		docker stop -t 20 "$CID" >/dev/null 2>&1
		docker rm -f "$CID" >/dev/null 2>&1
	fi
	STARTED=0
	if name_present; then
		echo "container $NAME is STILL PRESENT" >&2
		rc=1
	elif [ -n "$CID" ]; then
		echo "container $NAME removed"
	fi
	return "$rc"
}
trap 'cleanup || exit 3' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Exec inside the container without the preload. Values go in as -e variables, never into
# command text.
X() { docker exec -e NODE_OPTIONS= "$@"; }

docker create --name "$NAME" --network none --cpus=1.5 \
	-v "$CONFIG:/cfg/config.yaml:ro" \
	-v "$OUT/state:/state" \
	-v "$OUT:/out" \
	-v "$IQ_DIR:/iq:ro" \
	-v "$HERE:/bench:ro" \
	${OVERLAY_MOUNTS[@]+"${OVERLAY_MOUNTS[@]}"} \
	-e WAVEKIT_CONFIG=/cfg/config.yaml \
	-e WAVEKIT_ACCESS_PRIVATE_DIRECTORY=/state/access \
	-e BUDGET_OUT=/out/preload \
	-e BUDGET_SOURCE_PORT="$FAKE_PORT" \
	-e NODE_OPTIONS="--import /bench/budget-preload.mjs" \
	"$BUDGET_IMAGE" >"$OUT/container.id" || die "docker create failed"
CID="$(cat "$OUT/container.id")"
[[ "$CID" =~ ^[0-9a-f]{12,64}$ ]] || die "docker create gave no container ID"
STARTED=1
docker start "$CID" >/dev/null || die "docker start failed"

X "$CID" node /app/dist/access-command.js setup --private-directory /state/access \
	--ownership single-host-pid-namespace \
	--api-origin "http://127.0.0.1:$API_PORT" --allow-origin "http://127.0.0.1:$API_PORT" | head -1
TOKEN=""
for _ in $(seq 1 40); do
	TOKEN="$(X "$CID" node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/state/access/access-state.json","utf8")).machineToken)' 2>/dev/null)"
	[ -n "$TOKEN" ] && break
	nap 3
done
[ -n "$TOKEN" ] || die "no machine token in the container's access state"

api() {
	X "$CID" curl -s -m 20 -X "$1" -H "Host: 127.0.0.1:$API_PORT" -H "Authorization: Bearer $TOKEN" \
		-H 'content-type: application/json' ${3:+--data "$3"} "http://127.0.0.1:$API_PORT$2"
}
# PIDF: a pid file inside the container; SIG: a signal name.
pidfile_kill() { X -e SIG="$1" -e PIDF="$2" "$CID" sh -c 'kill -"$SIG" "$(cat "$PIDF")"' 2>/dev/null; }
pidfile_alive() { X -e PIDF="$1" "$CID" sh -c 'kill -0 "$(cat "$PIDF")"' 2>/dev/null; }

X -d -e FAKE_PORT="$FAKE_PORT" "$CID" sh -c 'node /bench/budget-fake-rtltcp.mjs "$FAKE_PORT" /out/playlist.txt /out/fake.jsonl >/out/fake.log 2>&1 & echo $! >/out/fake.pid'
echo "started $(date -u +%FT%TZ)"
CONNECTED=0
for _ in $(seq 1 100); do
	if api GET /api/sources 2>/dev/null | grep -q '"connected":true'; then
		CONNECTED=1
		break
	fi
	nap 3
done
[ "$CONNECTED" = 1 ] || die "the source did not connect"
[ -f "$OUT/preload/preload.json" ] || die "the preload did not activate in the core (no preload/preload.json); not signalling it"
COREPID="$(cat "$OUT/preload/core.pid" 2>/dev/null)"
case "$COREPID" in '' | *[!0-9]*) die "no core PID in preload/core.pid" ;; esac
if [ -n "$TUNE_HZ" ]; then
	api POST "/api/tuner/$SRC/frequency" "{\"hz\":$TUNE_HZ}" | head -c 200
	echo
fi
if [ "$PASSIVE" = off ]; then
	api PATCH /api/scanner/settings "{\"passive\":{\"$SRC\":false}}" >"$OUT/scanner-patch.json"
fi
for i in $(seq 1 "$CLIENTS"); do
	X -d -e TOKEN="$TOKEN" -e SRC="$SRC" -e API_PORT="$API_PORT" -e CLIENT="client-$i" -e N="$i" "$CID" \
		sh -c 'node /bench/budget-ws-client.mjs "ws://127.0.0.1:$API_PORT/ws" "$TOKEN" /out/ws --spectrum --source "$SRC" --name "$CLIENT" >"/out/ws-$N.log" 2>&1 & echo $! >"/out/ws-$N.pid"'
done

(
	while true; do
		t="$(date -u +%FT%TZ)"
		echo "$t $(uptime)" >>"$OUT/uptime.txt"
		echo "$t $(docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' "$CID" 2>/dev/null)" >>"$OUT/dockerstats.txt"
		sleep 10
	done
) &
SAMPLER_PID=$!

echo "warm-up $WARMUP s"
nap "$WARMUP"

# One edge of the window: the core first, then the fake and every client, from one exec.
edge() {
	X -e CLIENTS="$CLIENTS" "$CID" sh -c '
		kill -USR2 "$(cat /out/preload/core.pid)" || exit 1
		kill -USR2 "$(cat /out/fake.pid)"
		i=1
		while [ "$i" -le "$CLIENTS" ]; do
			kill -USR2 "$(cat "/out/ws-$i.pid")"
			i=$((i + 1))
		done'
}
# The core's children and itself, from /proc inside the container.
procstat() { X -e COREPID="$COREPID" "$CID" sh -c 'node /bench/budget-preload.mjs procstat "$COREPID"' >"$1"; }
collector() { # MODE OUTFILE: open the inspector, start the collector, wait until it reports `started`
	X -e COREPID="$COREPID" "$CID" sh -c 'kill -USR1 "$COREPID"' || return 1
	X -d -e MODE="$1" -e OUTF="$2" -e SECS="$SECONDS_WIN" "$CID" \
		sh -c 'node /bench/budget-preload.mjs collect "$MODE" 127.0.0.1:9229 "$SECS" "$OUTF" >"/out/collect-$MODE.log" 2>&1 & echo $! >"/out/collect-$MODE.pid"'
	for _ in $(seq 1 60); do
		if grep -q '^started' "$OUT/collect-$1.log" 2>/dev/null; then return 0; fi
		nap 1
	done
	echo "collector $1 did not start" >&2
	return 1
}
collector_wait() { # MODE LIMIT: wait for the collector's PID to exit
	for _ in $(seq 1 "$2"); do
		pidfile_alive "/out/collect-$1.pid" || return 0
		nap 1
	done
	echo "collector $1 still running after $2 s" >&2
	return 1
}

api GET '/api/scanner/recorder/decisions?limit=1' >"$OUT/decisions-start.json"
if [ "$PROFILE" = 1 ]; then collector profile /out/main.cpuprofile || die "no profiler"; fi
procstat "$OUT/proc-start.txt"
edge || die "cannot signal the core"
echo "window open $(date -u +%FT%TZ), $SECONDS_WIN s"
nap "$SECONDS_WIN"
edge
procstat "$OUT/proc-end.txt"
api GET '/api/scanner/recorder/decisions?limit=1' >"$OUT/decisions-end.json"
if [ "$PROFILE" = 1 ]; then
	collector_wait profile 60
	[ -f "$OUT/main.cpuprofile" ] || echo "no CPU profile written" >&2
fi
api GET /api/decoders >"$OUT/decoders-end.json"
if [ "$COUNTS" = 1 ]; then
	echo "counts window $SECONDS_WIN s"
	collector coverage /out/coverage.json || die "no coverage"
	nap "$SECONDS_WIN"
	collector_wait coverage 120
	[ -f "$OUT/coverage.json" ] || echo "no coverage written" >&2
fi
for i in $(seq 1 "$CLIENTS"); do pidfile_kill TERM "/out/ws-$i.pid"; done
pidfile_kill TERM /out/fake.pid
nap 2

PROFILE_JSON=false
COUNTS_JSON=false
PASSIVE_JSON=true
[ "$PROFILE" = 1 ] && PROFILE_JSON=true
[ "$COUNTS" = 1 ] && COUNTS_JSON=true
[ "$PASSIVE" = off ] && PASSIVE_JSON=false
TUNE_JSON=null
[ -n "$TUNE_HZ" ] && TUNE_JSON="$TUNE_HZ"
CONFIG_SHA="$(sha256_of "$CONFIG")"
node -e 'const [o, ...a] = process.argv.slice(1); require("fs").writeFileSync(o, JSON.stringify({ label: a[0], clients: Number(a[1]), passive: a[2] === "true", profile: a[3] === "true", counts: a[4] === "true", imageId: a[5], configSha256: a[6], sourceId: a[7], tuneHz: a[8] === "null" ? null : Number(a[8]), iqDir: a[9], windowSeconds: Number(a[10]), warmupSeconds: Number(a[11]) }, null, 2))' \
	"$OUT/run-image.json" "$LABEL" "$CLIENTS" "$PASSIVE_JSON" "$PROFILE_JSON" "$COUNTS_JSON" "$IMAGE_ID" "$CONFIG_SHA" "$SRC" "$TUNE_JSON" "$IQ_DIR" "$SECONDS_WIN" "$WARMUP"

cleanup || exit 3
CID=""
trap - EXIT

if [ -f "$ROOT/output/bench/main-thread-budget.mjs" ]; then
	node "$ROOT/output/bench/main-thread-budget.mjs" --finish-image "$OUT"
else
	echo "build the harness (node scripts/bench/budget-build.mjs), then:"
	echo "  node output/bench/main-thread-budget.mjs --finish-image $OUT"
fi

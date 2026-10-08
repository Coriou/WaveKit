#!/usr/bin/env bash
# Run the rtlmux reconnect regression harness in throwaway Debian containers.
#
#   bash scripts/native-patches/run-rtlmux-tests.sh memory
#       Build unpatched and patched rtlmux (RTLMUX_REF) twice, with
#       AddressSanitizer and plain -O1 -g for valgrind memcheck, and run
#       test_rtlmux_reconnect.py against each pair. Patched builds must pass
#       every scenario; unpatched builds must show a memory error. libevent is
#       not ASan-instrumented, so valgrind is the authoritative check for
#       accesses to the freed bufferevent inside libevent.
#   bash scripts/native-patches/run-rtlmux-tests.sh release IMAGE
#       Extract /usr/local/bin/rtlmux from a built sdr-host IMAGE and run the
#       harness against that shipped binary (functional; no sanitizer) on the
#       image's own platform. ARM64 runs under emulation on x86 hosts, where
#       valgrind is unreliable; RTLMUX_VALGRIND=1 adds memcheck on native hosts.
#
# rtlmux binds its stats HTTP listener to "::" through getaddrinfo with
# AI_ADDRCONFIG, which needs a non-loopback IPv6 address, so the containers
# join a dedicated IPv6 bridge network. Traffic stays on loopback; network is
# only needed for apt and git. Output: harness JSON on stdout, one per pass.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RTLMUX_REF="${RTLMUX_REF:-60bc8de9cc4085603463801d6d1fe20da7c28484}"
BASE_IMAGE="debian:bookworm-slim"
NETWORK="rtlmux-test-v6"
MODE="${1:-memory}"

docker network inspect "$NETWORK" >/dev/null 2>&1 ||
	docker network create --ipv6 --subnet fd42:7a6b:1::/64 "$NETWORK" >/dev/null

case "$MODE" in
	memory)
		# Pin the daemon's native platform: a prior release run on another
		# architecture may have re-tagged the local base image.
		NATIVE="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
		docker run --rm --cpus 2 --memory 1g --platform "$NATIVE" --network "$NETWORK" \
			-e RTLMUX_REF="$RTLMUX_REF" \
			-v "$HERE:/verification:ro" "$BASE_IMAGE" bash -euo pipefail -c '
				apt-get update -qq
				apt-get install -y -qq --no-install-recommends build-essential git \
					ca-certificates libevent-dev gengetopt python3 valgrind >/dev/null
				git clone -q https://gitlab.com/slepp/rtlmux.git /src/base
				git -C /src/base checkout -q --detach "$RTLMUX_REF"
				cp -a /src/base /src/patched
				git -C /src/patched apply --check /verification/rtlmux-server-reconnect.patch
				git -C /src/patched apply /verification/rtlmux-server-reconnect.patch
				for tree in base patched; do
					cp -a "/src/$tree" "/src/$tree-asan"
					make -s -C "/src/$tree-asan" \
						CFLAGS="-Wall -O1 -g -fsanitize=address -fno-omit-frame-pointer" >&2
					make -s -C "/src/$tree" CFLAGS="-Wall -O1 -g" >&2
				done
				python3 /verification/test_rtlmux_reconnect.py \
					--candidate /src/patched-asan/rtlmux --baseline /src/base-asan/rtlmux \
					--require-baseline-failure
				python3 /verification/test_rtlmux_reconnect.py --valgrind --timeout-scale 3 \
					--candidate /src/patched/rtlmux --baseline /src/base/rtlmux \
					--require-baseline-failure'
		;;
	release)
		IMAGE="${2:?usage: run-rtlmux-tests.sh release IMAGE}"
		PLATFORM="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE")"
		WORK="$(mktemp -d)"
		trap 'rm -rf "$WORK"; docker rm -f "rtlmux-extract-$$" >/dev/null 2>&1 || true' EXIT
		docker create --name "rtlmux-extract-$$" "$IMAGE" >/dev/null
		docker cp "rtlmux-extract-$$:/usr/local/bin/rtlmux" "$WORK/rtlmux"
		docker run --rm --cpus 2 --memory 1g --platform "$PLATFORM" --network "$NETWORK" \
			-e RTLMUX_VALGRIND="${RTLMUX_VALGRIND:-0}" \
			-e RTLMUX_TIMEOUT_SCALE="${RTLMUX_TIMEOUT_SCALE:-5}" -v "$HERE:/verification:ro" -v "$WORK:/candidate:ro" "$BASE_IMAGE" \
			bash -euo pipefail -c '
				apt-get update -qq
				apt-get install -y -qq --no-install-recommends libevent-2.1-7 \
					libevent-pthreads-2.1-7 python3 >/dev/null
				if [ "$RTLMUX_VALGRIND" = 1 ]; then
					apt-get install -y -qq --no-install-recommends valgrind >/dev/null
				fi
				extra=()
				if [ "$RTLMUX_VALGRIND" = 1 ]; then extra=(--valgrind); fi
				python3 /verification/test_rtlmux_reconnect.py "${extra[@]}" \
					--timeout-scale "$RTLMUX_TIMEOUT_SCALE" --candidate /candidate/rtlmux'
		;;
	*)
		echo "usage: run-rtlmux-tests.sh memory | release IMAGE" >&2
		exit 2
		;;
esac

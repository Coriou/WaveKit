#!/bin/sh
# Builds the spectrum frame kernel: one wasm32 artefact for every host architecture.
#
#   native/wavekit-frame/build.sh [out.wasm]
#   native/wavekit-frame/build.sh --digest     (prints the source digest only; no cargo)
#
# Needs Rust 1.98.1 (the pinned toolchain) with the wasm32-unknown-unknown target. Writes
# dist/spectrum-frame.wasm by default, next to dist/spectrum-worker.js, where the worker looks.
# The Dockerfile's frame-wasm stage runs this same script.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# Source digest (scripts/kernel-digest.mjs computes the same): sha256 of one "<sha256>  <path>" line
# per file (build.sh, Cargo.toml, Cargo.lock, src/**), paths relative to the crate, sorted bytewise.
# It goes into the artefact as the custom section "wavekit.source-digest"; the loader compares it
# with the digest bundled into the JS and refuses an artefact built from other sources.
sha() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}
digest() {
	(cd "$here" && { printf '%s\n' build.sh Cargo.toml Cargo.lock; find src -type f; } | LC_ALL=C sort |
		while IFS= read -r f; do printf '%s  %s\n' "$(sha <"$f")" "$f"; done) | sha
}
if [ "${1:-}" = "--digest" ]; then
	digest
	exit 0
fi
out=${1:-"$here/../../dist/spectrum-frame.wasm"}
target=${CARGO_TARGET_DIR:-"$here/target"}
# simd128: the FFT stages and loops use wasm SIMD. Memory is the host's (--import-memory) and the
# kernel allocates nothing; 64 KiB of stack is far more than its call depth needs.
RUSTFLAGS="-C target-feature=+simd128 -C link-arg=--import-memory -C link-arg=-zstack-size=65536 -C link-arg=--export=__heap_base" \
	cargo build --release --locked --target wasm32-unknown-unknown \
	--manifest-path "$here/Cargo.toml" --target-dir "$target"
mkdir -p "$(dirname "$out")"
cp "$target/wasm32-unknown-unknown/release/wavekit_frame.wasm" "$out"
d=$(digest)
[ ${#d} -eq 64 ] || { echo "source digest failed" >&2; exit 1; }
# custom section: id 0, size 86 (one LEB128 byte: name length 1 + name 21 + digest 64), name, digest
printf '\000\126\025%s%s' wavekit.source-digest "$d" >>"$out"
echo "built $out"

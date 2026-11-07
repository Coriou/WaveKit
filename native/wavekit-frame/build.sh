#!/bin/sh
# Builds the spectrum frame kernel: one wasm32 artefact for every host architecture.
#
#   native/wavekit-frame/build.sh [out.wasm]
#
# Needs Rust 1.98.1 (the pinned toolchain) with the wasm32-unknown-unknown target. Writes
# dist/spectrum-frame.wasm by default, next to dist/spectrum-worker.js, where the worker looks.
# The Dockerfile's frame-wasm stage runs this same script.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/../../dist/spectrum-frame.wasm"}
target=${CARGO_TARGET_DIR:-"$here/target"}
# simd128: the FFT stages and loops use wasm SIMD. Memory is the host's (--import-memory) and the
# kernel allocates nothing; 64 KiB of stack is far more than its call depth needs.
RUSTFLAGS="-C target-feature=+simd128 -C link-arg=--import-memory -C link-arg=-zstack-size=65536 -C link-arg=--export=__heap_base" \
	cargo build --release --locked --target wasm32-unknown-unknown \
	--manifest-path "$here/Cargo.toml" --target-dir "$target"
mkdir -p "$(dirname "$out")"
cp "$target/wasm32-unknown-unknown/release/wavekit_frame.wasm" "$out"
echo "built $out"

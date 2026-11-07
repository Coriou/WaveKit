#!/bin/sh
# Builds the wideband recorder's NFM chain: one wasm32 artefact for every host architecture.
#
#   native/wavekit-nfm/build.sh [out.wasm]
#
# Needs Rust 1.98.1 (the pinned toolchain) with the wasm32-unknown-unknown target. Writes
# dist/wideband-nfm.wasm by default, next to dist/index.js, where the recorder looks.
# The Dockerfile's frame-wasm stage runs this same script.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/../../dist/wideband-nfm.wasm"}
target=${CARGO_TARGET_DIR:-"$here/target"}
# simd128: the FIRs and the stage-1 mix use f64x2 lanes. Memory is the host's (--import-memory),
# fixed per chain, and the chain allocates nothing; 64 KiB of stack is far more than it needs.
RUSTFLAGS="-C target-feature=+simd128 -C link-arg=--import-memory -C link-arg=-zstack-size=65536 -C link-arg=--export=__heap_base" \
	cargo build --release --locked --target wasm32-unknown-unknown \
	--manifest-path "$here/Cargo.toml" --target-dir "$target"
mkdir -p "$(dirname "$out")"
cp "$target/wasm32-unknown-unknown/release/wavekit_nfm.wasm" "$out"
echo "built $out"

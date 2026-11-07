import path from "node:path"
import process from "node:process"
import {
	FRAME_WASM_FILE,
	loadFrameWasm,
} from "../../../../src/core/spectrum/frame-wasm.js"
import type { FrameWasmModule } from "../../../../src/core/spectrum/frame-wasm.js"

/**
 * The built kernel (native/wavekit-frame/build.sh writes dist/spectrum-frame.wasm), or another one
 * from WAVEKIT_SPECTRUM_FRAME_WASM. Without it the wasm halves of the tests are skipped and say why.
 */
export const FRAME_WASM_PATH =
	process.env["WAVEKIT_SPECTRUM_FRAME_WASM"] ??
	path.resolve(import.meta.dirname, "../../../../dist", FRAME_WASM_FILE)

const load = loadFrameWasm(FRAME_WASM_PATH)

export const frameWasm: FrameWasmModule | null = load.ok ? load.module : null
export const frameWasmMissing = load.ok ? "" : load.reason
/** `describe.skipIf` label suffix. */
export const WASM_LABEL = load.ok
	? "wasm"
	: `wasm (skipped: ${load.reason}; run native/wavekit-frame/build.sh)`

/** Both frame paths, for parametrised tests. */
export const FRAME_PATHS = [
	{ path: "js" as const, frameWasm: null, skip: false },
	{ path: "wasm" as const, frameWasm, skip: frameWasm === null },
]

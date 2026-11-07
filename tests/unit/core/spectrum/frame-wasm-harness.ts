import path from "node:path"
import process from "node:process"
import {
	FRAME_WASM_FILE,
	loadFrameWasm,
} from "../../../../src/core/spectrum/frame-wasm.js"
import type { FrameWasmModule } from "../../../../src/core/spectrum/frame-wasm.js"

/**
 * The built kernel (native/wavekit-frame/build.sh writes dist/spectrum-frame.wasm), or another one
 * from WAVEKIT_SPECTRUM_FRAME_WASM. Without it the wasm halves of the tests are skipped: this module
 * prints one line saying so (per test file that imports it) and the skipped suites carry the reason
 * in their names. With WAVEKIT_REQUIRE_FRAME_WASM=1 a missing or invalid artefact fails every file
 * that imports this module instead, so a CI job that builds the artefact can require it.
 */
export const FRAME_WASM_PATH =
	process.env["WAVEKIT_SPECTRUM_FRAME_WASM"] ??
	path.resolve(import.meta.dirname, "../../../../dist", FRAME_WASM_FILE)

/** WAVEKIT_REQUIRE_FRAME_WASM=1: the wasm cases must run. */
export const FRAME_WASM_REQUIRED =
	process.env["WAVEKIT_REQUIRE_FRAME_WASM"] === "1"

const load = loadFrameWasm(FRAME_WASM_PATH)

if (!load.ok) {
	const why = `frame kernel ${FRAME_WASM_PATH}: ${load.reason}`
	if (FRAME_WASM_REQUIRED)
		throw new Error(
			`${why}; WAVEKIT_REQUIRE_FRAME_WASM=1 requires it (run native/wavekit-frame/build.sh)`,
		)
	process.stderr.write(
		`[frame-wasm] SKIPPING the wasm frame-path cases: ${why}. Run native/wavekit-frame/build.sh, or set WAVEKIT_REQUIRE_FRAME_WASM=1 to fail instead.\n`,
	)
}

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

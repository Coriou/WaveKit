/**
 * WAVEKIT_REQUIRE_NFM_WASM=1 for the recorder tests. The recorder builds its chains with
 * `createWidebandNfmChain`, on the process runtime, whose default artefact is wideband-nfm.wasm next
 * to the module: under vitest that is src/core/scanner/channel/, where nothing is built, so these
 * tests run the JS chain unless WAVEKIT_RECORDER_DSP_WASM names the built artefact:
 *
 *   native/wavekit-nfm/build.sh
 *   WAVEKIT_RECORDER_DSP_WASM=$PWD/dist/wideband-nfm.wasm WAVEKIT_REQUIRE_NFM_WASM=1 \
 *     pnpm exec vitest run --maxWorkers=1 tests/unit/core/scanner
 *
 * With WAVEKIT_REQUIRE_NFM_WASM=1, importing this module throws when the runtime's chains would be
 * JS (the artefact missing, unreadable, invalid, or built from other sources than the crate's now,
 * or WAVEKIT_RECORDER_DSP=js), so the file fails instead of silently testing the JS chain. Without
 * the flag it does nothing. Production behaviour is unchanged.
 */
import process from "node:process"
import { loadNfmWasm } from "../../../../src/core/scanner/channel/wideband-nfm-wasm.js"
import { widebandNfmRuntime } from "../../../../src/core/scanner/channel/wideband-nfm.js"
import {
	KERNEL_CRATES,
	kernelSourceDigest,
} from "../../../../scripts/kernel-digest.mjs"

/** Why the recorder's chains would run JS under WAVEKIT_REQUIRE_NFM_WASM=1; null when they run wasm. */
export function recorderDspFallback(
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const location = env["WAVEKIT_RECORDER_DSP_WASM"]
	if (location === undefined)
		return "WAVEKIT_RECORDER_DSP_WASM is unset, so the recorder's chains look next to the module source and run JS; set it to dist/wideband-nfm.wasm"
	if (env["WAVEKIT_RECORDER_DSP"] === "js") return "WAVEKIT_RECORDER_DSP=js"
	const current = loadNfmWasm(location, {
		configuredBy: "WAVEKIT_RECORDER_DSP_WASM",
		digest: kernelSourceDigest(KERNEL_CRATES.nfm).digest,
	})
	if (!current.ok) return current.reason
	return null
}

if (process.env["WAVEKIT_REQUIRE_NFM_WASM"] === "1") {
	const why = recorderDspFallback()
	if (why !== null)
		throw new Error(
			`WAVEKIT_REQUIRE_NFM_WASM=1: the recorder's NFM chains would run JS (${why}); run native/wavekit-nfm/build.sh`,
		)
	// The runtime the recorder uses must agree (it reads the same variables, once per process).
	const load = widebandNfmRuntime().wasm()
	if (!load.ok)
		throw new Error(
			`WAVEKIT_REQUIRE_NFM_WASM=1: the process runtime gives JS chains (${load.reason})`,
		)
}

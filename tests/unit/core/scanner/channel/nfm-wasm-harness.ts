import path from "node:path"
import process from "node:process"
import { CtcssBank } from "../../../../../src/core/audio-tones/ctcss.js"
import { ToneClassEvidence } from "../../../../../src/core/scanner/channel/tone-class.js"
import {
	VoiceActivityGate,
	VoiceOnAirMeter,
} from "../../../../../src/core/scanner/channel/voice-activity.js"
import {
	NFM_WASM_FILE,
	loadNfmWasm,
} from "../../../../../src/core/scanner/channel/wideband-nfm-wasm.js"
import type { NfmWasmLoad } from "../../../../../src/core/scanner/channel/wideband-nfm-wasm.js"
import {
	MAX_SLICE_SAMPLES,
	WidebandNfmRuntime,
	widebandNfmChainPath,
} from "../../../../../src/core/scanner/channel/wideband-nfm.js"
import type {
	WidebandNfmChain,
	WidebandNfmLog,
	WidebandNfmOptions,
} from "../../../../../src/core/scanner/channel/wideband-nfm.js"

/**
 * The built kernel (native/wavekit-nfm/build.sh writes dist/wideband-nfm.wasm), or another one from
 * WAVEKIT_RECORDER_DSP_WASM. Without it the wasm cases are skipped: this module prints one line
 * saying so (per test file that imports it) and the skipped suites carry the reason in their
 * names. With WAVEKIT_REQUIRE_NFM_WASM=1 a missing or invalid artefact fails every file that
 * imports this module instead, so a CI job that builds the artefact can require it.
 */
export const NFM_WASM_PATH =
	process.env["WAVEKIT_RECORDER_DSP_WASM"] ??
	path.resolve(import.meta.dirname, "../../../../../dist", NFM_WASM_FILE)

const load: NfmWasmLoad = loadNfmWasm(NFM_WASM_PATH)

if (!load.ok) {
	const why = `NFM kernel ${NFM_WASM_PATH}: ${load.reason}`
	if (process.env["WAVEKIT_REQUIRE_NFM_WASM"] === "1")
		throw new Error(
			`${why}; WAVEKIT_REQUIRE_NFM_WASM=1 requires it (run native/wavekit-nfm/build.sh)`,
		)
	process.stderr.write(
		`[nfm-wasm] SKIPPING the wasm NFM chain cases: ${why}. Run native/wavekit-nfm/build.sh, or set WAVEKIT_REQUIRE_NFM_WASM=1 to fail instead.\n`,
	)
}

export const nfmWasmAvailable = load.ok
/** `describe.skipIf` label suffix. */
export const WASM_LABEL = load.ok
	? "wasm"
	: `wasm (skipped: ${load.reason}; run native/wavekit-nfm/build.sh)`

export interface LogLine {
	level: "info" | "warn"
	obj: object
	msg: string
}

/** A log that keeps its lines. */
export function recordingLog(): WidebandNfmLog & { lines: LogLine[] } {
	const lines: LogLine[] = []
	return {
		lines,
		info: (obj, msg) => lines.push({ level: "info", obj, msg }),
		warn: (obj, msg) => lines.push({ level: "warn", obj, msg }),
	}
}

/** A runtime on the test artefact with its own fault count and log. */
export function testRuntime(
	choice: "auto" | "js" | "wasm" = "auto",
	location: string = NFM_WASM_PATH,
): { runtime: WidebandNfmRuntime; log: ReturnType<typeof recordingLog> } {
	const log = recordingLog()
	return {
		runtime: new WidebandNfmRuntime({ choice, location, log }),
		log,
	}
}

/** A wasm chain (throws when the runtime gave JS: the caller skipped without the artefact). */
export function wasmChain(
	runtime: WidebandNfmRuntime,
	opts: WidebandNfmOptions,
): WidebandNfmChain {
	const chain = runtime.chain(opts)
	if (widebandNfmChainPath(chain) !== "wasm")
		throw new Error("expected a wasm chain")
	return chain
}

export interface ChainOutput {
	pcm: Int16Array
	tone: Int16Array
}

/** Runs `cu8` through `chain` in chunks of `chunk(i)` IQ pairs (clamped to MAX_SLICE_SAMPLES). */
export function runChain(
	chain: WidebandNfmChain,
	cu8: Uint8Array,
	chunk: (i: number) => number,
): ChainOutput {
	const pcm: Int16Array[] = []
	const tone: Int16Array[] = []
	const n = cu8.length / 2
	for (let i = 0, at = 0; at < n; i++) {
		const len = Math.max(1, Math.min(MAX_SLICE_SAMPLES, chunk(i), n - at))
		const p = chain.process(cu8.subarray(2 * at, 2 * (at + len)))
		const t = chain.toneAudio()
		if (t.length !== p.length) throw new Error("tone and pcm lengths differ")
		pcm.push(p)
		tone.push(t.slice())
		at += len
	}
	return { pcm: concat(pcm), tone: concat(tone) }
}

export function concat(parts: readonly Int16Array[]): Int16Array {
	const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0))
	let o = 0
	for (const p of parts) {
		out.set(p, o)
		o += p.length
	}
	return out
}

/** Largest |a − b| and how many samples differ (lengths must match). */
export function lsbDiff(
	a: Int16Array,
	b: Int16Array,
): { max: number; differing: number } {
	if (a.length !== b.length)
		throw new Error(`lengths differ: ${a.length} vs ${b.length}`)
	let max = 0
	let differing = 0
	for (let i = 0; i < a.length; i++) {
		const d = Math.abs(a[i]! - b[i]!)
		if (d > 0) differing++
		if (d > max) max = d
	}
	return { max, differing }
}

export interface Verdicts {
	frames: number
	/** VoiceActivityGate: latched, at which frame, and its conclusion over all the audio. */
	gateVoiced: boolean
	gateLatchFrame: number | null
	gateConcluded: boolean
	/** VoiceOnAirMeter: the end of the last voiced window per 100 ms chunk (absolute frames). */
	onAir: number[]
	/** CtcssBank over the tone twin: result and the winning tone of every block. */
	ctcssHz: number | null
	ctcssBlocks: number[]
	/** ToneClassEvidence (classByTone): result, speech counts and the gap rule. */
	toneClassHz: number | null
	speech: { frames: number; syllabic: number; voiced: number }
	toneCanHold: boolean
}

/**
 * The recorder's per-file judgements over one chain output, fed as the recorder feeds them
 * (gateFrames: the voice gate, then the on-air meter; toneFrames: the CTCSS bank and the tone
 * class evidence; speechRun on the same runs), in 100 ms chunks, all frames in track.
 */
export function verdicts(out: ChainOutput): Verdicts {
	const gate = new VoiceActivityGate()
	const meter = new VoiceOnAirMeter()
	const bank = new CtcssBank()
	const evidence = new ToneClassEvidence()
	let latch: number | null = null
	const onAir: number[] = []
	const blocks: number[] = []
	const chunk = 800
	for (let at = 0; at < out.pcm.length; at += chunk) {
		const end = Math.min(out.pcm.length, at + chunk)
		for (let i = at; i < end; i++) {
			const t = out.tone[i]!
			const before = bank.blockCount()
			bank.pushSample(t / 32_768)
			evidence.tone(bank, t)
			if (bank.blockCount() !== before) blocks.push(bank.lastBlockToneIndex())
		}
		evidence.speechRun(out.pcm, at, end, false)
		let k = at
		if (!gate.voiced) {
			k += gate.push(out.pcm, at, end)
			if (gate.voiced) latch = k
		}
		if (gate.voiced && k < end) onAir.push(meter.push(out.pcm, k, end))
	}
	return {
		frames: out.pcm.length,
		gateVoiced: gate.voiced,
		gateLatchFrame: latch,
		gateConcluded: gate.conclude(),
		onAir,
		ctcssHz: bank.result(),
		ctcssBlocks: blocks,
		toneClassHz: evidence.result(),
		speech: evidence.speechCounts,
		toneCanHold: evidence.toneCanHold(),
	}
}

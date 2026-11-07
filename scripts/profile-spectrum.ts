/**
 * Offline spectrum worker profile (measurement only, never a CI gate).
 *
 *   node scripts/profile-spectrum-build.mjs
 *   nice -n 10 node output/bench/profile-spectrum.mjs [--seconds 30] [--rate 2400000]
 *     [--fft auto|<n>] [--overlap 0|0.5] [--feed on|off] [--mode stages|bare|proto]
 *     [--wire] [--iq <path.cu8>] [--json] [--path js|wasm] [--wasm <spectrum-frame.wasm>]
 *
 * Drives a real SpectrumPipeline (no worker thread) as fast as it will go with
 * seeded synthetic CU8: Gaussian noise, CW and NFM carriers and Mode-S-like PPM
 * bursts. No socket, no state dir, nothing written.
 *
 * Clocks: wall is `performance.now()`; CPU is `process.threadCpuUsage()`, this thread's user + system
 * time, the same kind of figure the passive guard reads through `worker.cpuUsage()`. Compare CPU with
 * `frame_path_bench`; wall also holds any preemption, so it swings with host load.
 *
 * Modes:
 * - `stages`: wraps the prototype methods of every pipeline stage in the harness
 *   (self time on a call stack, so nested stages are not double counted) and turns
 *   on the pipeline's own opt-in profile as a cross check. Block summaries are
 *   wire-encoded and structured-cloned (the postMessage copy), then decoded and
 *   observed by an OccupancyHistory like the main thread does. Both clocks are read around every
 *   wrapped call. A CPU read is far from free (microseconds on macOS), so the calibrated cost of the
 *   reads each stage holds is taken off its self time; `handle()` itself stays raw and inflated, so
 *   take the total from `bare` and only the shares from here.
 * - `bare`: no wrapping and no profile; one pair of clocks around each handle(). Use this
 *   for the total and under `node --cpu-prof`. `--wire` adds the worker's encode and postMessage copy
 *   of each event batch, clocked apart, without the main-thread decode.
 * - `proto`: FFT prototypes (Float32 tables, radix-4, real-input pair) on the
 *   same frames, against the production Fft. Wall clock only.
 *
 * `--iq` reads a private capture for an offline run; report only aggregate CPU.
 *
 * `--path wasm` runs the frame path in the wasm kernel (src/core/spectrum/frame-wasm.ts) as the
 * worker does when dist/spectrum-frame.wasm is present (`--wasm` names another file); the default
 * `js` is the JS frame path. Build the kernel with native/wavekit-frame/build.sh.
 */
import { readFileSync } from "node:fs"
import os from "node:os"
import { performance } from "node:perf_hooks"
import process from "node:process"
import { ScannerConfigSchema } from "../src/config.js"
import { Detector } from "../src/core/spectrum/detector.js"
import { Tracker } from "../src/core/spectrum/emissions/tracker.js"
import {
	Fft,
	accumulateShiftedPower,
	defaultFftSize,
	powerToDb,
} from "../src/core/spectrum/fft.js"
import { FrameSource } from "../src/core/spectrum/frame-source.js"
import { ImpulseBlanker } from "../src/core/spectrum/impulse-blanker.js"
import { NoiseFloor } from "../src/core/spectrum/noise-floor.js"
import { OccupancyHistory } from "../src/core/spectrum/occupancy.js"
import {
	PIPELINE_PROFILE_STAGES,
	SpectrumPipeline,
	type PipelineProfile,
} from "../src/core/spectrum/pipeline.js"
import { ProvisionalSpurs } from "../src/core/spectrum/provisional-spurs.js"
import {
	DEFAULT_TUNING,
	USABLE_FRACTION,
	buildPipelineConfig,
} from "../src/core/spectrum/spectrum-engine.js"
import { SpurMap } from "../src/core/spectrum/spur-map.js"
import { loadFrameWasm } from "../src/core/spectrum/frame-wasm.js"
import type { FrameWasmModule } from "../src/core/spectrum/frame-wasm.js"
import { synthesizeCu8 } from "./profile-spectrum-iq.js"
import {
	decodeEventsFromWire,
	encodeEventsForWire,
} from "../src/core/spectrum/summary-wire.js"
import { WaveKitError } from "../src/utils/errors.js"
import type {
	BlockSummary,
	PipelineEvent,
	SpectrumSettings,
} from "../src/core/spectrum/types.js"

/** Synthetic centre: not a real allocation, only a frequency label for the RF maths. */
const CENTRE_HZ = 1_000_000_000
const CHUNK_BYTES = 131_072 // the engine's DEFAULT_BATCH_BYTES

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : undefined
}

function num(name: string, fallback: number): number {
	const v = Number(flag(name))
	return Number.isFinite(v) && v > 0 ? v : fallback
}

const SECONDS = num("seconds", 30)
const RATE = num("rate", 2_400_000)
const FFT_ARG = flag("fft") ?? "auto"
const OVERLAP = flag("overlap") === "0.5" ? 0.5 : 0
const FEED = flag("feed") !== "off"
const MODE = flag("mode") ?? "stages"
const IQ_PATH = flag("iq")
const JSON_OUT = process.argv.includes("--json")
const WIRE = process.argv.includes("--wire")
const FRAME_PATH = flag("path") === "wasm" ? "wasm" : "js"
const WASM_FILE = flag("wasm") ?? "dist/spectrum-frame.wasm"

function loadIq(): Uint8Array {
	if (IQ_PATH) {
		const buf = readFileSync(IQ_PATH)
		// Whole IQ pairs only: an odd trailing byte is dropped, and an empty corpus
		// would spin the chunk-fill loop forever.
		const max = Math.min(buf.length, Math.round(RATE * 2 * SECONDS)) & ~1
		if (max < 2)
			throw new WaveKitError(
				`--iq ${IQ_PATH} holds no complete IQ pair (${buf.length} bytes)`,
				"PROFILE_IQ",
			)
		return new Uint8Array(buf.buffer, buf.byteOffset, max)
	}
	return synthesizeCu8(RATE, Math.min(SECONDS, 4))
}

// ---- clocks ----

/** This thread's CPU time in ms. Per thread on Node 24: a spinning worker does not move another's. */
function cpuNow(): number {
	const u = process.threadCpuUsage()
	return (u.user + u.system) / 1000
}

/** What one CPU read costs on each clock, in ms, averaged over a burst of reads. */
function calibrateCpuRead(): { cpuMs: number; wallMs: number } {
	const reads = 20_000
	const cpu0 = cpuNow()
	const wall0 = performance.now()
	for (let i = 0; i < reads; i++) cpuNow()
	return {
		cpuMs: (cpuNow() - cpu0) / reads,
		wallMs: (performance.now() - wall0) / reads,
	}
}

let cpuRead = { cpuMs: 0, wallMs: 0 }

/** Worker work between two reads, on both clocks. */
class Span {
	wallMs = 0
	cpuMs = 0
	add(wall0: number, cpu0: number): void {
		const cpu1 = cpuNow()
		this.wallMs += performance.now() - wall0
		this.cpuMs += cpu1 - cpu0
	}
}

// ---- self-time accounting ----

const self = new Map<string, { wallMs: number; cpuMs: number }>()
const calls = new Map<string, number>()
const stack: {
	label: string
	wall0: number
	cpu0: number
	childWall: number
	childCpu: number
	children: number
}[] = []
let wrapping = false
/** Frame path labels: what a move out of the worker would take; every other label stays in JS. */
const FRAME_PATH_LABELS = new Set([
	"fft",
	"window + cu8 convert (FrameSource)",
	"impulse blanker",
	"power accumulate + block sum (onFrame inline)",
	"short path window (5 ms burst)",
	"frame tracks (Tracker.frame)",
])

function charge(label: string, wallMs: number, cpuMs: number): void {
	const row = self.get(label)
	if (row) {
		row.wallMs += wallMs
		row.cpuMs += cpuMs
	} else self.set(label, { wallMs, cpuMs })
}

type AnyFn = (this: unknown, ...args: unknown[]) => unknown

function wrapMethod(
	proto: Record<string, unknown>,
	name: string,
	label: string,
): void {
	const original = proto[name]
	if (typeof original !== "function") return
	const fn = original as AnyFn
	proto[name] = function (this: unknown, ...args: unknown[]): unknown {
		if (!wrapping) return fn.apply(this, args)
		const frame = {
			label,
			wall0: performance.now(),
			cpu0: 0,
			childWall: 0,
			childCpu: 0,
			children: 0,
		}
		stack.push(frame)
		frame.cpu0 = cpuNow()
		try {
			return fn.apply(this, args)
		} finally {
			const cpuTotal = cpuNow() - frame.cpu0
			const wallTotal = performance.now() - frame.wall0
			stack.pop()
			// This span holds one read of its own, and each child's span leaves one more read here.
			const reads = 1 + frame.children
			charge(
				label,
				wallTotal - frame.childWall - reads * cpuRead.wallMs,
				cpuTotal - frame.childCpu - reads * cpuRead.cpuMs,
			)
			calls.set(label, (calls.get(label) ?? 0) + 1)
			const parent = stack[stack.length - 1]
			if (parent) {
				parent.childWall += wallTotal
				parent.childCpu += cpuTotal
				parent.children++
			}
		}
	}
}

function wrapClass(
	cls: { prototype: object },
	label: string,
	only?: readonly string[],
): void {
	const proto = cls.prototype as Record<string, unknown>
	for (const name of Object.getOwnPropertyNames(proto)) {
		if (name === "constructor") continue
		if (only && !only.includes(name)) continue
		const d = Object.getOwnPropertyDescriptor(proto, name)
		if (!d || typeof d.value !== "function") continue
		wrapMethod(proto, name, label)
	}
}

/** Private pipeline methods by stage. Anything unlisted stays in its caller's self time. */
const PIPELINE_METHODS: Record<string, string> = {
	handle: "pipeline other (handle/dispatch)",
	onFrame: "power accumulate + block sum (onFrame inline)",
	shortFrame: "short path window (5 ms burst)",
	resumShort: "short path window (5 ms burst)",
	resetShort: "short path window (5 ms burst)",
	finishBlockWork: "block finalize inline (powerToDb, segment, masks)",
	resetBlock: "block finalize inline (powerToDb, segment, masks)",
	mergeBursts: "burst merge",
	mergedPower: "burst merge",
	withoutLines: "provisional spurs / lines",
	observeLines: "provisional spurs / lines",
	applyChannelGate: "channel gate",
	prepareGate: "channel gate",
	interruptGate: "channel gate",
	openGate: "channel gate",
	fillGateMask: "channel gate",
	summary: "summary build (bins + tracks)",
	frameAssociation: "summary build (bins + tracks)",
	emitWithImages: "emissions: iq-image + events",
	emit: "emissions: iq-image + events",
	persistentFeatures: "retune alarm / classify",
	classify: "retune alarm / classify",
	isStale: "retune alarm / classify",
	segmentRf: "retune alarm / classify",
	noteActivity: "activity mask",
	widebandSegment: "emissions tracker (block)",
	maybeStats: "pipeline other (handle/dispatch)",
}

function installWraps(): void {
	wrapClass(Fft, "fft")
	wrapClass(FrameSource, "window + cu8 convert (FrameSource)")
	wrapClass(ImpulseBlanker, "impulse blanker")
	wrapClass(NoiseFloor, "noise floor")
	wrapClass(SpurMap, "spur map")
	wrapClass(ProvisionalSpurs, "provisional spurs / lines")
	// Entry points only. Their helpers run about 145 000 calls/s (flushEnvelope, kFor and such), and a
	// wrap around each costs far more than the helper, so they stay in their caller's self time.
	wrapClass(Detector, "detector (CFAR)", [
		"detect",
		"setCfarRanges",
		"setMasks",
	])
	wrapClass(Tracker, "frame tracks (Tracker.frame)", ["frame"])
	wrapClass(Tracker, "emissions tracker (block)", [
		"block",
		"associationOf",
		"trackBinsMask",
		"longLived",
		"openCandidates",
		"flagSpurs",
		"snapshotOf",
		"publishGate",
	])
	const proto = SpectrumPipeline.prototype as unknown as Record<string, unknown>
	for (const [name, label] of Object.entries(PIPELINE_METHODS))
		wrapMethod(proto, name, label)
}

// ---- run ----

interface RunResult {
	wallMs: number
	/** Whole loop on this thread, the chunk copies included. */
	loopCpuMs: number
	handle: Span
	frames: number
	blocks: number
	summaries: number
	iqSeconds: number
	encode: Span
	clone: Span
	decode: Span
	occupancy: Span
	openTracksPerChunk: number
	openBinsPerChunk: number
	profile: PipelineProfile | null
}

/** Open, unfrozen tracks and their bins right now, to size the Rust Tracker.frame stand-in. */
function openTracks(pipeline: SpectrumPipeline): {
	tracks: number
	bins: number
} {
	const tracker = (
		pipeline as unknown as {
			tracker: {
				open: Iterable<{ frozen: boolean; startBin: number; endBin: number }>
			}
		}
	).tracker
	let tracks = 0
	let bins = 0
	for (const t of tracker.open) {
		if (t.frozen) continue
		tracks++
		bins += t.endBin - t.startBin
	}
	return { tracks, bins }
}

function settings(): SpectrumSettings {
	return ScannerConfigSchema.parse({}) as unknown as SpectrumSettings
}

function run(iq: Uint8Array): RunResult {
	const s = settings()
	const fftSize = FFT_ARG === "auto" ? null : Number(FFT_ARG)
	const base = buildPipelineConfig("bench", "U8_IQ", RATE, s, {
		...DEFAULT_TUNING,
		fftSize,
	})
	const cfg = { ...base, overlap: OVERLAP as 0 | 0.5 }
	let frameWasm: FrameWasmModule | null = null
	if (FRAME_PATH === "wasm") {
		const load = loadFrameWasm(WASM_FILE)
		if (!load.ok)
			throw new WaveKitError(`--path wasm: ${load.reason}`, "PROFILE_WASM")
		frameWasm = load.module
	}
	const pipeline = new SpectrumPipeline(cfg, {
		...(MODE === "stages" ? { profile: { sampleEvery: 1 } } : {}),
		frameWasm,
	})
	if (pipeline.framePath.path !== FRAME_PATH)
		throw new WaveKitError(
			`frame path ${pipeline.framePath.path}: ${pipeline.framePath.reason}`,
			"PROFILE_WASM",
		)
	const occupancy = new OccupancyHistory()
	const half = (RATE * USABLE_FRACTION) / 2
	pipeline.handle({
		kind: "new-stream",
		stream: 1,
		centreHz: CENTRE_HZ,
		sampleRateHz: RATE,
		gainKey: "bench",
		tuningTrust: "commanded",
	})
	pipeline.handle({ kind: "spectrum-feed", enabled: FEED })
	const totalBytes = Math.round(RATE * 2 * SECONDS) & ~1
	const handleSpan = new Span()
	const encode = new Span()
	const clone = new Span()
	const decode = new Span()
	const occupancyUse = new Span()
	let trackSamples = 0
	let openTrackSum = 0
	let openBinSum = 0
	let blocks = 0
	let summaries = 0
	let sample = 0
	let offset = 0
	const chunk = new Uint8Array(CHUNK_BYTES)
	cpuRead = calibrateCpuRead()
	wrapping = MODE === "stages"
	const wall0 = performance.now()
	const loopCpu0 = cpuNow()
	for (let done = 0; done < totalBytes; done += CHUNK_BYTES) {
		const len = Math.min(CHUNK_BYTES, totalBytes - done)
		for (let w = 0; w < len; ) {
			const take = Math.min(len - w, iq.length - offset)
			chunk.set(iq.subarray(offset, offset + take), w)
			w += take
			offset = (offset + take) % iq.length
		}
		const bytes = len === CHUNK_BYTES ? chunk : chunk.subarray(0, len)
		const t0 = performance.now()
		const c0 = cpuNow()
		const events = pipeline.handle({
			kind: "bytes",
			startSample: sample,
			bytes,
		})
		handleSpan.add(t0, c0)
		sample += len / 2
		if (MODE === "stages") {
			const open = openTracks(pipeline)
			trackSamples++
			openTrackSum += open.tracks
			openBinSum += open.bins
		}
		if (events.length === 0) continue
		for (const ev of events) {
			if (ev.kind === "block-summary") summaries++
			if (ev.kind === "block-summary" || ev.kind === "stale-discard") blocks++
		}
		if (MODE !== "stages" && !WIRE) continue
		let t = performance.now()
		let c = cpuNow()
		const transfer: ArrayBuffer[] = []
		encodeEventsForWire(events, transfer)
		encode.add(t, c)
		t = performance.now()
		c = cpuNow()
		const copy = structuredClone(events) as PipelineEvent[]
		clone.add(t, c)
		if (MODE !== "stages") continue
		t = performance.now()
		c = cpuNow()
		decodeEventsFromWire(copy)
		decode.add(t, c)
		t = performance.now()
		c = cpuNow()
		for (const ev of copy) {
			if (ev.kind !== "block-summary") continue
			const sum: BlockSummary = ev.summary
			if (sum.overload) continue
			occupancy.observe(
				Date.now(),
				{ startHz: sum.centreHz - half, endHz: sum.centreHz + half },
				sum.tracks,
				cfg.integrationMs,
			)
		}
		occupancyUse.add(t, c)
	}
	const loopCpuMs = cpuNow() - loopCpu0
	const wallMs = performance.now() - wall0
	wrapping = false
	const state = pipeline.exportEngineState() as { profile?: PipelineProfile }
	const n = cfg.fftSize
	return {
		wallMs,
		loopCpuMs,
		handle: handleSpan,
		frames: Math.floor(sample / (n * (1 - OVERLAP))),
		blocks,
		summaries,
		iqSeconds: sample / RATE,
		encode,
		clone,
		decode,
		occupancy: occupancyUse,
		openTracksPerChunk: openTrackSum / Math.max(1, trackSamples),
		openBinsPerChunk: openBinSum / Math.max(1, trackSamples),
		profile: state.profile ?? null,
	}
}

// ---- FFT prototypes ----

/** Production algorithm, Float32 twiddles (V8 still computes in f64; only memory traffic changes). */
class Fft32 {
	private readonly cos: Float32Array
	private readonly sin: Float32Array
	private readonly rev: Uint32Array
	constructor(readonly size: number) {
		const half = size >> 1
		this.cos = new Float32Array(half)
		this.sin = new Float32Array(half)
		for (let k = 0; k < half; k++) {
			this.cos[k] = Math.cos((2 * Math.PI * k) / size)
			this.sin[k] = -Math.sin((2 * Math.PI * k) / size)
		}
		this.rev = bitReverse(size)
	}
	transform(re: Float32Array, im: Float32Array): void {
		const n = this.size
		const rev = this.rev
		for (let i = 0; i < n; i++) {
			const j = rev[i]!
			if (j > i) {
				const tr = re[i]!
				re[i] = re[j]!
				re[j] = tr
				const ti = im[i]!
				im[i] = im[j]!
				im[j] = ti
			}
		}
		for (let len = 2; len <= n; len <<= 1) {
			const h = len >> 1
			const step = n / len
			for (let s = 0; s < n; s += len) {
				for (let j = 0, k = 0; j < h; j++, k += step) {
					const wr = this.cos[k]!
					const wi = this.sin[k]!
					const a = s + j
					const b = a + h
					const br = re[b]!
					const bi = im[b]!
					const xr = br * wr - bi * wi
					const xi = br * wi + bi * wr
					const ar = re[a]!
					const ai = im[a]!
					re[b] = ar - xr
					im[b] = ai - xi
					re[a] = ar + xr
					im[a] = ai + xi
				}
			}
		}
	}
}

function bitReverse(size: number): Uint32Array {
	const bits = 31 - Math.clz32(size)
	const rev = new Uint32Array(size)
	for (let i = 0; i < size; i++) {
		let r = 0
		for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b)
		rev[i] = r
	}
	return rev
}

/**
 * Radix-2 with the first two stages fused (trivial twiddles ±1, ±j) and per-stage
 * contiguous twiddle tables (no strided `k += step` reads).
 */
class FftFused {
	private readonly rev: Uint32Array
	/** Per stage len ≥ 8: twiddles for j = 0..len/2−1, interleaved re/im, stages concatenated. */
	private readonly tw: Float64Array
	constructor(readonly size: number) {
		this.rev = bitReverse(size)
		let total = 0
		for (let len = 8; len <= size; len <<= 1) total += len
		this.tw = new Float64Array(Math.max(2, total))
		let o = 0
		for (let len = 8; len <= size; len <<= 1) {
			for (let j = 0; j < len >> 1; j++) {
				this.tw[o++] = Math.cos((2 * Math.PI * j) / len)
				this.tw[o++] = -Math.sin((2 * Math.PI * j) / len)
			}
		}
	}
	transform(re: Float32Array, im: Float32Array): void {
		const n = this.size
		const rev = this.rev
		for (let i = 0; i < n; i++) {
			const j = rev[i]!
			if (j > i) {
				const tr = re[i]!
				re[i] = re[j]!
				re[j] = tr
				const ti = im[i]!
				im[i] = im[j]!
				im[j] = ti
			}
		}
		// stages len 2 and 4 fused: a 4-point DFT per group
		for (let s = 0; s < n; s += 4) {
			const r0 = re[s]!
			const i0 = im[s]!
			const r1 = re[s + 1]!
			const i1 = im[s + 1]!
			const r2 = re[s + 2]!
			const i2 = im[s + 2]!
			const r3 = re[s + 3]!
			const i3 = im[s + 3]!
			const ar = r0 + r1
			const ai = i0 + i1
			const br = r0 - r1
			const bi = i0 - i1
			const cr = r2 + r3
			const ci = i2 + i3
			const dr = r2 - r3
			const di = i2 - i3
			re[s] = ar + cr
			im[s] = ai + ci
			re[s + 2] = ar - cr
			im[s + 2] = ai - ci
			// (dr + j di)·(−j) = di − j dr
			re[s + 1] = br + di
			im[s + 1] = bi - dr
			re[s + 3] = br - di
			im[s + 3] = bi + dr
		}
		const tw = this.tw
		let o = 0
		for (let len = 8; len <= n; len <<= 1) {
			const h = len >> 1
			for (let s = 0; s < n; s += len) {
				for (let j = 0; j < h; j++) {
					const wr = tw[o + 2 * j]!
					const wi = tw[o + 2 * j + 1]!
					const a = s + j
					const b = a + h
					const br = re[b]!
					const bi = im[b]!
					const xr = br * wr - bi * wi
					const xi = br * wi + bi * wr
					const ar = re[a]!
					const ai = im[a]!
					re[b] = ar - xr
					im[b] = ai - xi
					re[a] = ar + xr
					im[a] = ai + xi
				}
			}
			o += len
		}
	}
}

const LOG_VIEW = new Float32Array(1)
const LOG_BITS = new Int32Array(LOG_VIEW.buffer)
const DB_PER_LOG2 = 10 * Math.LOG10E * Math.LN2

/** powerToDb with a bit-trick log2 (degree-4 mantissa polynomial, < 0.001 dB error). */
function powerToDbFast(
	acc: Float64Array,
	frames: number,
	out: Float32Array,
): void {
	const n = acc.length
	const scale = 1 / (Math.max(1, frames) * (n / 2) * (n / 2))
	for (let i = 0; i < n; i++) {
		const p = acc[i]! * scale
		if (!(p > 1e-20)) {
			out[i] = -200
			continue
		}
		LOG_VIEW[0] = p
		const bits = LOG_BITS[0]!
		const e = ((bits >> 23) & 255) - 127
		LOG_BITS[0] = (bits & 0x007fffff) | 0x3f800000
		const m = LOG_VIEW[0]! - 1
		// log2(1 + m), m in [0, 1)
		const l =
			m *
			(1.4425449 +
				m *
					(-0.7181452 +
						m *
							(0.4575485 +
								m * (-0.2779042 + m * 0.121797 - 0.0258411 * m * m))))
		out[i] = Math.max(-200, (e + l) * DB_PER_LOG2)
	}
}

function dbRun(
	iq: Uint8Array,
	n: number,
	frames: number,
): Record<string, number> {
	const fft = new Fft(n)
	const re = new Float32Array(n)
	const im = new Float32Array(n)
	const acc = new Float64Array(n)
	const a = new Float32Array(n)
	const b = new Float32Array(n)
	let slow = 0
	let fast = 0
	let accum = 0
	let err = 0
	for (let f = 0; f < frames; f++) {
		const base = ((f * n) % Math.floor(iq.length / 2 - n)) * 2
		for (let i = 0; i < n; i++) {
			re[i] = ((iq[base + 2 * i] ?? 127) - 127.5) / 127.5
			im[i] = ((iq[base + 2 * i + 1] ?? 127) - 127.5) / 127.5
		}
		fft.transform(re, im)
		let t = performance.now()
		acc.fill(0)
		accumulateShiftedPower(re, im, acc)
		accum += performance.now() - t
		t = performance.now()
		powerToDb(acc, 1, a)
		slow += performance.now() - t
		t = performance.now()
		powerToDbFast(acc, 1, b)
		fast += performance.now() - t
		if (f % 97 === 0)
			for (let i = 0; i < n; i++)
				if ((a[i] ?? 0) > -199)
					err = Math.max(err, Math.abs((a[i] ?? 0) - (b[i] ?? 0)))
	}
	return {
		"accumulateShiftedPower+fill msPerSecIq": accum / SECONDS,
		"powerToDb (Math.log10) msPerSecIq per pass": slow / SECONDS,
		"powerToDb fast log2 msPerSecIq per pass": fast / SECONDS,
		"powerToDb fast maxAbsErr dB": err,
	}
}

function protoRun(iq: Uint8Array): Record<string, number> {
	const n =
		FFT_ARG === "auto" ? defaultFftSize(RATE) : Math.max(2, Number(FFT_ARG))
	const frames = Math.floor((RATE * SECONDS) / n)
	const re = new Float32Array(n)
	const im = new Float32Array(n)
	const fill = (f: number): void => {
		const base = ((f * n) % Math.floor(iq.length / 2 - n)) * 2
		for (let i = 0; i < n; i++) {
			re[i] = ((iq[base + 2 * i] ?? 127) - 127.5) / 127.5
			im[i] = ((iq[base + 2 * i + 1] ?? 127) - 127.5) / 127.5
		}
	}
	const variants: [
		string,
		{ transform: (r: Float32Array, i: Float32Array) => void },
	][] = [
		["production Fft (f64 tables)", new Fft(n)],
		["f32 tables", new Fft32(n)],
		["fused r4 first stages + contiguous twiddles", new FftFused(n)],
	]
	// correctness: same input, max abs difference vs production
	const ref = new Fft(n)
	const r0 = new Float32Array(n)
	const i0 = new Float32Array(n)
	fill(3)
	r0.set(re)
	i0.set(im)
	ref.transform(r0, i0)
	const out: Record<string, number> = {}
	for (const [name, v] of variants) {
		fill(3)
		v.transform(re, im)
		let err = 0
		for (let i = 0; i < n; i++)
			err = Math.max(
				err,
				Math.abs((re[i] ?? 0) - (r0[i] ?? 0)),
				Math.abs((im[i] ?? 0) - (i0[i] ?? 0)),
			)
		out[`${name} maxAbsErr`] = err
		// warm
		for (let f = 0; f < 200; f++) {
			fill(f)
			v.transform(re, im)
		}
		let fftMs = 0
		for (let f = 0; f < frames; f++) {
			fill(f)
			const t0 = performance.now()
			v.transform(re, im)
			fftMs += performance.now() - t0
		}
		out[`${name} msPerSecIq`] = fftMs / SECONDS
		out[`${name} usPerFrame`] = (fftMs * 1000) / frames
	}
	return { ...out, ...dbRun(iq, n, frames) }
}

// ---- report ----

function fmt(v: number, d = 1): string {
	return v.toFixed(d)
}

function main(): void {
	const iq = loadIq()
	const load = os.loadavg().map(v => v.toFixed(1))
	if (MODE === "proto") {
		const out = protoRun(iq)
		const end = os.loadavg().map(v => v.toFixed(1))
		if (JSON_OUT) {
			process.stdout.write(`${JSON.stringify({ load, end, out })}\n`)
			return
		}
		process.stdout.write(
			`FFT prototypes (wall clock), ${RATE} S/s, ${SECONDS} s, load ${load.join(" ")} -> ${end.join(" ")}\n`,
		)
		for (const [k, v] of Object.entries(out))
			process.stdout.write(`  ${k.padEnd(60)} ${v.toPrecision(4)}\n`)
		return
	}
	if (MODE === "stages") installWraps()
	const r = run(iq)
	const end = os.loadavg().map(v => v.toFixed(1))
	const perSec = (ms: number): number => ms / r.iqSeconds
	const perFrame = (ms: number): number => (ms * 1000) / Math.max(1, r.frames)
	const head =
		`spectrum pipeline ${MODE}, frame path ${FRAME_PATH}, ${RATE} S/s, fft ${FFT_ARG}, overlap ${OVERLAP}, feed ${FEED ? "on" : "off"}, ` +
		`${fmt(r.iqSeconds)} s IQ${IQ_PATH ? " (capture)" : " (synthetic)"}, load ${load.join(" ")} -> ${end.join(" ")}`
	const rows: [string, { wallMs: number; cpuMs: number }][] = []
	if (MODE === "stages") {
		for (const [k, v] of self) rows.push([k, v])
		rows.push(["wire encode (encodeEventsForWire)", r.encode])
		rows.push(["postMessage copy (structuredClone)", r.clone])
		rows.push(["[main] wire decode", r.decode])
		rows.push(["[main] occupancy observe", r.occupancy])
		rows.sort((a, b) => b[1].cpuMs - a[1].cpuMs)
	}
	if (JSON_OUT) {
		process.stdout.write(
			`${JSON.stringify({ head, cpuRead, ...r, rows, calls: Object.fromEntries(calls) })}\n`,
		)
		return
	}
	process.stdout.write(`${head}\n`)
	process.stdout.write(
		`frames ${r.frames} (${fmt(r.frames / r.iqSeconds)}/s), blocks ${r.blocks} (${fmt(r.blocks / r.iqSeconds)}/s), summaries ${r.summaries}\n`,
	)
	process.stdout.write(
		`handle() total: ${fmt(perSec(r.handle.cpuMs))} thread-CPU-ms per s IQ (${fmt(perSec(r.handle.cpuMs) / 1000, 3)} core), ${fmt(perSec(r.handle.wallMs))} wall-ms per s IQ; ${fmt(perFrame(r.handle.cpuMs), 2)} CPU-µs/frame${MODE === "stages" ? " (raw, wrap overhead inside; take totals from bare)" : ""}\n`,
	)
	process.stdout.write(
		`loop thread CPU, chunk copies included: ${fmt(perSec(r.loopCpuMs))} ms per s IQ; wall ${fmt(perSec(r.wallMs))} ms per s IQ\n`,
	)
	if (WIRE && MODE !== "stages")
		process.stdout.write(
			`wire: encode ${fmt(perSec(r.encode.cpuMs), 2)} + postMessage copy ${fmt(perSec(r.clone.cpuMs), 2)} thread-CPU-ms per s IQ; handle + wire ${fmt(perSec(r.handle.cpuMs + r.encode.cpuMs + r.clone.cpuMs))}\n`,
		)
	if (MODE !== "stages") return
	process.stdout.write(
		`thread-clock read ${fmt(cpuRead.cpuMs * 1000, 2)} CPU-µs, taken off each stage per read; ${fmt(r.openTracksPerChunk, 2)} open tracks, ${fmt(r.openBinsPerChunk)} open bins (mean per chunk)\n`,
	)
	process.stdout.write(
		`\n${"stage (self time, clock reads removed)".padEnd(52)} ${"CPU µs/frame".padStart(12)} ${"CPU ms/s IQ".padStart(11)} ${"wall ms/s IQ".padStart(12)} ${"CPU %".padStart(6)} ${"calls/s".padStart(9)}\n`,
	)
	let workerCpu = 0
	let framePathCpu = 0
	for (const [k, v] of rows) {
		if (k.startsWith("[main]")) continue
		workerCpu += v.cpuMs
		if (FRAME_PATH_LABELS.has(k)) framePathCpu += v.cpuMs
	}
	for (const [k, v] of rows) {
		const c = calls.get(k)
		process.stdout.write(
			`${k.padEnd(52)} ${fmt(perFrame(v.cpuMs), 2).padStart(12)} ${fmt(perSec(v.cpuMs), 2).padStart(11)} ${fmt(perSec(v.wallMs), 2).padStart(12)} ${fmt((100 * v.cpuMs) / workerCpu).padStart(6)} ${(c === undefined ? "" : fmt(c / r.iqSeconds, 0)).padStart(9)}\n`,
		)
	}
	process.stdout.write(
		`worker self CPU, clock reads removed (handle + encode + clone) ${fmt(perSec(workerCpu))} ms/s IQ; frame path ${fmt(perSec(framePathCpu))} (${fmt((100 * framePathCpu) / workerCpu)} %), other stages ${fmt(perSec(workerCpu - framePathCpu))} (${fmt((100 * (workerCpu - framePathCpu)) / workerCpu)} %). Wrap closures remain inside these numbers\n`,
	)
	const p = r.profile
	if (p) {
		process.stdout.write(
			`\nbuilt-in pipeline profile (inclusive spans, wall clock): blocks ${p.blocks}, busy ${fmt(perSec(p.busyMs))} ms/s IQ\n`,
		)
		for (const st of PIPELINE_PROFILE_STAGES)
			process.stdout.write(
				`  ${st.padEnd(10)} ${fmt(perSec(p.stages[st]), 2).padStart(9)} ms/s IQ\n`,
			)
	}
}

main()

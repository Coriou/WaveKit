/**
 * Offline bench of the Rust spectrum frame path compiled to wasm32 (measurement only, never a CI
 * gate). Runs native/wavekit-chan/examples/frame_path_wasm in a worker thread and the native
 * `frame_path_bench` alternately on one IQ scene, on each thread's CPU clock. See scripts/README.md
 * for the build.
 *
 *   node scripts/profile-spectrum-build.mjs
 *   nice -n 10 node output/bench/profile-frame-path-wasm.mjs --wasm <file.wasm> [--native <bin>]
 *     [--seconds 30] [--rate 2400000] [--prec f64|f32] [--overlap 0|0.5] [--rounds 3]
 *     [--tracks 0] [--track-bins 0] [--thread worker|main] [--iq <path.cu8>] [--agree-frames 400]
 *
 * The boundary is the one a worker would use: one call per chunk, the chunk copied into linear
 * memory, each finished block's flat arrays copied back into preallocated typed arrays. The copy in,
 * the call and the copy out are clocked apart. The scene is `synthesizeCu8` unless `--iq` is given,
 * the same one scripts/profile-spectrum.ts uses. Nothing else is read or written, and no socket is
 * opened; the scene file for the native run lives in a tmp dir removed at the end.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import process from "node:process"
import { fileURLToPath } from "node:url"
import {
	Worker,
	isMainThread,
	parentPort,
	workerData,
} from "node:worker_threads"
import {
	Fft,
	accumulateShiftedPower,
	defaultFftSize,
} from "../src/core/spectrum/fft.js"
import { FrameSource } from "../src/core/spectrum/frame-source.js"
import { WaveKitError } from "../src/utils/errors.js"
import { synthesizeCu8 } from "./profile-spectrum-iq.js"

const CHUNK_BYTES = 131_072 // the engine's DEFAULT_BATCH_BYTES
const WARM_SECONDS = 3
const STAGE_NAMES = [
	"scan",
	"convert",
	"fft",
	"power",
	"short",
	"tracks",
	"finish",
] as const

/** The global, which this project's lib set declares only as a type namespace. */
const Wasm = (
	globalThis as unknown as {
		WebAssembly: {
			Module: new (bytes: Uint8Array) => object
			Instance: new (
				module: object,
				imports: { env: { thread_cpu_ns: () => number } },
			) => { exports: unknown }
		}
	}
).WebAssembly

interface FramePathExports {
	memory: { buffer: ArrayBuffer }
	fp_new(
		prec: number,
		rate: number,
		halfOverlap: number,
		tracks: number,
		trackBins: number,
		chunkBytes: number,
	): void
	fp_input(): number
	fp_frame_input(): number
	fp_chunk(len: number, staged: number): number
	fp_block(index: number): number
	fp_stage(i: number): number
	fp_counter(i: number): number
	fp_reset_stats(): void
	fp_clock_read_ns(reads: number): number
	fp_frame_power(): number
}

interface WasmRunConfig {
	wasmPath: string
	scenePath: string
	prec: "f32" | "f64"
	rate: number
	overlap: 0 | 0.5
	seconds: number
	tracks: number
	trackBins: number
}

interface WasmRunResult {
	startup: {
		compileWallMs: number
		compileThreadCpuMs: number
		compileProcessCpuMs: number
		instantiateWallMs: number
		pathNewThreadCpuMs: number
		firstSecondCpuMs: number
		warmCpuMsPerSec: number
		/** Process CPU beyond this thread over the warm-up: mostly V8's background tier-up. */
		warmOtherThreadsCpuMs: number
		memoryBytes: number
	}
	readNs: number
	copyInMsPerSec: number
	callMsPerSec: number
	copyOutMsPerSec: number
	totalMsPerSec: number
	frames: number
	blocks: number
	blanked: number
	stages: Record<string, number>
}

function threadCpuMs(): number {
	const u = process.threadCpuUsage()
	return (u.user + u.system) / 1000
}

function processCpuMs(): number {
	const u = process.cpuUsage()
	return (u.user + u.system) / 1000
}

function load1(): string {
	return (os.loadavg()[0] ?? 0).toFixed(1)
}

// ---- wasm run (worker thread by default) ----

function runWasm(cfg: WasmRunConfig): WasmRunResult {
	const bytes = readFileSync(cfg.wasmPath)
	const iq = readFileSync(cfg.scenePath)
	const compileWall0 = performance.now()
	const compileCpu0 = threadCpuMs()
	const compileProc0 = processCpuMs()
	const module = new Wasm.Module(bytes)
	const compileWallMs = performance.now() - compileWall0
	const compileThreadCpuMs = threadCpuMs() - compileCpu0
	const compileProcessCpuMs = processCpuMs() - compileProc0
	const instWall0 = performance.now()
	const instance = new Wasm.Instance(module, {
		env: { thread_cpu_ns: () => threadCpuMs() * 1e6 },
	})
	const instantiateWallMs = performance.now() - instWall0
	const x = instance.exports as unknown as FramePathExports
	const newCpu0 = threadCpuMs()
	x.fp_new(
		cfg.prec === "f32" ? 32 : 64,
		cfg.rate,
		cfg.overlap === 0.5 ? 1 : 0,
		cfg.tracks,
		cfg.trackBins,
		CHUNK_BYTES,
	)
	const pathNewThreadCpuMs = threadCpuMs() - newCpu0
	const inputPtr = x.fp_input()

	const n = defaultFftSize(cfg.rate)
	const outAcc = new Float64Array(n)
	const outFloor = new Float32Array(n)
	const outPeak = new Float64Array(n)
	const outCount = new Uint8Array(n)
	let outEnv = new Float64Array(0)
	let offset = 0

	const feed = (totalBytes: number, staged: number) => {
		let copyIn = 0
		let call = 0
		let copyOut = 0
		let reads = 0
		for (let done = 0; done + CHUNK_BYTES <= totalBytes; done += CHUNK_BYTES) {
			const t0 = threadCpuMs()
			const input = new Uint8Array(x.memory.buffer, inputPtr, CHUNK_BYTES)
			for (let w = 0; w < CHUNK_BYTES; ) {
				const take = Math.min(CHUNK_BYTES - w, iq.length - offset)
				input.set(iq.subarray(offset, offset + take), w)
				w += take
				offset = (offset + take) % iq.length
			}
			const t1 = threadCpuMs()
			const blocks = x.fp_chunk(CHUNK_BYTES, staged)
			const t2 = threadCpuMs()
			reads += 3
			copyIn += t1 - t0
			call += t2 - t1
			if (blocks === 0) continue
			const buf = x.memory.buffer
			for (let b = 0; b < blocks; b++) {
				const table = new Uint32Array(buf, x.fp_block(b), 9)
				outAcc.set(new Float64Array(buf, table[0]!, n))
				outFloor.set(new Float32Array(buf, table[1]!, n))
				outPeak.set(new Float64Array(buf, table[2]!, n))
				outCount.set(new Uint8Array(buf, table[3]!, n))
				const envLength = cfg.tracks * table[5]!
				if (outEnv.length !== envLength) outEnv = new Float64Array(envLength)
				if (envLength > 0)
					outEnv.set(new Float64Array(buf, table[4]!, envLength))
			}
			copyOut += threadCpuMs() - t2
			reads += 1
		}
		return { copyIn, call, copyOut, reads }
	}

	const secondBytes = Math.round(cfg.rate * 2) & ~1
	const warmThread0 = threadCpuMs()
	const warmProcess0 = processCpuMs()
	const first = feed(secondBytes, 0)
	const firstSecondCpuMs = first.call
	const warm = feed(Math.max(0, WARM_SECONDS - 1) * secondBytes, 0)
	const warmCpuMsPerSec = warm.call / Math.max(1, WARM_SECONDS - 1)
	const warmOtherThreadsCpuMs =
		processCpuMs() - warmProcess0 - (threadCpuMs() - warmThread0)

	const readNs = x.fp_clock_read_ns(20_000)
	x.fp_reset_stats()
	const totalBytes = Math.round(cfg.rate * 2 * cfg.seconds) & ~1
	const steady = feed(totalBytes, 0)
	const chunks = x.fp_counter(0)
	const iqSeconds = (chunks * CHUNK_BYTES) / 2 / cfg.rate
	const frames = x.fp_counter(1)
	const blocks = x.fp_counter(2)
	const blanked = x.fp_counter(3)
	const perSec = (ms: number, intervals: number): number =>
		(ms - (intervals * readNs) / 1e6) / iqSeconds
	const copyInMsPerSec = perSec(steady.copyIn, chunks)
	const callMsPerSec = perSec(steady.call, chunks)
	const copyOutMsPerSec = perSec(steady.copyOut, blocks)

	x.fp_reset_stats()
	feed(totalBytes, 1)
	const stagedReadNs = x.fp_clock_read_ns(20_000)
	const stagedFrames = x.fp_counter(1)
	const stagedChunks = x.fp_counter(0)
	const stagedBlocks = x.fp_counter(2)
	const stagedSeconds = (stagedChunks * CHUNK_BYTES) / 2 / cfg.rate
	const stages: Record<string, number> = {}
	STAGE_NAMES.forEach((name, i) => {
		const intervals =
			name === "scan"
				? stagedChunks
				: name === "finish"
					? stagedBlocks
					: stagedFrames
		stages[name] =
			Math.max(0, x.fp_stage(i) - intervals * stagedReadNs) /
			1e6 /
			stagedSeconds
	})
	return {
		startup: {
			compileWallMs,
			compileThreadCpuMs,
			compileProcessCpuMs,
			instantiateWallMs,
			pathNewThreadCpuMs,
			firstSecondCpuMs,
			warmCpuMsPerSec,
			warmOtherThreadsCpuMs,
			memoryBytes: x.memory.buffer.byteLength,
		},
		readNs,
		copyInMsPerSec,
		callMsPerSec,
		copyOutMsPerSec,
		totalMsPerSec: copyInMsPerSec + callMsPerSec + copyOutMsPerSec,
		frames,
		blocks,
		blanked,
		stages,
	}
}

function runWasmOnThread(
	cfg: WasmRunConfig,
	thread: string,
): Promise<WasmRunResult> {
	if (thread === "main") return Promise.resolve(runWasm(cfg))
	return new Promise((resolve, reject) => {
		const worker = new Worker(fileURLToPath(import.meta.url), {
			workerData: cfg,
		})
		worker.once("message", (r: WasmRunResult) => resolve(r))
		worker.once("error", reject)
	})
}

// ---- agreement with the JS bins ----

/** The production JS frame powers of `frames` whole frames from the start of the scene. */
function jsPowers(iq: Uint8Array, n: number, frames: number): Float64Array {
	const source = new FrameSource({ format: "U8_IQ", fftSize: n })
	const fft = new Fft(n)
	const acc = new Float64Array(n)
	const out = new Float64Array(n * frames)
	let f = 0
	source.push(0, iq.subarray(0, n * 2 * frames))
	source.gap(n * frames, 0)
	source.drain(
		frame => {
			if (f >= frames) return
			fft.transform(frame.re, frame.im)
			acc.fill(0)
			accumulateShiftedPower(frame.re, frame.im, acc)
			out.set(acc, f * n)
			f++
		},
		() => undefined,
	)
	if (f !== frames)
		throw new WaveKitError(
			`scene gave ${f} frames, wanted ${frames}`,
			"PROFILE_IQ",
		)
	return out
}

interface Agreement {
	maxDb: number
	maxDbAtBaseDb: number
	maxDbAboveMinus100: number
}

function agreement(a: Float64Array, b: Float64Array, n: number): Agreement {
	const scale = 1 / ((n / 2) * (n / 2))
	let maxDb = 0
	let maxDbAtBaseDb = 0
	let maxDbAboveMinus100 = 0
	for (let i = 0; i < a.length; i++) {
		const x = a[i]! * scale
		const y = b[i]! * scale
		if (!(x > 0) || !(y > 0)) continue
		const dbX = 10 * Math.log10(x)
		const d = Math.abs(dbX - 10 * Math.log10(y))
		if (d > maxDb) {
			maxDb = d
			maxDbAtBaseDb = dbX
		}
		if (dbX > -100 && d > maxDbAboveMinus100) maxDbAboveMinus100 = d
	}
	return { maxDb, maxDbAtBaseDb, maxDbAboveMinus100 }
}

/** The wasm build's frame powers for the same frames, on this thread. */
function wasmPowers(
	wasmPath: string,
	prec: "f32" | "f64",
	rate: number,
	iq: Uint8Array,
	n: number,
	frames: number,
): Float64Array {
	const module = new Wasm.Module(readFileSync(wasmPath))
	const instance = new Wasm.Instance(module, {
		env: { thread_cpu_ns: () => threadCpuMs() * 1e6 },
	})
	const x = instance.exports as unknown as FramePathExports
	x.fp_new(prec === "f32" ? 32 : 64, rate, 0, 0, 0, CHUNK_BYTES)
	const inputPtr = x.fp_frame_input()
	const out = new Float64Array(n * frames)
	for (let f = 0; f < frames; f++) {
		new Uint8Array(x.memory.buffer, inputPtr, n * 2).set(
			iq.subarray(f * n * 2, (f + 1) * n * 2),
		)
		const p = x.fp_frame_power()
		out.set(new Float64Array(x.memory.buffer, p, n), f * n)
	}
	return out
}

function nativePowers(
	nativeBin: string,
	dir: string,
	scenePath: string,
	rate: number,
	frames: number,
): { f32: Float64Array; f64: Float64Array } {
	const r = spawnSync(
		nativeBin,
		["dump", dir, String(rate), scenePath, String(frames)],
		{ encoding: "utf8" },
	)
	if (r.status !== 0)
		throw new WaveKitError(`native dump failed: ${r.stderr}`, "PROFILE_NATIVE")
	const read = (name: string): Float64Array => {
		const b = readFileSync(path.join(dir, name))
		const copy = new ArrayBuffer(b.length)
		new Uint8Array(copy).set(b)
		return new Float64Array(copy)
	}
	return { f32: read("pow_f32.f64le"), f64: read("pow_f64.f64le") }
}

// ---- main ----

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : undefined
}

function num(name: string, fallback: number): number {
	const v = Number(flag(name))
	return Number.isFinite(v) && v >= 0 && flag(name) !== undefined ? v : fallback
}

function fmt(v: number, d = 1): string {
	return v.toFixed(d)
}

function stageLine(stages: Record<string, number>): string {
	return STAGE_NAMES.map(k => `${k} ${fmt(stages[k] ?? 0, 2)}`).join(" | ")
}

interface NativeResult {
	cpuMsPerSec: number
	readNs: number
	frames: number
	blocks: number
	blanked: number
	stages: Record<string, number>
}

function runNative(nativeBin: string, args: string[]): NativeResult {
	const r = spawnSync(nativeBin, args, { encoding: "utf8" })
	if (r.status !== 0)
		throw new WaveKitError(`native run failed: ${r.stderr}`, "PROFILE_NATIVE")
	const last = r.stdout.trim().split("\n").at(-1) ?? ""
	return JSON.parse(last) as NativeResult
}

async function main(): Promise<void> {
	const wasmPath = flag("wasm")
	if (!wasmPath)
		throw new WaveKitError("--wasm <file.wasm> is required", "PROFILE_ARGS")
	const nativeBin = flag("native")
	const rate = num("rate", 2_400_000)
	const seconds = num("seconds", 30)
	const rounds = num("rounds", 3)
	const prec = flag("prec") === "f32" ? "f32" : "f64"
	const overlap = flag("overlap") === "0.5" ? 0.5 : 0
	const tracks = num("tracks", 0)
	const trackBins = num("track-bins", 0)
	const thread = flag("thread") === "main" ? "main" : "worker"
	const agreeFrames = num("agree-frames", 400)
	const iqPath = flag("iq")
	const n = defaultFftSize(rate)

	const tmp = mkdtempSync(path.join(os.tmpdir(), "wk-frame-path-"))
	try {
		const scenePath = path.join(tmp, "scene.cu8")
		const iq = iqPath ? readFileSync(iqPath) : synthesizeCu8(rate, 4)
		writeFileSync(scenePath, iq)
		const wasmBytes = readFileSync(wasmPath).length
		process.stdout.write(
			`${path.basename(wasmPath)} ${wasmBytes} bytes, ${prec}, ${rate} S/s, N ${n}, overlap ${overlap}, tracks ${tracks}x${trackBins}, ${seconds} s IQ after ${WARM_SECONDS} s warm, thread ${thread}${iqPath ? ", scene from --iq" : ", scene synthesizeCu8"}; node ${process.version}\n`,
		)
		const cfg: WasmRunConfig = {
			wasmPath,
			scenePath,
			prec,
			rate,
			overlap,
			seconds,
			tracks,
			trackBins,
		}
		const nativeArgs = [
			prec,
			String(overlap),
			String(seconds),
			String(rate),
			scenePath,
			String(tracks),
			String(trackBins),
		]
		for (let round = 0; round < rounds; round++) {
			const l0 = load1()
			const w = await runWasmOnThread(cfg, thread)
			const l1 = load1()
			process.stdout.write(
				`round ${round} wasm   ${fmt(w.totalMsPerSec, 2)} thread-CPU-ms/s IQ = call ${fmt(w.callMsPerSec, 2)} + copy in ${fmt(w.copyInMsPerSec, 3)} + copy out ${fmt(w.copyOutMsPerSec, 3)} (load ${l0} > ${l1})\n`,
			)
			process.stdout.write(
				`  frames ${w.frames} blocks ${w.blocks} blanked ${w.blanked}; clock read ${fmt(w.readNs, 0)} ns\n  stages, clock read removed: ${stageLine(w.stages)}\n`,
			)
			process.stdout.write(
				`  startup: compile wall ${fmt(w.startup.compileWallMs, 2)} ms, thread CPU ${fmt(w.startup.compileThreadCpuMs, 2)}, process CPU ${fmt(w.startup.compileProcessCpuMs, 2)}; instantiate wall ${fmt(w.startup.instantiateWallMs, 2)} ms; path new CPU ${fmt(w.startup.pathNewThreadCpuMs, 2)} ms; first s of IQ ${fmt(w.startup.firstSecondCpuMs, 1)} CPU-ms, next ${fmt(w.startup.warmCpuMsPerSec, 1)} CPU-ms/s; other threads over warm-up ${fmt(w.startup.warmOtherThreadsCpuMs, 1)} CPU-ms; linear memory ${w.startup.memoryBytes} bytes\n`,
			)
			if (!nativeBin) continue
			const l2 = load1()
			const v = runNative(nativeBin, nativeArgs)
			const l3 = load1()
			process.stdout.write(
				`round ${round} native ${fmt(v.cpuMsPerSec, 2)} thread-CPU-ms/s IQ (load ${l2} > ${l3}); wasm/native ${fmt(w.callMsPerSec / v.cpuMsPerSec, 2)}\n`,
			)
			process.stdout.write(
				`  frames ${v.frames} blocks ${v.blocks} blanked ${v.blanked}; clock read ${fmt(v.readNs, 0)} ns\n  stages, clock read removed: ${stageLine(v.stages)}\n`,
			)
		}
		if (agreeFrames > 0) {
			const available = Math.floor(iq.length / (n * 2))
			const frames = Math.min(agreeFrames, available)
			const js = jsPowers(iq, n, frames)
			const report = (label: string, other: Float64Array, base = js): void => {
				const a = agreement(base, other, n)
				process.stdout.write(
					`power bins, ${frames} frames, ${label}: max ${a.maxDb.toExponential(3)} dB (at ${fmt(a.maxDbAtBaseDb)} dB); above -100 dB ${a.maxDbAboveMinus100.toExponential(3)} dB\n`,
				)
			}
			const wasm = {
				f64: wasmPowers(wasmPath, "f64", rate, iq, n, frames),
				f32: wasmPowers(wasmPath, "f32", rate, iq, n, frames),
			}
			report("wasm f64 against production JS", wasm.f64)
			report("wasm f32 against production JS", wasm.f32)
			if (nativeBin) {
				const dir = path.join(tmp, "dump")
				const native = nativePowers(nativeBin, dir, scenePath, rate, frames)
				report("native f64 against production JS", native.f64)
				report("native f32 against production JS", native.f32)
				report("wasm f64 against native f64", wasm.f64, native.f64)
				report("wasm f32 against native f32", wasm.f32, native.f32)
			}
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true })
	}
}

if (isMainThread) {
	void main().catch((err: unknown) => {
		process.stderr.write(`${String(err)}\n`)
		process.exitCode = 1
	})
} else {
	parentPort?.postMessage(runWasm(workerData as WasmRunConfig))
}

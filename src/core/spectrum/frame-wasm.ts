/**
 * The wasm frame kernel (native/wavekit-frame): loading, the fixed linear-memory layout, and the
 * batch call. SpectrumPipeline stages raw frames here and runs one `fp_run` per batch (a chunk's
 * frames, cut at block ends); every block stage stays in JS and reads the kernel's state through
 * typed-array views of the same memory.
 *
 * - Selection (spectrum-worker.ts): `WAVEKIT_SPECTRUM_FRAME_PATH` = auto (default) | js | wasm, and
 *   `WAVEKIT_SPECTRUM_FRAME_WASM` = the artefact's path (default: spectrum-frame.wasm next to the
 *   worker bundle). Neither is a config key (no `__`), so config.ts ignores them.
 * - Equivalence: the kernel reproduces the JS frame path bit for bit (native/wavekit-frame/src/lib.rs
 *   states how); JS stays the reference and the fallback.
 * - Memory: imported, `initial === maximum`, sized from the pipeline config by `frameKernelLayout`;
 *   it cannot grow, so views never detach and nothing is allocated per chunk.
 */
import { WaveKitError } from "../../utils/errors.js"
import { FRAME_SOURCE_DIGEST } from "./kernel-digest.js"
import type { IqFormat } from "./types.js"
import { compileWasmArtefact, loadWasmArtefact } from "./wasm-artefact.js"
import type { WasmArtefactLoad } from "./wasm-artefact.js"

/** The artefact's file name, next to dist/spectrum-worker.js. */
export const FRAME_WASM_FILE = "spectrum-frame.wasm"
const FRAME_CRATE = "native/wavekit-frame"
/** native/wavekit-frame/src/lib.rs `ABI`. */
export const FRAME_KERNEL_ABI = 1
const PAGE = 65_536
/**
 * Pages below the layout for the kernel's own stack (64 KiB, build.sh) and static data (none beyond
 * a few bytes); checked against `__heap_base` at instantiation.
 */
const RESERVED_PAGES = 4
/** Refuse a layout above this (256 MiB): N 16384 FLOAT32 at 50 % overlap needs about 60 MiB. */
const MAX_LAYOUT_BYTES = 256 * 1024 * 1024

// lib.rs control block: u32 slots, then f64 slots at CTL_U32 · 4.
const CTL_U32 = 64
const CTL_F64 = 16
const CTL_BYTES = CTL_U32 * 4 + CTL_F64 * 8
const C_ABI = 0
const C_N = 1
const C_FORMAT = 2
const C_FRAME_BYTES = 3
const C_PEND_CAP = 4
const C_PEND_COUNT = 5
const C_HAS_REF = 6
const C_BLANK_LO = 7
const C_BLANK_HI = 8
const C_BLANK_NEED = 9
const C_SHORT_FRAMES = 10
const C_SHORT_SLOT = 11
const C_SHORT_FILL = 12
const C_FLOOR_READY = 13
const C_BATCH_CAP = 14
const C_BATCH_COUNT = 15
const C_TRACK_CAP = 16
const C_TRACK_COUNT = 17
const C_CLIPPED = 18
const C_DB_CALLS = 19
const C_END = 20
const C_REGION = 24
const F_SHORT_NEXT = 0
const F_HOP = 1
const F_RISE = 2
const F_TINY = 3
const F_FRAME_SCALE = 4
const F_TRACK_FLOOR = 5

/** lib.rs `E_*`. */
export const FRAME_KERNEL_ERRORS: Readonly<Record<number, string>> = {
	1: "abi",
	2: "layout",
	3: "pending",
	4: "batch",
	5: "tracks",
	6: "format",
}

const FORMAT_CODE: Readonly<Record<IqFormat, number>> = {
	U8_IQ: 0,
	S16_IQ: 1,
	FLOAT32LE: 2,
}
const BYTES_PER_SAMPLE: Readonly<Record<IqFormat, number>> = {
	U8_IQ: 2,
	S16_IQ: 4,
	FLOAT32LE: 8,
}

/** lib.rs `REGIONS`, in layout order. */
const REGIONS = [
	"window",
	"cos",
	"sin",
	"rev",
	"twRe",
	"twIm",
	"lut",
	"re",
	"im",
	"frameAcc",
	"blockAcc",
	"raw",
	"ref",
	"pending",
	"shortAcc",
	"shortRing",
	"onLo",
	"onHi",
	"offLo",
	"offHi",
	"burstPeak",
	"shortOn",
	"burstCount",
	"mask",
	"staging",
	"starts",
	"verdict",
	"trackBins",
	"sums",
] as const

type Region = (typeof REGIONS)[number]

export interface FrameKernelDims {
	format: IqFormat
	fftSize: number
	/** Most frames the first block of an epoch can hold for the blanker: frames per block. */
	pendingCap: number
	/** Frames of the T_short window; 0 = no short path. */
	shortFrames: number
	/** Frames per kernel call; a full batch is run at once. */
	batchCap: number
	/** Most open tracks Tracker.frame sums per frame (the main tracker's maxTracks). */
	trackCap: number
}

/**
 * Bytes of one region, the arithmetic lib.rs `region_bytes` checks: f64 arrays of N (the frame,
 * block, raw, reference, short sum, four threshold brackets and the burst peak), 4·N for Float32 and
 * u32, 8·N·P pending frames, 8·N·max(1, F) short ring, staging = frame bytes · batch, 8 per batch
 * frame start, 8 per track for its bins and 8·batch·tracks for the sums.
 */
function regionBytes(r: Region, d: FrameKernelDims): number {
	const n = d.fftSize
	switch (r) {
		case "window":
		case "re":
		case "im":
		case "rev":
			return 4 * n
		case "cos":
		case "sin":
			return 8 * (n / 2)
		case "lut":
			return 8 * 256
		case "pending":
			return 8 * n * d.pendingCap
		case "shortRing":
			return 8 * n * Math.max(1, d.shortFrames)
		case "shortOn":
		case "burstCount":
		case "mask":
			return n
		case "staging":
			return n * BYTES_PER_SAMPLE[d.format] * d.batchCap
		case "starts":
			return 8 * d.batchCap
		case "verdict":
			return d.batchCap
		case "trackBins":
			return 8 * d.trackCap
		case "sums":
			return 8 * d.batchCap * d.trackCap
		default:
			return 8 * n // twRe, twIm and the f64 arrays of N
	}
}

export interface FrameKernelLayout {
	/** Byte address of the control block (the end of the reserved pages). */
	ctl: number
	offsets: Record<Region, number>
	/** End of the last region. */
	end: number
	/** `initial` and `maximum` of the memory: ceil(end / 64 KiB). */
	pages: number
}

/** Regions 16-byte aligned, in order, after the reserved pages and the control block. */
export function frameKernelLayout(d: FrameKernelDims): FrameKernelLayout {
	const ctl = RESERVED_PAGES * PAGE
	let at = ctl + CTL_BYTES
	const offsets = {} as Record<Region, number>
	for (const r of REGIONS) {
		at = Math.ceil(at / 16) * 16
		offsets[r] = at
		at += regionBytes(r, d)
	}
	return { ctl, offsets, end: at, pages: Math.ceil(at / PAGE) }
}

// ---- the WebAssembly global (es2024 lib has no declarations for it) ----

interface WasmMemory {
	readonly buffer: ArrayBuffer
	grow(pages: number): number
}
interface WasmInstance {
	readonly exports: Record<string, unknown>
}
interface WasmApi {
	validate(bytes: Uint8Array): boolean
	Module: new (bytes: Uint8Array) => object
	Instance: new (module: object, imports: object) => WasmInstance
	Memory: new (d: { initial: number; maximum: number }) => WasmMemory
}

function wasmApi(): WasmApi | null {
	const w = (globalThis as { WebAssembly?: WasmApi }).WebAssembly
	return w ?? null
}

/** A compiled kernel module (opaque). */
export interface FrameWasmModule {
	readonly kind: "frame-wasm-module"
	readonly module: object
}

export type FrameWasmLoad =
	| { ok: true; module: FrameWasmModule }
	| { ok: false; reason: string }

const EXPORTS = ["fp_abi", "fp_ctl_bytes", "fp_init", "fp_run"] as const

export interface FrameWasmLoadOptions {
	/** The env var the location came from (reasons name the configured path); absent: the default. */
	configuredBy?: string
	/** The source digest the artefact must carry; default: the bundle's (null unbundled: unchecked). */
	digest?: string | null
}

/** Compiles kernel bytes (wasm-artefact.ts): validated, compiled and digest-checked, or why not. */
export function compileFrameWasm(
	bytes: Uint8Array,
	opts: FrameWasmLoadOptions = {},
): FrameWasmLoad {
	return wrap(
		compileWasmArtefact(bytes, {
			file: FRAME_WASM_FILE,
			crate: FRAME_CRATE,
			digest: opts.digest === undefined ? FRAME_SOURCE_DIGEST : opts.digest,
		}),
	)
}

/** Reads and compiles the artefact; a missing file is a reason, not an error (dev builds have none). */
export function loadFrameWasm(
	location: string | URL,
	opts: FrameWasmLoadOptions = {},
): FrameWasmLoad {
	return wrap(
		loadWasmArtefact(location, {
			file: FRAME_WASM_FILE,
			crate: FRAME_CRATE,
			...(opts.configuredBy === undefined
				? {}
				: { configuredBy: opts.configuredBy }),
			digest: opts.digest === undefined ? FRAME_SOURCE_DIGEST : opts.digest,
		}),
	)
}

function wrap(load: WasmArtefactLoad): FrameWasmLoad {
	return load.ok
		? { ok: true, module: { kind: "frame-wasm-module", module: load.module } }
		: load
}

export type FramePathChoice = "auto" | "js" | "wasm"

/** `WAVEKIT_SPECTRUM_FRAME_PATH`; anything else reads as auto. */
export function framePathChoice(value: string | undefined): FramePathChoice {
	return value === "js" || value === "wasm" ? value : "auto"
}

function errorName(err: unknown): string {
	return err instanceof Error ? err.name : "unknown"
}

/** The tables and constants the kernel takes from the JS path instead of recomputing them. */
export interface FrameKernelInputs {
	window: Float32Array
	fillFftTables: (
		cos: Float64Array,
		sin: Float64Array,
		rev: Uint32Array,
	) => void
	/** Frame advance in samples. */
	hop: number
	blank: { lo: number; hi: number; need: number; rise: number; tiny: number }
	frameScale: number
	trackFloor: number
	/** JS `shortOnInDb(i, a, was)` for a short sum inside its bracket. */
	shortDb: (i: number, a: number, was: boolean) => boolean
}

/** Scalars JS owns and the kernel reads before a batch. */
export interface FrameKernelState {
	pendingCount: number
	hasRef: boolean
	shortSlot: number
	shortFill: number
	shortNext: number
	floorReady: boolean
	trackCount: number
}

type Exports = {
	fp_abi: () => number
	fp_init: (ctl: number) => number
	fp_run: (ctl: number) => number
	fp_trap?: () => number
	__heap_base?: { value: number }
}

function exportsOf(instance: WasmInstance): Exports | null {
	const e = instance.exports
	for (const name of EXPORTS) if (typeof e[name] !== "function") return null
	return e as unknown as Exports
}

/**
 * One pipeline's kernel instance over a fixed memory. Construct with `FrameKernel.create`, which
 * returns a reason instead when the module does not fit (ABI, layout, size).
 */
export class FrameKernel {
	readonly dims: FrameKernelDims
	readonly layout: FrameKernelLayout
	readonly frameBytes: number
	readonly batchCap: number
	readonly trackCap: number
	readonly frameAcc: Float64Array
	readonly blockAcc: Float64Array
	readonly raw: Float64Array
	readonly ref: Float64Array
	/** One view per pending slot (pendingCap of them). */
	readonly pending: readonly Float64Array[]
	readonly shortAcc: Float64Array
	readonly shortRing: Float64Array
	readonly onLo: Float64Array
	readonly onHi: Float64Array
	readonly offLo: Float64Array
	readonly offHi: Float64Array
	readonly burstPeak: Float64Array
	readonly shortOn: Uint8Array
	readonly burstCount: Uint8Array
	readonly mask: Uint8Array
	readonly staging: Uint8Array
	readonly starts: Float64Array
	readonly verdict: Uint8Array
	readonly trackBins: Uint32Array
	readonly sums: Float64Array
	/** Frames staged for the next run. */
	count = 0
	/** Instances made after the first (recreate). */
	restarts = 0
	private readonly api: WasmApi
	private readonly module: object
	readonly memory: WasmMemory
	private readonly ctlU32: Uint32Array
	private readonly ctlF64: Float64Array
	private readonly imports: object
	private exports: Exports

	private constructor(
		api: WasmApi,
		module: FrameWasmModule,
		dims: FrameKernelDims,
		layout: FrameKernelLayout,
		memory: WasmMemory,
		inputs: FrameKernelInputs,
	) {
		this.api = api
		this.module = module.module
		this.dims = dims
		this.layout = layout
		this.memory = memory
		const buf = memory.buffer
		const n = dims.fftSize
		const o = layout.offsets
		const f64 = (r: Region, len = n): Float64Array =>
			new Float64Array(buf, o[r], len)
		const u8 = (r: Region, len = n): Uint8Array =>
			new Uint8Array(buf, o[r], len)
		this.frameBytes = n * BYTES_PER_SAMPLE[dims.format]
		this.batchCap = dims.batchCap
		this.trackCap = dims.trackCap
		this.frameAcc = f64("frameAcc")
		this.blockAcc = f64("blockAcc")
		this.raw = f64("raw")
		this.ref = f64("ref")
		const pending: Float64Array[] = []
		for (let k = 0; k < dims.pendingCap; k++)
			pending.push(new Float64Array(buf, o.pending + 8 * n * k, n))
		this.pending = pending
		this.shortAcc = f64("shortAcc")
		this.shortRing = f64("shortRing", n * Math.max(1, dims.shortFrames))
		this.onLo = f64("onLo")
		this.onHi = f64("onHi")
		this.offLo = f64("offLo")
		this.offHi = f64("offHi")
		this.burstPeak = f64("burstPeak")
		this.shortOn = u8("shortOn")
		this.burstCount = u8("burstCount")
		this.mask = u8("mask")
		this.staging = u8("staging", this.frameBytes * dims.batchCap)
		this.starts = f64("starts", dims.batchCap)
		this.verdict = u8("verdict", dims.batchCap)
		this.trackBins = new Uint32Array(buf, o.trackBins, 2 * dims.trackCap)
		this.sums = f64("sums", dims.batchCap * dims.trackCap)
		this.ctlU32 = new Uint32Array(buf, layout.ctl, CTL_U32)
		this.ctlF64 = new Float64Array(buf, layout.ctl + CTL_U32 * 4, CTL_F64)

		// tables and constants, written once (JS values, so the kernel cannot drift from them)
		new Float32Array(buf, o.window, n).set(inputs.window)
		inputs.fillFftTables(
			new Float64Array(buf, o.cos, n / 2),
			new Float64Array(buf, o.sin, n / 2),
			new Uint32Array(buf, o.rev, n),
		)
		const lut = new Float64Array(buf, o.lut, 256)
		for (let u = 0; u < 256; u++) lut[u] = u / 127.5 - 1
		const c = this.ctlU32
		c[C_ABI] = FRAME_KERNEL_ABI
		c[C_N] = n
		c[C_FORMAT] = FORMAT_CODE[dims.format]
		c[C_FRAME_BYTES] = this.frameBytes
		c[C_PEND_CAP] = dims.pendingCap
		c[C_SHORT_FRAMES] = dims.shortFrames
		c[C_BATCH_CAP] = dims.batchCap
		c[C_TRACK_CAP] = dims.trackCap
		c[C_BLANK_LO] = inputs.blank.lo
		c[C_BLANK_HI] = inputs.blank.hi
		c[C_BLANK_NEED] = inputs.blank.need
		c[C_END] = layout.end
		REGIONS.forEach((r, k) => {
			c[C_REGION + k] = o[r]
		})
		const f = this.ctlF64
		f[F_SHORT_NEXT] = -1
		f[F_HOP] = inputs.hop
		f[F_RISE] = inputs.blank.rise
		f[F_TINY] = inputs.blank.tiny
		f[F_FRAME_SCALE] = inputs.frameScale
		f[F_TRACK_FLOOR] = inputs.trackFloor
		const shortDb = inputs.shortDb
		this.imports = {
			env: {
				memory,
				short_db: (i: number, a: number, was: number): number =>
					shortDb(i, a, was === 1) ? 1 : 0,
			},
		}
		this.exports = this.instantiate()
	}

	/** A kernel for `dims`, or why not. Throws nothing. */
	static create(
		module: FrameWasmModule,
		dims: FrameKernelDims,
		inputs: FrameKernelInputs,
	): { ok: true; kernel: FrameKernel } | { ok: false; reason: string } {
		const api = wasmApi()
		if (!api) return { ok: false, reason: "no WebAssembly in this runtime" }
		const layout = frameKernelLayout(dims)
		if (layout.end > MAX_LAYOUT_BYTES)
			return {
				ok: false,
				reason: `layout of ${layout.end} bytes exceeds ${MAX_LAYOUT_BYTES}`,
			}
		try {
			const memory = new api.Memory({
				initial: layout.pages,
				maximum: layout.pages,
			})
			return {
				ok: true,
				kernel: new FrameKernel(api, module, dims, layout, memory, inputs),
			}
		} catch (err) {
			return {
				ok: false,
				reason:
					err instanceof WaveKitError
						? err.message
						: `instantiate failed: ${errorName(err)}`,
			}
		}
	}

	/** Bytes of linear memory (fixed). */
	get memoryBytes(): number {
		return this.memory.buffer.byteLength
	}

	/** `short_db` calls since construction (sums that fell inside a threshold bracket). */
	get dbCalls(): number {
		return this.ctlU32[C_DB_CALLS]!
	}

	private instantiate(): Exports {
		const instance = new this.api.Instance(this.module, this.imports)
		const e = exportsOf(instance)
		if (!e)
			throw new WaveKitError(
				"frame kernel lacks its exports",
				"SCANNER_FRAME_KERNEL",
			)
		if (e.fp_abi() !== FRAME_KERNEL_ABI)
			throw new WaveKitError(
				`ABI mismatch: frame kernel ABI ${e.fp_abi()}, expected ${FRAME_KERNEL_ABI}`,
				"SCANNER_FRAME_KERNEL",
			)
		const heapBase = e.__heap_base?.value
		if (typeof heapBase !== "number" || heapBase > this.layout.ctl)
			throw new WaveKitError(
				"frame kernel static data overlaps its layout",
				"SCANNER_FRAME_KERNEL",
			)
		const status = e.fp_init(this.layout.ctl)
		if (status !== 0)
			throw new WaveKitError(
				`frame kernel init: ${FRAME_KERNEL_ERRORS[status] ?? status}`,
				"SCANNER_FRAME_KERNEL",
			)
		return e
	}

	/** A fresh instance on the same memory (after a trap). False when that fails too. */
	recreate(): boolean {
		try {
			this.exports = this.instantiate()
			this.restarts++
			return true
		} catch {
			return false
		}
	}

	/**
	 * Runs the `count` staged frames. Returns 0, or a lib.rs error code (nothing past the failing
	 * frame ran). A trap throws (WebAssembly.RuntimeError); the caller owns recovery.
	 */
	run(s: FrameKernelState): number {
		const c = this.ctlU32
		c[C_BATCH_COUNT] = this.count
		c[C_PEND_COUNT] = s.pendingCount
		c[C_HAS_REF] = s.hasRef ? 1 : 0
		c[C_SHORT_SLOT] = s.shortSlot
		c[C_SHORT_FILL] = s.shortFill
		c[C_FLOOR_READY] = s.floorReady ? 1 : 0
		c[C_TRACK_COUNT] = s.trackCount
		c[C_CLIPPED] = 0
		this.ctlF64[F_SHORT_NEXT] = s.shortNext
		return this.exports.fp_run(this.layout.ctl)
	}

	/** After `run`: the short window's scalars and the batch's clipped-sample count. */
	get shortSlot(): number {
		return this.ctlU32[C_SHORT_SLOT]!
	}

	get shortFill(): number {
		return this.ctlU32[C_SHORT_FILL]!
	}

	get shortNext(): number {
		return this.ctlF64[F_SHORT_NEXT]!
	}

	get clipped(): number {
		return this.ctlU32[C_CLIPPED]!
	}

	/** Test hook: the next run executes the kernel's `fp_trap` (a real wasm `unreachable` trap). */
	trapNextRunForTest(): void {
		const trap = this.exports.fp_trap
		if (!trap)
			throw new WaveKitError(
				"frame kernel lacks fp_trap",
				"SCANNER_FRAME_KERNEL",
			)
		this.exports = { ...this.exports, fp_run: () => trap() }
	}

	/** Test hook: an instance whose `fp_run` returns `status` (a kernel error code). */
	failForTest(status: number): void {
		this.exports = { ...this.exports, fp_run: () => status }
	}
}

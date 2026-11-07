/**
 * The wasm NFM chain kernel (native/wavekit-nfm): loading, the fixed linear-memory layout of one
 * chain, and the per-slice call. wideband-nfm.ts `createWidebandNfmChain` builds one kernel per
 * recording chain and falls back to the JS chain when it does not load or fit.
 *
 * - Selection: `WAVEKIT_RECORDER_DSP` = auto (default) | js | wasm, and `WAVEKIT_RECORDER_DSP_WASM`
 *   = the artefact's path (default: wideband-nfm.wasm next to the bundle, dist/index.js). Neither
 *   is a config key (no `__`), so config.ts ignores them.
 * - Equivalence: within ±1 LSB of the JS chain (native/wavekit-nfm/src/lib.rs states why); JS stays
 *   the reference and the fallback.
 * - Memory: one imported memory per chain, `initial === maximum`, sized from the chain's factors
 *   and MAX_SLICE_SAMPLES by `nfmKernelLayout`; it cannot grow, so views never detach and nothing
 *   is allocated per slice beyond the returned pcm copy (the JS chain allocates the same).
 * - Faults: each call first copies the stream state (control block and delay lines, 6.5 to 7.8 KB)
 *   into a preallocated buffer; `state("slice-start")` hands it to the JS chain after a fault.
 */
import { NFM_SOURCE_DIGEST } from "../../spectrum/kernel-digest.js"
import {
	compileWasmArtefact,
	loadWasmArtefact,
} from "../../spectrum/wasm-artefact.js"
import type { WasmArtefactLoad } from "../../spectrum/wasm-artefact.js"
import { WaveKitError } from "../../../utils/errors.js"

/** The artefact's file name, next to dist/index.js. */
export const NFM_WASM_FILE = "wideband-nfm.wasm"
const NFM_CRATE = "native/wavekit-nfm"
/** native/wavekit-nfm/src/lib.rs `ABI`. */
export const NFM_KERNEL_ABI = 1
const PAGE = 65_536
/**
 * Pages below the layout for the kernel's stack (64 KiB, build.sh) and static data (a few KiB);
 * checked against `__heap_base` at instantiation.
 */
export const NFM_RESERVED_PAGES = 2

// lib.rs control block: u32 slots, then f64 slots at CTL_U32 · 4.
const CTL_U32 = 32
const CTL_F64 = 56
const CTL_BYTES = CTL_U32 * 4 + CTL_F64 * 8
const C_ABI = 0
const C_K = 1
const C_M = 2
const C_T2 = 3
const C_TC = 4
const C_TD = 5
const C_EXACT = 6
const C_HIGH_PASS = 7
const C_MAX_IN = 8
const C_OUT_CAP = 9
const C_N_IN = 10
const C_N_OUT = 11
const C_PHASE = 12
const C_S2_PHASE = 13
const C_SINCE_RENORM = 14
const C_S2_HEAD = 15
const C_CH_HEAD = 16
const C_DM_HEAD = 17
const C_DM_PHASE = 18
const C_END = 19
const C_REGION = 20
const F_ROT_RE = 0
const F_ROT_IM = 1
const F_CIC_SCALE = 2
const F_STEP = 3
const F_SCALE = 4
const F_ALPHA = 5
const F_BIQUAD = 6
const F_PH_RE = 26
const F_PH_IM = 27
const F_CUR_RE = 28
const F_CUR_IM = 29
const F_NXT_RE = 30
const F_NXT_IM = 31
const F_FRAC = 32
const F_PREV_RE = 33
const F_PREV_IM = 34
const F_LAST_I = 35
const F_LAST_Q = 36
const F_DEEMPH = 37
/** (x1, x2, y1, y2) of high-pass 0 and 1, then tone low-pass 0 and 1. */
const F_BIQUAD_STATE = 38

/** lib.rs `E_*`. */
export const NFM_KERNEL_ERRORS: Readonly<Record<number, string>> = {
	1: "abi",
	2: "layout",
	3: "state",
	4: "input",
	5: "output",
}

/** lib.rs `REGIONS`, in layout order. */
const REGIONS = [
	"lut",
	"s2Taps",
	"s2Line",
	"chTaps",
	"chLine",
	"dmTaps",
	"dmHist",
	"input",
	"pcm",
	"tone",
] as const

type Region = (typeof REGIONS)[number]

export interface NfmKernelDims {
	/** Stage-1 (sum-and-dump) factor. */
	k: number
	/** Stage-2 FIR factor. */
	m: number
	stage2Taps: number
	channelTaps: number
	demodTaps: number
	/** Most CU8 samples per call (MAX_SLICE_SAMPLES). */
	maxIn: number
}

/**
 * Most 8 kHz frames one call of `maxIn` samples can produce: at most ceil(maxIn / (k · m)) + 2
 * samples at r (the stage phases carry less than one output each), at most one 48 kHz sample per
 * r sample (r ≥ 48 kHz), and the discriminator's 6:1 with up to 5 carried.
 */
export function nfmOutCap(d: NfmKernelDims): number {
	const n48 = Math.ceil(d.maxIn / (d.k * d.m)) + 2
	return Math.floor((5 + n48) / 6) + 1
}

/** Bytes of one region, the arithmetic lib.rs `region_bytes` checks. */
function regionBytes(r: Region, d: NfmKernelDims): number {
	switch (r) {
		case "lut":
			return 8 * 256
		case "s2Taps":
			return 8 * d.stage2Taps
		case "s2Line":
			return 32 * d.stage2Taps
		case "chTaps":
			return 8 * d.channelTaps
		case "chLine":
			return 32 * d.channelTaps
		case "dmTaps":
			return 8 * d.demodTaps
		case "dmHist":
			return 16 * d.demodTaps
		case "input":
			return 2 * d.maxIn
		case "pcm":
		case "tone":
			return 2 * nfmOutCap(d)
	}
}

export interface NfmKernelLayout {
	/** Byte address of the control block (the end of the reserved pages). */
	ctl: number
	offsets: Record<Region, number>
	/** End of the last region. */
	end: number
	/** `initial` and `maximum` of the memory: ceil(end / 64 KiB). */
	pages: number
}

/** Regions 16-byte aligned, in order, after the reserved pages and the control block. */
export function nfmKernelLayout(d: NfmKernelDims): NfmKernelLayout {
	const ctl = NFM_RESERVED_PAGES * PAGE
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
export interface NfmWasmModule {
	readonly kind: "nfm-wasm-module"
	readonly module: object
}

export type NfmWasmLoad =
	| { ok: true; module: NfmWasmModule }
	| { ok: false; reason: string }

const EXPORTS = ["nfm_abi", "nfm_check", "nfm_run"] as const

function errorName(err: unknown): string {
	return err instanceof Error ? err.name : "unknown"
}

export interface NfmWasmLoadOptions {
	/** The env var the location came from (reasons name the configured path); absent: the default. */
	configuredBy?: string
	/** The source digest the artefact must carry; default: the bundle's (null unbundled: unchecked). */
	digest?: string | null
}

/** Compiles kernel bytes (wasm-artefact.ts): validated, compiled and digest-checked, or why not. */
export function compileNfmWasm(
	bytes: Uint8Array,
	opts: NfmWasmLoadOptions = {},
): NfmWasmLoad {
	return wrap(
		compileWasmArtefact(bytes, {
			file: NFM_WASM_FILE,
			crate: NFM_CRATE,
			digest: opts.digest === undefined ? NFM_SOURCE_DIGEST : opts.digest,
		}),
	)
}

/** Reads and compiles the artefact; a missing file is a reason, not an error (dev builds have none). */
export function loadNfmWasm(
	location: string | URL,
	opts: NfmWasmLoadOptions = {},
): NfmWasmLoad {
	return wrap(
		loadWasmArtefact(location, {
			file: NFM_WASM_FILE,
			crate: NFM_CRATE,
			...(opts.configuredBy === undefined
				? {}
				: { configuredBy: opts.configuredBy }),
			digest: opts.digest === undefined ? NFM_SOURCE_DIGEST : opts.digest,
		}),
	)
}

function wrap(load: WasmArtefactLoad): NfmWasmLoad {
	return load.ok
		? { ok: true, module: { kind: "nfm-wasm-module", module: load.module } }
		: load
}

export type RecorderDspChoice = "auto" | "js" | "wasm"

/** `WAVEKIT_RECORDER_DSP`; anything else reads as auto. */
export function recorderDspChoice(
	value: string | undefined,
): RecorderDspChoice {
	return value === "js" || value === "wasm" ? value : "auto"
}

/** The tables and constants the kernel takes from the JS chain instead of recomputing them. */
export interface NfmKernelInputs {
	/** The JS chain's Float32 U8 lookup (256 values). */
	lut: Float32Array
	rotRe: number
	rotIm: number
	cicScale: number
	/** r / 48 kHz; exactly 1 selects the resampler's exact path. */
	step: number
	/** Taps in the JS order (newest sample first); the layout stores them reversed. */
	stage2Taps: ArrayLike<number>
	channelTaps: ArrayLike<number>
	demodTaps: ArrayLike<number>
	/** Discriminator scale and de-emphasis factor (fm-audio.ts). */
	demodScale: number
	demodAlpha: number
	/** (b0, b1, b2, a1, a2) of the two high-pass biquads; none: no high-pass. */
	highPass: readonly (readonly number[])[]
	/** (b0, b1, b2, a1, a2) of the two tone low-pass biquads. */
	lowPass: readonly (readonly number[])[]
}

/**
 * One chain's whole stream state, in the JS chain's terms (wideband-nfm.ts `WidebandNfmChain`
 * `handoverState` / `adoptHandoverState` map it onto its fields). Everything else in the kernel's
 * memory is a constant (tables, taps, coefficients) or a per-call buffer (input, pcm, tone).
 */
export interface NfmChainState {
	/** Stage 1: sum-and-dump phase (0 to k − 1), NCO steps since renormalisation (0 to 4095). */
	phase: number
	sinceRenorm: number
	phRe: number
	phIm: number
	curRe: number
	curIm: number
	nxtRe: number
	nxtIm: number
	/** Stage 2: decimation phase (0 to m − 1), delay line (re, im) per slot, next slot written. */
	s2Phase: number
	s2Line: Float64Array
	s2Head: number
	/** The channel FIR's delay line and next slot. */
	chLine: Float64Array
	chHead: number
	/** The resampler: position of the next output, the previous r sample. */
	frac: number
	prevRe: number
	prevIm: number
	/** The discriminator: last 48 kHz sample, de-emphasis, low-pass history, next slot, 6:1 phase. */
	lastI: number
	lastQ: number
	deemph: number
	dmHist: Float64Array
	dmHead: number
	dmPhase: number
	/** (x1, x2, y1, y2) of high-pass 0 and 1, then tone low-pass 0 and 1 (16 values). */
	biquads: Float64Array
}

type Exports = {
	nfm_abi: () => number
	nfm_check: (ctl: number) => number
	nfm_run: (ctl: number) => number
	nfm_trap?: () => number
	__heap_base?: { value: number }
}

function exportsOf(instance: WasmInstance): Exports | null {
	const e = instance.exports
	for (const name of EXPORTS) if (typeof e[name] !== "function") return null
	return e as unknown as Exports
}

/**
 * One chain's kernel instance over its own fixed memory. Construct with `NfmKernel.create`, which
 * returns a reason instead when the module does not fit (ABI, layout, size).
 */
export class NfmKernel {
	readonly dims: NfmKernelDims
	readonly layout: NfmKernelLayout
	readonly outCap: number
	private readonly memory: WasmMemory
	private readonly ctlU32: Uint32Array
	private readonly input: Uint8Array
	private readonly pcm: Int16Array
	private readonly tone: Int16Array
	private toneLength = 0
	private exports: Exports
	/** The control block and the delay lines (s2Line to dmHist) in the kernel's memory. */
	private readonly liveCtl: Uint8Array
	private readonly liveLines: Uint8Array
	/** Their copy at the start of the last `process` call: the state a fault hands over. */
	private readonly snapshot: Uint8Array

	private constructor(
		api: WasmApi,
		module: NfmWasmModule,
		dims: NfmKernelDims,
		layout: NfmKernelLayout,
		memory: WasmMemory,
		inputs: NfmKernelInputs,
	) {
		this.dims = dims
		this.layout = layout
		this.memory = memory
		this.outCap = nfmOutCap(dims)
		const buf = memory.buffer
		const o = layout.offsets
		this.ctlU32 = new Uint32Array(buf, layout.ctl, CTL_U32)
		const ctlF64 = new Float64Array(buf, layout.ctl + CTL_U32 * 4, CTL_F64)
		this.input = new Uint8Array(buf, o.input, 2 * dims.maxIn)
		this.pcm = new Int16Array(buf, o.pcm, this.outCap)
		this.tone = new Int16Array(buf, o.tone, this.outCap)
		this.liveCtl = new Uint8Array(buf, layout.ctl, CTL_BYTES)
		this.liveLines = new Uint8Array(
			buf,
			o.s2Line,
			o.dmHist + regionBytes("dmHist", dims) - o.s2Line,
		)
		this.snapshot = new Uint8Array(CTL_BYTES + this.liveLines.length)
		if (inputs.lut.length !== 256 || inputs.lowPass.length !== 2)
			throw new WaveKitError("NFM kernel inputs", "SCANNER_NFM_KERNEL")
		if (inputs.highPass.length !== 0 && inputs.highPass.length !== 2)
			throw new WaveKitError("NFM kernel inputs", "SCANNER_NFM_KERNEL")
		new Float64Array(buf, o.lut, 256).set(inputs.lut)
		const reversed = (r: Region, taps: ArrayLike<number>, n: number): void => {
			if (taps.length !== n)
				throw new WaveKitError("NFM kernel taps", "SCANNER_NFM_KERNEL")
			const dst = new Float64Array(buf, o[r], n)
			for (let j = 0; j < n; j++) dst[j] = taps[n - 1 - j]!
		}
		reversed("s2Taps", inputs.stage2Taps, dims.stage2Taps)
		reversed("chTaps", inputs.channelTaps, dims.channelTaps)
		reversed("dmTaps", inputs.demodTaps, dims.demodTaps)
		const c = this.ctlU32
		c[C_ABI] = NFM_KERNEL_ABI
		c[C_K] = dims.k
		c[C_M] = dims.m
		c[C_T2] = dims.stage2Taps
		c[C_TC] = dims.channelTaps
		c[C_TD] = dims.demodTaps
		c[C_EXACT] = inputs.step === 1 ? 1 : 0
		c[C_HIGH_PASS] = inputs.highPass.length === 0 ? 0 : 1
		c[C_MAX_IN] = dims.maxIn
		c[C_OUT_CAP] = this.outCap
		c[C_END] = layout.end
		REGIONS.forEach((r, k) => {
			c[C_REGION + k] = o[r]
		})
		ctlF64[F_ROT_RE] = inputs.rotRe
		ctlF64[F_ROT_IM] = inputs.rotIm
		ctlF64[F_CIC_SCALE] = inputs.cicScale
		ctlF64[F_STEP] = inputs.step
		ctlF64[F_SCALE] = inputs.demodScale
		ctlF64[F_ALPHA] = inputs.demodAlpha
		const biquads = [
			...(inputs.highPass.length === 0
				? [
						[1, 0, 0, 0, 0],
						[1, 0, 0, 0, 0],
					]
				: inputs.highPass),
			...inputs.lowPass,
		]
		biquads.forEach((coef, q) => {
			if (coef.length !== 5)
				throw new WaveKitError("NFM kernel biquad", "SCANNER_NFM_KERNEL")
			for (let i = 0; i < 5; i++) ctlF64[F_BIQUAD + 5 * q + i] = coef[i]!
		})
		// State: the NCO at 1 + 0i, everything else zero (fresh memory).
		ctlF64[F_PH_RE] = 1
		const instance = new api.Instance(module.module, { env: { memory } })
		const e = exportsOf(instance)
		if (!e)
			throw new WaveKitError(
				"NFM kernel lacks its exports",
				"SCANNER_NFM_KERNEL",
			)
		if (e.nfm_abi() !== NFM_KERNEL_ABI)
			throw new WaveKitError(
				`ABI mismatch: NFM kernel ABI ${e.nfm_abi()}, expected ${NFM_KERNEL_ABI}`,
				"SCANNER_NFM_KERNEL",
			)
		const heapBase = e.__heap_base?.value
		if (typeof heapBase !== "number" || heapBase > layout.ctl)
			throw new WaveKitError(
				"NFM kernel static data overlaps its layout",
				"SCANNER_NFM_KERNEL",
			)
		const status = e.nfm_check(layout.ctl)
		if (status !== 0)
			throw new WaveKitError(
				`NFM kernel check: ${NFM_KERNEL_ERRORS[status] ?? status}`,
				"SCANNER_NFM_KERNEL",
			)
		this.exports = e
	}

	/** A kernel for `dims`, or why not. Throws nothing. */
	static create(
		module: NfmWasmModule,
		dims: NfmKernelDims,
		inputs: NfmKernelInputs,
	): { ok: true; kernel: NfmKernel } | { ok: false; reason: string } {
		const api = wasmApi()
		if (!api) return { ok: false, reason: "no WebAssembly in this runtime" }
		const layout = nfmKernelLayout(dims)
		try {
			const memory = new api.Memory({
				initial: layout.pages,
				maximum: layout.pages,
			})
			return {
				ok: true,
				kernel: new NfmKernel(api, module, dims, layout, memory, inputs),
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

	/**
	 * Runs one CU8 slice (whole IQ pairs, at most maxIn; the caller validated it). Returns the
	 * slice's 8 kHz audio as a new array; its tone twin is `toneAudio()`. A kernel error code
	 * throws a WaveKitError, a trap throws WebAssembly.RuntimeError: the caller owns recovery.
	 */
	process(cu8: Uint8Array): Int16Array {
		this.takeSnapshot()
		this.input.set(cu8)
		const c = this.ctlU32
		c[C_N_IN] = cu8.length >> 1
		const status = this.exports.nfm_run(this.layout.ctl)
		if (status !== 0)
			throw new WaveKitError(
				`NFM kernel run: ${NFM_KERNEL_ERRORS[status] ?? status}`,
				"SCANNER_NFM_KERNEL",
			)
		const n = c[C_N_OUT]!
		if (n > this.outCap)
			throw new WaveKitError(
				"NFM kernel run: output count",
				"SCANNER_NFM_KERNEL",
			)
		this.toneLength = n
		return this.pcm.slice(0, n)
	}

	/**
	 * Bytes copied per `process` call to keep the slice-start state: the 576-byte control block
	 * and the delay-line span (s2Line to dmHist, with the channel and discriminator taps between).
	 */
	get snapshotBytes(): number {
		return this.snapshot.length
	}

	/** Copies the stream state aside (the start of a slice; also the bench's unit). */
	takeSnapshot(): void {
		this.snapshot.set(this.liveCtl)
		this.snapshot.set(this.liveLines, CTL_BYTES)
	}

	/**
	 * The stream state at the start of the last `process` call ("slice-start": what a fault hands
	 * to JS) or as the memory holds it now ("now": after the last successful call). A copy.
	 */
	state(which: "slice-start" | "now"): NfmChainState {
		let snap = this.snapshot
		if (which === "now") {
			snap = new Uint8Array(this.snapshot.length)
			snap.set(this.liveCtl)
			snap.set(this.liveLines, CTL_BYTES)
		}
		const u = new Uint32Array(snap.buffer, snap.byteOffset, CTL_U32)
		const f = new Float64Array(
			snap.buffer,
			snap.byteOffset + CTL_U32 * 4,
			CTL_F64,
		)
		const o = this.layout.offsets
		const line = (r: Region, n: number): Float64Array =>
			new Float64Array(
				snap.buffer,
				snap.byteOffset + CTL_BYTES + (o[r] - o.s2Line),
				n,
			).slice()
		const d = this.dims
		return {
			phase: u[C_PHASE]!,
			sinceRenorm: u[C_SINCE_RENORM]!,
			phRe: f[F_PH_RE]!,
			phIm: f[F_PH_IM]!,
			curRe: f[F_CUR_RE]!,
			curIm: f[F_CUR_IM]!,
			nxtRe: f[F_NXT_RE]!,
			nxtIm: f[F_NXT_IM]!,
			s2Phase: u[C_S2_PHASE]!,
			// The doubled lines hold each sample at slot and slot + T: the first copy is the line.
			s2Line: line("s2Line", 2 * d.stage2Taps),
			s2Head: u[C_S2_HEAD]!,
			chLine: line("chLine", 2 * d.channelTaps),
			chHead: u[C_CH_HEAD]!,
			frac: f[F_FRAC]!,
			prevRe: f[F_PREV_RE]!,
			prevIm: f[F_PREV_IM]!,
			lastI: f[F_LAST_I]!,
			lastQ: f[F_LAST_Q]!,
			deemph: f[F_DEEMPH]!,
			dmHist: line("dmHist", d.demodTaps),
			dmHead: u[C_DM_HEAD]!,
			dmPhase: u[C_DM_PHASE]!,
			biquads: f.slice(F_BIQUAD_STATE, F_BIQUAD_STATE + 16),
		}
	}

	/** Tone-band audio of the last `process` call (a view of the kernel's memory: copy to keep). */
	toneAudio(): Int16Array {
		return this.tone.subarray(0, this.toneLength)
	}

	/** Test hook: the next run executes the kernel's `nfm_trap` (a real wasm `unreachable` trap). */
	trapNextRunForTest(): void {
		const trap = this.exports.nfm_trap
		if (!trap)
			throw new WaveKitError("NFM kernel lacks nfm_trap", "SCANNER_NFM_KERNEL")
		this.exports = { ...this.exports, nfm_run: () => trap() }
	}

	/** Test hook: runs return `status` (a kernel error code). */
	failForTest(status: number): void {
		this.exports = { ...this.exports, nfm_run: () => status }
	}
}

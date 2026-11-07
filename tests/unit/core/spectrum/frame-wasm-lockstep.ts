import { isDeepStrictEqual } from "node:util"
import type {
	PipelineConfig,
	PipelineEvent,
} from "../../../../src/core/spectrum/types.js"
import type { WorkerPipelineInput } from "../../../../src/core/spectrum/worker-protocol.js"
import type { FrameKernel } from "../../../../src/core/spectrum/frame-wasm.js"
import { frameWasm } from "./frame-wasm-harness.js"
import { Harness } from "./pipeline-harness.js"

/**
 * Two pipelines, the JS frame path and the wasm kernel, fed the same inputs in lockstep. After every
 * input the events must be identical and so must every piece of frame-path state, compared with
 * SameValue (NaN equals NaN, −0 differs from +0): bit for bit up to NaN payloads, which no decision
 * reads.
 */

/** Pipeline state the frame path writes or reads (private fields, read for the comparison only). */
const PIPELINE_FIELDS = [
	"frameAcc",
	"blockAcc",
	"shortAcc",
	"shortRing",
	"shortSlot",
	"shortFill",
	"shortNext",
	"shortOn",
	"shortOnLo",
	"shortOnHi",
	"shortOffLo",
	"shortOffHi",
	"burstCount",
	"burstPeakAcc",
	"burstCountDone",
	"burstPeakDone",
	"powerDb",
	"floorDb",
	"floorReady",
	"blockFrames",
	"blockClipped",
	"blockIndex",
	"gapSamples",
] as const

const BLANKER_FIELDS = [
	"raw",
	"ref",
	"median",
	"hasRef",
	"frames",
	"blankedInBlock",
	"total",
	"events",
	"lastBlank",
	"latest",
] as const

const TRACK_FIELDS = [
	"id",
	"startBin",
	"endBin",
	"env",
	"envLen",
	"envOrigin",
	"envBucket",
	"envSum",
	"envFrames",
	"frozen",
] as const

type Bag = Record<string, unknown>

function stateOf(h: Harness): Bag {
	const p = h.pipeline as unknown as Bag
	const out: Bag = {}
	for (const f of PIPELINE_FIELDS) out[f] = p[f]
	const b = p["blanker"] as Bag
	for (const f of BLANKER_FIELDS) out[`blanker.${f}`] = b[f]
	out["blanker.pending"] = (
		b["pending"] as { startSample: number; power: Float64Array }[]
	).map(x => [x.startSample, x.power])
	const open = (p["tracker"] as Bag)["open"] as Bag[]
	out["tracker.open"] = open.map(t => TRACK_FIELDS.map(f => t[f]))
	return out
}

export interface LockstepResult {
	/** Inputs fed. */
	inputs: number
	events: PipelineEvent[]
	/** First departures, if any: `input <i>: <what>`. */
	diffs: string[]
	/** Short-path sums inside their bracket, decided by JS `shortOnInDb` (wasm side). */
	dbCalls: number
	/** The wasm pipeline still ran the kernel at the end. */
	wasmAtEnd: boolean
	/** Frames the blanker left out (wasm side), on offer and among pending frames. */
	blanked: number
}

export interface LockstepOptions {
	config?: Partial<PipelineConfig>
	provisionalWindowMs?: number
	frameBatchFrames?: number
	/** Compare state every `stateEvery` inputs (1 = every input). */
	stateEvery?: number
	/** Negative control: change the kernel before the run; the comparison must then fail. */
	perturb?: (kernel: FrameKernel) => void
}

/** Runs `drive` on the wasm harness; each input also goes to the JS harness, then both are compared. */
export function lockstep(
	drive: (h: Harness) => void,
	opts: LockstepOptions = {},
): LockstepResult {
	if (!frameWasm) throw new Error("no frame kernel built")
	const deps = {
		...(opts.provisionalWindowMs === undefined
			? {}
			: { provisionalWindowMs: opts.provisionalWindowMs }),
	}
	const js = new Harness(opts.config ?? {}, deps)
	const wasm = new Harness(opts.config ?? {}, {
		...deps,
		frameWasm,
		...(opts.frameBatchFrames === undefined
			? {}
			: { frameBatchFrames: opts.frameBatchFrames }),
	})
	if (wasm.pipeline.framePath.path !== "wasm")
		throw new Error(`kernel refused: ${wasm.pipeline.framePath.reason}`)
	const kernel = wasm.pipeline.frameKernelForTest()
	if (kernel && opts.perturb) opts.perturb(kernel)
	const diffs: string[] = []
	let inputs = 0
	const every = opts.stateEvery ?? 1
	const send = wasm.send.bind(wasm)
	wasm.send = (input: WorkerPipelineInput): PipelineEvent[] => {
		const ev = send(input)
		const evJs = js.send(input)
		inputs++
		if (diffs.length < 8) {
			if (!isDeepStrictEqual(ev, evJs))
				diffs.push(`input ${inputs}: events (${ev.length} vs ${evJs.length})`)
			if (inputs % every === 0) {
				const a = stateOf(wasm)
				const b = stateOf(js)
				for (const key of Object.keys(b))
					if (!isDeepStrictEqual(a[key], b[key]))
						diffs.push(`input ${inputs}: ${key}`)
			}
		}
		return ev
	}
	drive(wasm)
	return {
		inputs,
		events: wasm.events,
		diffs,
		dbCalls: wasm.pipeline.frameKernelForTest()?.dbCalls ?? 0,
		wasmAtEnd: wasm.pipeline.framePath.path === "wasm",
		blanked: (
			(wasm.pipeline as unknown as Bag)["blanker"] as { blankedFrames: number }
		).blankedFrames,
	}
}

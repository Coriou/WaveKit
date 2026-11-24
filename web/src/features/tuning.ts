// The tuning rule (spec decision 8, DESIGN.md "Spectrum interaction"): the app's tuned frequency is the
// hardware centre plus the live-audio channel offset. Tuning inside the capture moves the offset; tuning
// outside it recentres the hardware on the target (offset back to 0). One rule for the app: the inside /
// outside decision is the plot's tuneAction() + edgeMargin() (web/src/plot/maths.ts, lot C5a), which the
// plot's click, scroll and drag use; planTune() applies it to the tuner state for the Tuner island.
import type { LiveAudioStatus, ScanJob, TunerState } from "@wavekit/api-types"
import type { DataLayer } from "../data/index.ts"
import { errorMessage, Store, tunedHz } from "../data/index.ts"
import { edgeMargin, tuneAction } from "../plot/maths.ts"

export interface TuneContext {
	/** Hardware centre (TunerState.frequency). */
	centreHz: number
	/** Capture width (TunerState.sampleRate). */
	sampleRateHz: number
	/** Current live-audio channel offset (0 when none). */
	offsetHz: number
	/** Live-audio channel bandwidth; the channel keeps clear of the capture edges. */
	bandwidthHz: number
	/** False when live audio cannot take an offset (no live audio, or another source): always recentre. */
	offsetAvailable: boolean
}

export type TunePlan =
	/** Already there. */
	| { kind: "none"; hz: number }
	/** Inside the capture: PATCH live-audio offsetHz. */
	| { kind: "offset"; hz: number; offsetHz: number }
	/** Outside the capture: retune the hardware centre to hz, offset back to 0. */
	| { kind: "recentre"; hz: number; centreHz: number; offsetHz: 0 }

/** The capture around the hardware centre. */
export function captureOf(ctx: TuneContext): {
	startHz: number
	endHz: number
} {
	return {
		startHz: ctx.centreHz - ctx.sampleRateHz / 2,
		endHz: ctx.centreHz + ctx.sampleRateHz / 2,
	}
}

/** The tuning rule: how to put the tuned frequency on `hz`. */
export function planTune(hz: number, ctx: TuneContext): TunePlan {
	const target = Math.round(hz)
	if (ctx.centreHz + ctx.offsetHz === target)
		return { kind: "none", hz: target }
	const recentre: TunePlan = {
		kind: "recentre",
		hz: target,
		centreHz: target,
		offsetHz: 0,
	}
	if (!ctx.offsetAvailable || !(ctx.sampleRateHz > 0)) return recentre
	const capture = captureOf(ctx)
	const action = tuneAction(
		target,
		ctx.centreHz,
		capture,
		edgeMargin(capture, Math.max(0, ctx.bandwidthHz)),
	)
	return action.kind === "offset"
		? { kind: "offset", hz: target, offsetHz: action.offsetHz }
		: recentre
}

/** The rule's inputs from the stores' current state; null before the tuner is known. */
export function tuneContext(
	tuner: TunerState | undefined,
	status: LiveAudioStatus | null,
): TuneContext | null {
	if (!tuner) return null
	const sameSource = status !== null && status.sourceId === tuner.sourceId
	return {
		centreHz: tuner.frequency,
		sampleRateHz: tuner.sampleRate,
		offsetHz: sameSource ? (status.config.offsetHz ?? 0) : 0,
		bandwidthHz: sameSource ? status.config.bandwidth : 0,
		offsetAvailable: sameSource,
	}
}

/**
 * Whether the operator's sweep has the receiver (starting, stepping or holding on a hit). Its next hop
 * retunes the hardware, so a tune then always recentres: only a tuner write pauses the scan
 * (`preempted-operator`, "Scan paused · resumes in …"); a live-audio offset alone would be swept away.
 */
export function scanHasReceiver(
	sweep: Pick<ScanJob, "state"> | null | undefined,
): boolean {
	const s = sweep?.state
	return (
		s === "pending" || s === "starting" || s === "running" || s === "holding"
	)
}

type TuningData = Pick<DataLayer, "tuner" | "liveAudio"> &
	Partial<Pick<DataLayer, "scanner">>

/** Applies one plan: an offset PATCH, or a hardware retune followed by resetting the offset. */
export async function applyTunePlan(
	data: TuningData,
	plan: TunePlan,
	sourceId?: string,
): Promise<void> {
	if (plan.kind === "none") return
	if (plan.kind === "offset") {
		await data.liveAudio.setConfig({ offsetHz: plan.offsetHz })
		return
	}
	await data.tuner.tune(plan.centreHz, sourceId)
	const offset = data.liveAudio.get().status?.config.offsetHz ?? 0
	if (offset !== 0) await data.liveAudio.setConfig({ offsetHz: 0 })
}

export interface TuneOptions {
	/**
	 * Recentre the hardware on the frequency even inside the capture (Display › Click to tune
	 * "Centre": "every tune recentres the receiver"). The plot's tuneTo reads the same setting.
	 */
	recentre?: boolean
	/**
	 * Put the hardware centre here and reach the frequency by the live-audio offset: an undo that
	 * restores an earlier centre and offset exactly. Without an offset (no live audio, or a scan owns
	 * the receiver), or when the frequency lies past that centre's usable edge, it is tuned as usual.
	 */
	centreHz?: number
}

/** Whether `target` is reachable by offset from a capture centred on `centreHz` (inside its usable span). */
function withinSpanOf(
	ctx: TuneContext,
	target: number,
	centreHz: number,
): boolean {
	if (!(ctx.sampleRateHz > 0)) return false
	const capture = captureOf({ ...ctx, centreHz })
	return (
		tuneAction(
			target,
			centreHz,
			capture,
			edgeMargin(capture, Math.max(0, ctx.bandwidthHz)),
		).kind === "offset"
	)
}

/** Moves the hardware centre to `centreHz` (when it is elsewhere), then the offset onto `target`. */
async function restoreCentre(
	data: TuningData,
	ctx: TuneContext,
	target: number,
	centreHz: number,
	sourceId: string,
): Promise<TunePlan> {
	const moved = ctx.centreHz !== centreHz
	if (moved) await data.tuner.tune(centreHz, sourceId)
	const offsetHz = target - centreHz
	const current = data.liveAudio.get().status?.config.offsetHz ?? 0
	if (current !== offsetHz) await data.liveAudio.setConfig({ offsetHz })
	if (offsetHz !== 0) return { kind: "offset", hz: target, offsetHz }
	return moved
		? { kind: "recentre", hz: target, centreHz, offsetHz: 0 }
		: { kind: "none", hz: target }
}

/** Plans against the current state and applies. Rejects with the API error. */
export async function tuneTo(
	data: TuningData,
	hz: number,
	options: TuneOptions = {},
): Promise<TunePlan> {
	const tuner = data.tuner.state()
	const ctx = tuneContext(tuner, data.liveAudio.get().status)
	if (!tuner || !ctx) throw new Error("No tuner source")
	const scanning = scanHasReceiver(data.scanner?.get().sweep)
	const target = Math.round(hz)
	const restoreHz =
		options.centreHz === undefined ? null : Math.round(options.centreHz)
	if (
		restoreHz !== null &&
		ctx.offsetAvailable &&
		!scanning &&
		withinSpanOf(ctx, target, restoreHz)
	)
		return restoreCentre(data, ctx, target, restoreHz, tuner.sourceId)
	// Asked to recentre, a frequency already reached by offset still moves the centre onto it.
	const plan: TunePlan =
		options.recentre === true && ctx.centreHz !== target
			? { kind: "recentre", hz: target, centreHz: target, offsetHz: 0 }
			: planTune(
					hz,
					scanning || options.recentre === true
						? { ...ctx, offsetAvailable: false }
						: ctx,
				)
	await applyTunePlan(data, plan, tuner.sourceId)
	return plan
}

export interface TuningState {
	/** The frequency being tuned to (shown at once), null when settled. */
	targetHz: number | null
	error: string | null
}

/**
 * Coalescing tuner for the islands: shows the target at once, runs one tune at a time and, while one
 * is in flight, keeps only the latest target (spinning a digit sends one request per settle, not per notch).
 */
export class TuningController extends Store<TuningState> {
	private readonly data: TuningData
	private running = false
	private next: { hz: number; options: TuneOptions } | null = null

	constructor(data: TuningData) {
		super({ targetHz: null, error: null })
		this.data = data
	}

	/** The tuned frequency to display: the target while tuning, else centre + offset. */
	displayHz(): number | null {
		return (
			this.get().targetHz ??
			tunedHz(this.data.tuner.state(), this.data.liveAudio.get().status)
		)
	}

	/** Never rejects: a failure lands in `error`. The latest target keeps its own options. */
	tune(hz: number, options: TuneOptions = {}): Promise<void> {
		const target = Math.round(hz)
		this.next = { hz: target, options }
		this.set({ targetHz: target, error: null })
		return this.running ? Promise.resolve() : this.drain()
	}

	private async drain(): Promise<void> {
		this.running = true
		try {
			while (this.next !== null) {
				const { hz, options } = this.next
				this.next = null
				try {
					await tuneTo(this.data, hz, options)
				} catch (error) {
					this.update(s => ({ ...s, error: errorMessage(error) }))
				}
			}
		} finally {
			this.running = false
			this.update(s => ({ ...s, targetHz: null }))
		}
	}
}

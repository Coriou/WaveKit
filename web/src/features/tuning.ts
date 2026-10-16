// The tuning rule (spec decision 8, DESIGN.md "Spectrum interaction"): the app's tuned frequency is the
// hardware centre plus the live-audio channel offset. Tuning inside the capture moves the offset; tuning
// outside it recentres the hardware on the target (offset back to 0). One rule for the app: the inside /
// outside decision is the plot's tuneAction() + edgeMargin() (web/src/plot/maths.ts, lot C5a), which the
// plot's click, scroll and drag use; planTune() applies it to the tuner state for the Tuner island.
import type { LiveAudioStatus, TunerState } from "@wavekit/api-types"
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

type TuningData = Pick<DataLayer, "tuner" | "liveAudio">

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

/** Plans against the current state and applies. Rejects with the API error. */
export async function tuneTo(data: TuningData, hz: number): Promise<TunePlan> {
	const tuner = data.tuner.state()
	const ctx = tuneContext(tuner, data.liveAudio.get().status)
	if (!tuner || !ctx) throw new Error("No tuner source")
	const plan = planTune(hz, ctx)
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
	private next: number | null = null

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

	/** Never rejects: a failure lands in `error`. */
	tune(hz: number): Promise<void> {
		this.next = Math.round(hz)
		this.set({ targetHz: this.next, error: null })
		return this.running ? Promise.resolve() : this.drain()
	}

	private async drain(): Promise<void> {
		this.running = true
		try {
			while (this.next !== null) {
				const hz = this.next
				this.next = null
				try {
					await tuneTo(this.data, hz)
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

/**
 * WG15 DQ requirement 8: the passive guard's per-source state machine (windows, baseline, trial),
 * driven by the scanner service's 1 s status tick. Decisions come from the pure
 * `passiveGuardDecision` (8.4); this class only keeps the windows and stamps (8.2, 8.3, 8.5 to
 * 8.7) and tells the service when to remove or restore the passive job.
 */
import {
	PASSIVE_BASELINE_MAX_AGE_MS,
	PASSIVE_COST_RECHECK_MS,
	PASSIVE_COST_WINDOW_MS,
} from "./passive-cost-contract.js"
import {
	PASSIVE_PROBATION_MS,
	passiveGuardDecision,
	windowedUtilization,
} from "./passive-cost.js"
import type {
	EluSample,
	PassiveGuardResult,
	PassiveHolders,
} from "./passive-cost.js"

/** What the guard reads of one source's engine on a tick. */
export interface PassiveGuardView {
	/** The engine instance (identity only); null when no engine is open. */
	engine: object | null
	openedAt: number | null
	/** Consumers of the engine; null when unreadable (counts as sole, 8.1). */
	consumers: { jobs: readonly string[]; displays: readonly string[] } | null
	/** The worker's cumulative ELU sample; null = no measurement (8.2). */
	sample: EluSample | null
	/** The source has a passive job (enabled) or the guard disabled it. */
	tracked: boolean
}

interface DisableAction {
	kind: "disable"
	reason: string
	result: PassiveGuardResult
}
interface MeasureAction {
	kind: "measure"
	reason: string
}
interface RestoreAction {
	kind: "restore"
	why: "baseline" | "trial" | "clear" | "abandon"
}

/** What the service must do after a tick. */
export type PassiveGuardAction =
	| { kind: "none" }
	| DisableAction
	| MeasureAction
	| RestoreAction

export const MEASURING_REASON = "measuring baseline"

type WindowKind = "open" | "judge" | "baseline" | "off" | "trial" | "restore"

interface Window {
	kind: WindowKind
	startedAt: number
	/** Start sample; null = the worker's whole life (the first window after open). */
	sample: EluSample | null
}

interface SourceState {
	engine: object
	generation: number | null
	others: string
	window: Window | null
	/** The guard's next window after its own toggle, opened when the holders reflect it. */
	pending: "baseline" | "off" | "trial" | "restore" | null
	/** The guard toggled passive and the holders do not show it yet (8.3 generation grace). */
	toggling: boolean
	lastJudgedAt: number | null
	baseline: { value: number; others: string; at: number } | null
	lastBaselineWindowAt: number | null
	/** Restored when a baseline window is abandoned without a measurement (8.5). */
	previousBaselineWindowAt: number | null
	measuringSince: number | null
	trialing: boolean
	/**
	 * Samples seen while the guard holds passive off, oldest first, trimmed to the newest one at
	 * least a window old: the trial start measures against it (8.2, 8.7). Cleared when the worker
	 * generation changes or a counter goes back.
	 */
	offSamples: { at: number; sample: EluSample }[]
}

export interface PassiveGuardStatus {
	/** The guard disabled passive (cost) or removed it for a baseline window. */
	disabled: boolean
	measuring: boolean
	disabledAt: number | null
}

const passiveConsumer = (sourceId: string): string => `job:passive-${sourceId}`

export class PassiveGuard {
	private readonly states = new Map<string, SourceState>()
	/** Sources whose passive the guard disabled for cost (not baseline windows). */
	private readonly disabledAt = new Map<string, number>()
	private readonly measuring = new Set<string>()

	status(sourceId: string): PassiveGuardStatus {
		return {
			disabled: this.disabledAt.has(sourceId) || this.measuring.has(sourceId),
			measuring: this.measuring.has(sourceId),
			disabledAt: this.disabledAt.get(sourceId) ?? null,
		}
	}

	/** Forgets a source (removed). */
	forget(sourceId: string): void {
		this.states.delete(sourceId)
		this.disabledAt.delete(sourceId)
		this.measuring.delete(sourceId)
	}

	/** Test and diagnostics: the current baseline, if valid. */
	baselineOf(sourceId: string, now: number): number | null {
		const st = this.states.get(sourceId)
		return st ? this.validBaseline(st, now) : null
	}

	tick(
		sourceId: string,
		view: PassiveGuardView,
		now: number,
		limit: number,
	): PassiveGuardAction {
		const disabled = this.disabledAt.has(sourceId)
		const measuring = this.measuring.has(sourceId)
		if (view.engine === null || view.openedAt === null) {
			this.states.delete(sourceId)
			if (measuring) {
				this.measuring.delete(sourceId)
				return { kind: "restore", why: "abandon" }
			}
			if (!disabled) return { kind: "none" }
			const r = passiveGuardDecision({
				enabled: false,
				holders: "closed",
				measurement: null,
				baseline: null,
				limit,
				judgementDue: false,
				baselineWindowAllowed: false,
				trialDue: false,
				probationDue:
					now - (this.disabledAt.get(sourceId) ?? now) >= PASSIVE_PROBATION_MS,
			})
			if (r.decision !== "clear") return { kind: "none" }
			this.disabledAt.delete(sourceId)
			return { kind: "restore", why: "clear" }
		}
		if (!view.tracked && !disabled && !measuring) {
			this.states.delete(sourceId)
			return { kind: "none" }
		}
		const passiveId = passiveConsumer(sourceId)
		const holdsPassive =
			view.consumers === null || view.consumers.jobs.includes(passiveId)
		const others =
			view.consumers === null
				? ""
				: [...view.consumers.jobs, ...view.consumers.displays]
						.filter(c => c !== passiveId)
						.sort()
						.join("\u0000")
		const holders: PassiveHolders = !holdsPassive
			? "off"
			: others === ""
				? "sole"
				: "shared"
		let st = this.states.get(sourceId)
		if (st === undefined || st.engine !== view.engine) {
			st = {
				engine: view.engine,
				generation: view.sample?.generation ?? null,
				others,
				// 8.2: the first window runs from the engine's open over the worker's whole life.
				window: { kind: "open", startedAt: view.openedAt, sample: null },
				pending: null,
				toggling: false,
				lastJudgedAt: null,
				baseline: null,
				lastBaselineWindowAt: null,
				previousBaselineWindowAt: null,
				measuringSince: null,
				trialing: false,
				offSamples: [],
			}
			this.states.set(sourceId, st)
		}
		const generation = view.sample?.generation ?? null
		// 8.2, 8.3: a new worker generation discards the window; unless the guard's own toggle
		// explains it, the baseline too.
		if (
			generation !== null &&
			st.generation !== null &&
			generation !== st.generation
		) {
			if (!st.toggling) st.baseline = null
			if (st.window !== null)
				st.window = {
					kind: st.window.kind,
					startedAt: now,
					sample: view.sample,
				}
		}
		st.generation = generation ?? st.generation
		if (others !== st.others) {
			// 8.3: the other consumers changed: the baseline no longer describes this workload.
			st.others = others
			st.baseline = null
			if (st.window !== null && st.pending === null)
				st.window = {
					kind: st.window.kind,
					startedAt: now,
					sample: view.sample,
				}
		}
		// A toggle becomes visible: open the window it asked for (8.2).
		if (st.pending !== null) {
			const wantOff = st.pending === "baseline" || st.pending === "off"
			if (wantOff === !holdsPassive) {
				st.window = { kind: st.pending, startedAt: now, sample: view.sample }
				st.pending = null
				st.toggling = false
			}
		}
		// 8.5: a baseline window that cannot complete in two windows is abandoned.
		// It gave no measurement (a valid one restores at once), so the opportunity is not used up.
		if (
			measuring &&
			st.measuringSince !== null &&
			now - st.measuringSince >= 2 * PASSIVE_COST_WINDOW_MS
		) {
			st.lastBaselineWindowAt = st.previousBaselineWindowAt
			return this.restoreAfterBaseline(sourceId, st, "abandon")
		}
		// 8.2: a window opened without a start sample is re-seeded at the first sample; only the
		// window from the engine's open may span the worker's whole life.
		if (
			st.window !== null &&
			st.window.kind !== "open" &&
			st.window.sample === null &&
			view.sample !== null
		)
			st.window = { kind: st.window.kind, startedAt: now, sample: view.sample }
		const w = st.window
		if (w === null || st.pending !== null) return { kind: "none" }
		const done = this.complete(w, now)
		const u = done ? this.measure(w, view) : null
		if (!disabled && st.offSamples.length > 0) st.offSamples = []
		if (measuring) {
			if (w.kind !== "baseline" || !done) return { kind: "none" }
			// 8.5: no measurement yet: keep waiting until the two-window deadline above.
			if (u === null || !Number.isFinite(u)) return { kind: "none" }
			st.baseline = { value: u, others: st.others, at: now }
			return this.restoreAfterBaseline(sourceId, st, "baseline")
		}
		if (disabled) {
			if (holdsPassive) return { kind: "none" } // a restore in flight
			const since = now - (this.disabledAt.get(sourceId) ?? now)
			// 8.7: the trial starts on the first tick at or after its deadline that has a valid 8.2
			// measurement (8.4 row 1: no measurement keeps the current state), not when an off window
			// ends. The history is kept on every off tick so the deadline tick can measure; a counter
			// rollback or a new generation restarts it and the off window, and keeps the state.
			if (this.recordOff(st, view.sample, now)) return { kind: "none" }
			const measured = this.offMeasurement(st, view.sample, now)
			if (
				since >= PASSIVE_PROBATION_MS &&
				measured !== null &&
				this.validBaseline(st, now) !== null
			) {
				this.disabledAt.delete(sourceId)
				st.trialing = true
				this.expect(st, "trial")
				return { kind: "restore", why: "trial" }
			}
			if (!done) return { kind: "none" }
			if (u !== null && Number.isFinite(u))
				st.baseline = { value: u, others: st.others, at: now }
			st.window = { kind: "off", startedAt: now, sample: view.sample }
			const r = passiveGuardDecision({
				enabled: false,
				holders: "off",
				measurement: u,
				baseline: this.validBaseline(st, now),
				limit,
				judgementDue: true,
				baselineWindowAllowed: false,
				trialDue: since >= PASSIVE_PROBATION_MS,
				probationDue: false,
			})
			if (r.decision === "clear") {
				this.disabledAt.delete(sourceId)
				this.expect(st, "restore")
				return { kind: "restore", why: "clear" }
			}
			if (r.decision === "trial") {
				this.disabledAt.delete(sourceId)
				st.trialing = true
				this.expect(st, "trial")
				return { kind: "restore", why: "trial" }
			}
			return { kind: "none" }
		}
		if (!done) return { kind: "none" }
		// Rows 2 to 4 at the first completion, then every 300 s; trial and restore windows at their end (8.7).
		const deadline = w.kind === "trial" || w.kind === "restore"
		const judgementDue =
			deadline ||
			st.lastJudgedAt === null ||
			now - st.lastJudgedAt >= PASSIVE_COST_RECHECK_MS
		const allowed =
			st.lastBaselineWindowAt === null ||
			now - st.lastBaselineWindowAt >= PASSIVE_BASELINE_MAX_AGE_MS
		const r = passiveGuardDecision({
			enabled: true,
			holders,
			measurement: u,
			baseline: this.validBaseline(st, now),
			limit,
			judgementDue,
			baselineWindowAllowed: allowed,
			trialDue: false,
			probationDue: false,
		})
		if (r.row === 1) return { kind: "none" }
		if (judgementDue || r.decision !== "keep") {
			st.lastJudgedAt = now
			st.window = { kind: "judge", startedAt: now, sample: view.sample }
		}
		st.trialing = false
		if (r.decision === "disable") {
			this.disabledAt.set(sourceId, now)
			this.expect(st, "off")
			const pct = ((r.value ?? 0) * 100).toFixed(0)
			return {
				kind: "disable",
				reason:
					r.figure === "passive"
						? `passive-cpu ${pct} % of a core`
						: `engine-cpu ${pct} % of a core`,
				result: r,
			}
		}
		if (r.decision === "baseline") {
			this.measuring.add(sourceId)
			st.previousBaselineWindowAt = st.lastBaselineWindowAt
			st.lastBaselineWindowAt = now
			st.measuringSince = now
			this.expect(st, "baseline")
			return { kind: "measure", reason: MEASURING_REASON }
		}
		return { kind: "none" }
	}

	private restoreAfterBaseline(
		sourceId: string,
		st: SourceState,
		why: "baseline" | "abandon",
	): PassiveGuardAction {
		this.measuring.delete(sourceId)
		st.measuringSince = null
		this.expect(st, "restore")
		return { kind: "restore", why }
	}

	private expect(
		st: SourceState,
		next: NonNullable<SourceState["pending"]>,
	): void {
		st.pending = next
		st.toggling = true
		st.window = null
	}

	private complete(w: Window, now: number): boolean {
		return now - w.startedAt >= PASSIVE_COST_WINDOW_MS
	}

	private measure(w: Window, view: PassiveGuardView): number | null {
		// 8.2: no sample is no measurement (never the engine's whole-life average).
		if (view.sample === null) return null
		if (w.sample === null && w.kind !== "open") return null
		return windowedUtilization(view.sample, w.sample)
	}

	/**
	 * Adds an off tick's sample to the history, trimmed to the newest sample at least a window old.
	 * A sample of another generation or with a counter below the last one restarts the history and
	 * the off window at this tick (no whole-life fallback, 8.2); returns true when it did.
	 */
	private recordOff(
		st: SourceState,
		sample: EluSample | null,
		now: number,
	): boolean {
		if (
			sample === null ||
			!Number.isFinite(sample.idle) ||
			!Number.isFinite(sample.active)
		)
			return false
		const h = st.offSamples
		const last = h.at(-1)?.sample
		const restart =
			last !== undefined &&
			(sample.generation !== last.generation ||
				sample.idle < last.idle ||
				sample.active < last.active)
		if (restart) {
			h.length = 0
			st.window = { kind: "off", startedAt: now, sample }
		}
		h.push({ at: now, sample })
		while (h.length > 1 && (h[1]?.at ?? now) <= now - PASSIVE_COST_WINDOW_MS)
			h.shift()
		return restart
	}

	/**
	 * 8.2 at the trial start: utilization between the current sample and the history's sample of
	 * the same generation at least a window older; counters that did not advance are no measurement.
	 */
	private offMeasurement(
		st: SourceState,
		sample: EluSample | null,
		now: number,
	): number | null {
		const ref = st.offSamples[0]
		// the current sample must be the history's newest (null or non-finite ones are not recorded)
		if (
			sample === null ||
			ref === undefined ||
			st.offSamples.at(-1)?.sample !== sample ||
			now - ref.at < PASSIVE_COST_WINDOW_MS
		)
			return null
		const active = sample.active - ref.sample.active
		const total = active + (sample.idle - ref.sample.idle)
		if (!Number.isFinite(total) || total <= 0) return null
		return active / total
	}

	private validBaseline(st: SourceState, now: number): number | null {
		const b = st.baseline
		if (b === null || !Number.isFinite(b.value)) return null
		if (b.others !== st.others) return null
		if (now - b.at > PASSIVE_BASELINE_MAX_AGE_MS) return null
		return b.value
	}
}

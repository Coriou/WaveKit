// The tuned card's "On this band": the decoders whose band holds the tuned frequency, each with the core's one-line
// verdict (GET /api/decoders/summary) and, for one that does not run, its first suggested action as one control.
// Pure: what an action does is decided here, the card only carries it out.
import {
	DECODER_VERDICT_ACTIONS,
	DECODER_VERDICT_CODES,
	DECODER_VERDICT_TEXT_MAX_LENGTH,
} from "@wavekit/api-types"
import type {
	DecoderInfo,
	DecoderVerdictAction,
	DecoderVerdictCode,
	EfficiencyBudgetResolution,
	ScanJob,
} from "@wavekit/api-types"

import { formatMHz } from "../format.ts"
import { decoderLabel } from "./signal.ts"

/** The core's tuned-band reach (TUNED_TARGET_TOLERANCE_HZ): within 200 kHz of a target, of the span between targets, or of a band range. */
export const BAND_REACH_HZ = 200_000

/** A verdict as the card shows it; `code` is "unknown" for a code this app does not know. */
export interface BandVerdict {
	code: DecoderVerdictCode
	text: string
	/** Known actions only, most helpful first. */
	actions: DecoderVerdictAction[]
}

const CODES: ReadonlySet<string> = new Set(DECODER_VERDICT_CODES)
const ACTIONS: ReadonlySet<string> = new Set(DECODER_VERDICT_ACTIONS)

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * One summary item's verdict, read leniently: a code this app does not know reads "unknown" with
 * its text kept and no action; unknown actions are dropped. Null without a usable text.
 */
export function parseVerdict(raw: unknown): BandVerdict | null {
	if (!isRecord(raw)) return null
	const { code, text, actions } = raw
	if (typeof text !== "string" || text.trim() === "") return null
	const known = typeof code === "string" && CODES.has(code)
	return {
		code: known ? (code as DecoderVerdictCode) : "unknown",
		text: text.trim().slice(0, DECODER_VERDICT_TEXT_MAX_LENGTH),
		actions:
			known && Array.isArray(actions)
				? actions.filter(
						(a): a is DecoderVerdictAction =>
							typeof a === "string" && ACTIONS.has(a),
					)
				: [],
	}
}

/** GET /api/decoders/summary body → verdicts by decoder id; items without one are left out. */
export function verdictsById(body: unknown): Map<string, BandVerdict> {
	const out = new Map<string, BandVerdict>()
	if (!Array.isArray(body)) return out
	for (const item of body) {
		if (!isRecord(item) || typeof item["id"] !== "string") continue
		const verdict = parseVerdict(item["verdict"])
		if (verdict) out.set(item["id"], verdict)
	}
	return out
}

function targetsOf(d: DecoderInfo): number[] {
	return d.bandAssessment?.targetsHz ?? d.targetFrequenciesHz ?? []
}

/** Distance from `hz` to the decoder's band: 0 inside a range, else to the nearest target; Infinity without either. */
function bandDistance(d: DecoderInfo, hz: number): number {
	let best = Infinity
	for (const r of d.bandAssessment?.rangesHz ?? [])
		best = Math.min(
			best,
			hz < r.minHz ? r.minHz - hz : hz > r.maxHz ? hz - r.maxHz : 0,
		)
	for (const t of targetsOf(d)) best = Math.min(best, Math.abs(t - hz))
	return best
}

const positive = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n > 0

/**
 * The core's bandContainsTuned (src/decoders/enablement/tuned-band.ts), ported because the web cannot
 * import the core: within BAND_REACH_HZ of a target, between the lowest and highest target (a channel
 * cluster such as VDL2's), or inside a range widened by the reach. Malformed values never match.
 * web/tests/features/tuned-band-contract.test.ts holds the two to the same answers.
 */
export function bandHoldsHz(
	targetsHz: readonly number[] | undefined,
	rangesHz: readonly { minHz: number; maxHz: number }[] | undefined,
	hz: number,
): boolean {
	if (!positive(hz)) return false
	const reach = BAND_REACH_HZ
	const targets = Array.isArray(targetsHz) ? targetsHz.filter(positive) : []
	if (targets.some(t => Math.abs(t - hz) <= reach)) return true
	if (
		targets.length > 1 &&
		hz >= Math.min(...targets) - reach &&
		hz <= Math.max(...targets) + reach
	)
		return true
	return (Array.isArray(rangesHz) ? rangesHz : []).some(
		r =>
			r != null &&
			positive(r.minHz) &&
			positive(r.maxHz) &&
			r.minHz <= r.maxHz &&
			hz >= r.minHz - reach &&
			hz <= r.maxHz + reach,
	)
}

/** True when the decoder's band holds `hz` (the core's tuned-band rule). Scanner probes are not band decoders. */
export function onBand(d: DecoderInfo, hz: number): boolean {
	if (d.owner === "scanner") return false
	return bandHoldsHz(targetsOf(d), d.bandAssessment?.rangesHz, hz)
}

/** Opens Settings on a row (`dec.<id>` opens that decoder's row). */
export interface SettingsLink {
	kind: "settings"
	settingId: string
	label: string
	title: string
}

/** What a verdict action does from the card; null when it has no safe place to go. */
export type BandAction =
	| { kind: "decoder"; op: "start" | "restart"; label: string; title: string }
	| { kind: "tune"; hz: number; label: string; title: string }
	| { kind: "raise-budget"; label: string; title: string }
	| { kind: "stop-scan"; jobId: string; label: string; title: string }
	| { kind: "resume-source"; sourceId: string; label: string; title: string }
	| SettingsLink
	| { kind: "receiver"; label: string; title: string }

export interface ActionContext {
	/** The sweep that holds the decoders (scanHoldingDecoders), else null. */
	scanJobId: string | null
	/** The CPU budget as last read, else null (unknown: the raise is offered and checked on click). */
	budget: BudgetResolution | null
}

type BudgetResolution = Pick<EfficiencyBudgetResolution, "mode" | "cores"> & {
	cpus?: number
}

/**
 * The sweep's id while it holds the tuner lease and so the decoders: starting, running, holding on a
 * hit, or paused by the operator or a source drop (src/core/scanner/job-state.ts holdsLease). A pause
 * keeps both; only cancelling the job releases them. Null for any other state.
 */
export function scanHoldingDecoders(
	job: Pick<ScanJob, "id" | "state" | "reason"> | null,
): string | null {
	if (!job) return null
	switch (job.state) {
		case "starting":
		case "running":
		case "holding":
			return job.id
		case "paused":
			return job.reason === "operator" || job.reason === "source-down"
				? job.id
				: null
		default:
			return null
	}
}

/** The control for one action; links (Settings, Receiver) for actions with no safe one-click call. */
export function actionFor(
	action: DecoderVerdictAction,
	d: DecoderInfo,
	ctx: ActionContext,
): BandAction | null {
	const name = decoderLabel(d.type)
	const decoderRow = `dec.${d.id}`
	switch (action) {
		case "start":
			return {
				kind: "decoder",
				op: "start",
				label: "Start",
				title: `Start ${name} now`,
			}
		case "restart":
			return {
				kind: "decoder",
				op: "restart",
				label: "Restart",
				title: `Restart ${name}`,
			}
		case "tune-to-band": {
			const hz = targetsOf(d)[0]
			if (hz === undefined) return null
			return {
				kind: "tune",
				hz,
				label: `Tune to ${formatMHz(hz)}`,
				title: `Tune the receiver to ${formatMHz(hz)} MHz, in ${name}'s band`,
			}
		}
		case "raise-budget":
			if (ctx.budget !== null && raisedBudget(ctx.budget) === null) return null
			return {
				kind: "raise-budget",
				label: "Raise CPU budget",
				title:
					"Give automatic decoders one more CPU core (Settings › Decoders keeps the value)",
			}
		case "pause-scanner":
			if (ctx.scanJobId === null) return null
			return {
				kind: "stop-scan",
				jobId: ctx.scanJobId,
				label: "Stop the scan",
				title:
					"End the scan: it gives the tuner and the decoders back (a paused scan keeps them)",
			}
		case "turn-on":
			return {
				kind: "settings",
				settingId: decoderRow,
				label: "Turn on in Settings",
				title: `${name} is off in Settings: turn it on there`,
			}
		case "turn-off-others":
			return {
				kind: "settings",
				settingId: decoderRow,
				label: "Decoders in Settings",
				title: "Turn off decoders you do not need in Settings › Decoders",
			}
		case "install-decoder":
		case "enable-channelizer":
			return {
				kind: "settings",
				settingId: decoderRow,
				label: `${name} in Settings`,
				title:
					action === "install-decoder"
						? `${name}'s program is not installed: its Settings page shows the log`
						: `${name} needs the channelizer, set in the configuration file`,
			}
		case "raise-sample-rate":
		case "lower-sample-rate":
		case "change-sample-rate":
			return {
				kind: "receiver",
				label:
					action === "raise-sample-rate"
						? "Raise sample rate"
						: action === "lower-sample-rate"
							? "Lower sample rate"
							: "Change sample rate",
				title: "Opens the Receiver, where the sample rate is set",
			}
		case "check-source":
			return {
				kind: "receiver",
				label: "Check the receiver",
				title: "Opens the Receiver: its connection and sample rate",
			}
		case "resume-source":
			// without the decoder's source the Receiver island holds the Resume control
			return d.sourceId
				? {
						kind: "resume-source",
						sourceId: d.sourceId,
						label: "Resume",
						title: "Resume the receiver feed: the decoders start again",
					}
				: {
						kind: "receiver",
						label: "Open the Receiver",
						title: "The receiver is paused: resume it in the Receiver",
					}
	}
}

/** The verdict's one primary control: its first action the card can carry out or link to. */
export function primaryAction(
	verdict: BandVerdict,
	d: DecoderInfo,
	ctx: ActionContext,
): BandAction | null {
	if (verdict.code === "unknown") return null
	for (const a of verdict.actions) {
		const view = actionFor(a, d, ctx)
		if (view) return view
	}
	return null
}

export interface BandDecoderRow {
	id: string
	name: string
	/** Running on this band: decoding or listening. */
	listening: boolean
	/** The core's sentence, else one made from the status (cores without a summary verdict). */
	text: string
	action: BandAction | null
}

const LISTENING: ReadonlySet<DecoderVerdictCode> = new Set([
	"decoding",
	"listening",
])

/**
 * The decoders on the tuned band: listening ones first, then the rest, nearest band first. A decoder
 * without a verdict (an older core) reads from its status and offers no action. A decoder off in
 * Settings now only ever offers turning it on there, whatever its (possibly older) verdict says.
 */
export function bandDecoders(
	decoders: readonly DecoderInfo[],
	verdicts: ReadonlyMap<string, BandVerdict> | null,
	hz: number,
	ctx: ActionContext,
): BandDecoderRow[] {
	const rows = decoders
		.filter(d => onBand(d, hz))
		.map(d => {
			const name = decoderLabel(d.type)
			const verdict = verdicts?.get(d.id) ?? null
			if (d.mode === "off")
				return {
					row: {
						id: d.id,
						name,
						listening: false,
						text:
							verdict?.code === "off"
								? verdict.text
								: `${name} off in Settings`,
						action: actionFor("turn-on", d, ctx),
					},
					dist: bandDistance(d, hz),
				}
			if (!verdict) {
				const runs = d.running && !d.suspended
				return {
					row: {
						id: d.id,
						name,
						listening: runs,
						text: `${name} ${runs ? "running" : d.suspended ? "paused" : "not running"}`,
						action: null,
					},
					dist: bandDistance(d, hz),
				}
			}
			const listening = LISTENING.has(verdict.code)
			return {
				row: {
					id: d.id,
					name,
					listening,
					text: verdict.text,
					action: listening ? null : primaryAction(verdict, d, ctx),
				},
				dist: bandDistance(d, hz),
			}
		})
	rows.sort(
		(a, b) =>
			Number(b.row.listening) - Number(a.row.listening) || a.dist - b.dist,
	)
	return rows.map(r => r.row)
}

/**
 * The largest budget PUT /api/decoders/efficiency/budget accepts: CpuBudgetSchema's bound in
 * src/decoders/enablement/cpu-budget.ts (no shared constant; a test holds the two equal).
 */
export const BUDGET_MAX_CORES = 64

/**
 * The budget one click asks for: exactly one more core than today, capped at the host's CPUs (auto)
 * and at BUDGET_MAX_CORES; null when already at the cap.
 */
export function raisedBudget(resolved: BudgetResolution): number | null {
	const ceiling =
		resolved.mode === "auto" && resolved.cpus
			? Math.min(resolved.cpus, BUDGET_MAX_CORES)
			: BUDGET_MAX_CORES
	// two decimals keep 1.1 + 1 at 2.1, not 2.1000000000000005
	const next = Math.min(ceiling, Math.round((resolved.cores + 1) * 100) / 100)
	return next > resolved.cores ? next : null
}

// The tuned card's "On this band" building blocks: the core's verdicts (GET /api/decoders/summary) read leniently,
// the tuned-band rule for cores without `coversHz`, and what each suggested action does from the card (the table's
// rows are band-table.ts). Pure: what an action does is decided here, the card only carries it out.
import {
	DECODER_VERDICT_ACTIONS,
	DECODER_VERDICT_CODES,
	DECODER_VERDICT_TEXT_MAX_LENGTH,
} from "@wavekit/api-types"
import type {
	Bandplan,
	DecoderInfo,
	DecoderVerdictAction,
	DecoderVerdictCode,
	EfficiencyBudgetResolution,
	ScanJob,
	ScanRange,
} from "@wavekit/api-types"

import { formatMHz } from "../format.ts"
import { planListsHz } from "./decoder-protocols.ts"
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

/**
 * True when the decoder's own band holds `hz`, for cores whose summary has no `coversHz` and while the summary
 * cannot be read: the core's decoderCoversHz (src/api/routes/decoder-summary.ts). The band assessment's targets
 * and ranges decide when it names any; else the configured targets (at boot, before the first assessment, or an
 * assessment that names no band); else a decoder with no band of its own (a pager, digital voice) covers `hz`
 * where a band plan range there lists one of its protocols (planListsHz). `planRanges` is the core's band plan as
 * GET /api/scanner/bandplans serves it (the effective region's plan); null while not loaded, when only the first
 * two apply. Scanner probes and ephemeral decoders never cover.
 */
export function onBand(
	d: DecoderInfo,
	hz: number,
	planRanges:
		| readonly Pick<ScanRange, "startHz" | "endHz" | "protocols">[]
		| null = null,
): boolean {
	if (d.owner === "scanner" || d.ephemeral === true) return false
	const band = d.bandAssessment
	const targets = Array.isArray(band?.targetsHz) ? band.targetsHz : []
	const ranges = Array.isArray(band?.rangesHz) ? band.rangesHz : []
	if (targets.length > 0 || ranges.length > 0)
		return bandHoldsHz(targets, ranges, hz)
	const configured = Array.isArray(d.targetFrequenciesHz)
		? d.targetFrequenciesHz.filter(positive)
		: []
	if (configured.length > 0) return bandHoldsHz(configured, undefined, hz)
	return planListsHz(d.type, planRanges ?? [], hz)
}

/** The ranges of the core's band plans (GET /api/scanner/bandplans), for onBand; null while not loaded. */
export function planRangesOf(
	plans: readonly Pick<Bandplan, "ranges">[] | null,
): ScanRange[] | null {
	return plans === null ? null : plans.flatMap(p => p.ranges)
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
	}
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

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
} from "@wavekit/api-types"

import { formatMHz } from "../format.ts"
import { decoderLabel } from "./signal.ts"

/** The core's tuned-band reach: within 200 kHz of a target, or inside a band range (DECODER-GUIDE "Decoders start when you tune"). */
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

/** True when the decoder's band holds `hz` (the core's tuned-band rule). Scanner probes are not band decoders. */
export function onBand(d: DecoderInfo, hz: number): boolean {
	if (d.owner === "scanner") return false
	const inRange = (d.bandAssessment?.rangesHz ?? []).some(
		r => hz >= r.minHz && hz <= r.maxHz,
	)
	return inRange || bandDistance(d, hz) <= BAND_REACH_HZ
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
	| { kind: "pause-scan"; jobId: string; label: string; title: string }
	| SettingsLink
	| { kind: "receiver"; label: string; title: string }

export interface ActionContext {
	/** The running scan job, else null. */
	scanJobId: string | null
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
			return {
				kind: "raise-budget",
				label: "Raise CPU budget",
				title:
					"Give automatic decoders one more CPU core (Settings › Decoders keeps the value)",
			}
		case "pause-scanner":
			if (ctx.scanJobId === null) return null
			return {
				kind: "pause-scan",
				jobId: ctx.scanJobId,
				label: "Pause the scan",
				title: "Pause the scan so the decoders have the tuner",
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
 * without a verdict (an older core) reads from its status and offers no action.
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

/** The budget one click asks for: one more core than today, at most the host's CPUs (auto) or 64. */
export function raisedBudget(resolved: {
	mode: "auto" | "configured"
	cores: number
	cpus?: number
}): number | null {
	const ceiling = resolved.mode === "auto" && resolved.cpus ? resolved.cpus : 64
	const next = Math.min(ceiling, Math.floor(resolved.cores) + 1)
	return next > resolved.cores ? next : null
}

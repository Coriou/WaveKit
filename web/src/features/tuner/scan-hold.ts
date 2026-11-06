// The Tuner's scan hold row (docs/web/canvas/Tuner.dc.html `hold`, DESIGN.md "Scanner UX review" and "Scanner second
// pass"): the only status and control of a running sweep. Pure: what the row says and which buttons it has for a job.
import type {
	Discovery,
	Impact,
	ScanJob,
	ScanJobSpec,
	ScannerActivityEventData,
	ScannerProgressEventData,
} from "@wavekit/api-types"

import { errorMessage } from "../../data/api-client.ts"
import {
	discoveryTitle,
	formatWait,
	jobStateLine,
	scanPhaseText,
	sweepProgress,
} from "../../data/scanner-format.ts"
import { takeoverImpact } from "../../data/scanner-store.ts"
import { formatMHz } from "../format.ts"
import { decoderLabel } from "../tuned/signal.ts"

export type HoldGlyph = "scan" | "eye" | "pause" | "plug" | "warn"

export type HoldActionId =
	| "pause"
	| "resume"
	| "takeover"
	| "stay"
	| "stop"
	| "skip"
	| "ignore"
	| "save"

export interface HoldAction {
	id: HoldActionId
	/** Visible label; empty for an icon-only button (then `aria` names it). */
	label: string
	aria: string
	title: string
	kind: "primary" | "chip" | "ghost"
	icon: "pause" | "play" | "stop" | "skip" | "ignore" | "star" | null
	/** Save only: the frequency is already saved (filled star). */
	pressed?: boolean
}

export interface HoldRowModel {
	/** live: accent (running, holding, starting); paused: amber. */
	tone: "live" | "paused"
	/** A pulsing live dot instead of the glyph (holding on a hit). */
	pulse: boolean
	glyph: HoldGlyph
	/** Bold, in the row's colour. */
	title: string
	/** After the title, quiet (starts with " · " when set). */
	detail: string
	/** The frequency the scan is on, bold, right of the words; null when not shown. */
	freq: string | null
	actions: HoldAction[]
	/** The pass-progress line (0..1), or null when hidden (one hop, ended). */
	bar: number | null
	/** Tooltip of the row. */
	tooltip: string
	/** Accessible name of the row's open-plan button. */
	aria: string
}

type HoldJob = Pick<
	ScanJob,
	| "id"
	| "name"
	| "state"
	| "reason"
	| "resumeAt"
	| "resumeHeldBy"
	| "preemptedBy"
	| "impact"
	| "progress"
	| "plan"
>

export interface HoldRowInput {
	job: HoldJob
	/** The sweep's latest progress (layer.scanner.progress); falls back to the job's own. */
	progress: Pick<
		ScannerProgressEventData,
		| "sweepIndex"
		| "hopIndex"
		| "hopCount"
		| "centerHz"
		| "phase"
		| "parked"
		| "holding"
		| "trial"
		| "replayQueueDepth"
	> | null
	now: number
	/** The frequency held on (heldFrequencyHz), when holding. */
	heldHz: number | null
	/** The discovery held on, when known. */
	held: Discovery | null
	/** The held frequency is already a saved frequency. */
	saved: boolean
	/** Resume was refused for lack of consent: what it would interrupt. */
	consent: Impact | null
	/** How the row names a decoder id (decoderNamer). */
	decoderName: (id: string) => string
	/** Read-only access: the row only reports. */
	readOnly?: boolean
}

/** Only heard: no protocol named yet ("Heard"), so the row says "activity" and Listen the frequency. */
function heardOnly(d: Pick<Discovery, "confidence" | "protocol">): boolean {
	return d.confidence === "activity" || d.protocol === "unknown"
}

/** The scan's name for the row: the job's name, else "Scan". */
export function jobName(job: Pick<ScanJob, "name">): string {
	const n = job.name?.trim()
	return n ? n : "Scan"
}

/** "146.9625", "161.150": the frequency a scan is on, short (canvas sfmt). */
export function scanFreq(hz: number): string {
	return formatMHz(hz)
}

/** "446.000–446.200": a band in MHz with three decimals. */
function bandText(startHz: number, endHz: number): string {
	return `${(startHz / 1e6).toFixed(3)}–${(endHz / 1e6).toFixed(3)}`
}

/** The plan's covered band (first hop start to last hop end), or null without hops. */
function planBand(
	plan: Pick<ScanJob["plan"], "hops">,
): { startHz: number; endHz: number } | null {
	const hops = plan.hops
	if (hops.length === 0) return null
	let a = Infinity
	let b = -Infinity
	for (const h of hops) {
		a = Math.min(a, h.covered.startHz)
		b = Math.max(b, h.covered.endHz)
	}
	return Number.isFinite(a) && Number.isFinite(b)
		? { startHz: a, endHz: b }
		: null
}

const PAUSE: HoldAction = {
	id: "pause",
	label: "Pause",
	aria: "Pause",
	title: "Pause the scan. It keeps the receiver until you tune.",
	kind: "primary",
	icon: null,
}
const STOP: HoldAction = {
	id: "stop",
	label: "",
	aria: "Stop the scan",
	title: "End the scan. The receiver and decoders are yours again.",
	kind: "ghost",
	icon: "stop",
}

/**
 * Who a takeover interrupts, for its button: listeners, decoders, other scans. Decoders of one type read "2 APRS", so a
 * changed set shows. Empty: only untouchable tuner fields.
 */
export function consentNames(
	impact: Impact,
	decoderName: (id: string) => string,
): string[] {
	const count = (n: number, one: string, many: string) =>
		n === 0 ? [] : [n === 1 ? `1 ${one}` : `${n} ${many}`]
	const scans = impact.scannerJobs.length
	const decoders = new Map<string, number>()
	for (const id of new Set([
		...impact.runningDecoders,
		...impact.pinnedDecoders,
	])) {
		const label = decoderName(id)
		decoders.set(label, (decoders.get(label) ?? 0) + 1)
	}
	return [
		...count(impact.liveAudioClients, "listener", "listeners"),
		...count(
			impact.digitalVoiceListeners,
			"digital voice listener",
			"digital voice listeners",
		),
		...[...decoders].map(([label, n]) => (n === 1 ? label : `${n} ${label}`)),
		...(scans === 0 ? [] : [scans === 1 ? "another scan" : `${scans} scans`]),
	]
}

/** What a refused resume means here: ask who may be interrupted, or say why not. */
export type ResumeRefusal =
	| { kind: "consent"; impact: Impact }
	| { kind: "error"; message: string }

export function resumeRefusal(error: unknown): ResumeRefusal {
	const impact = takeoverImpact(error)
	return impact
		? { kind: "consent", impact }
		: { kind: "error", message: errorMessage(error) }
}

/** How the scan surfaces name a decoder id: its type's label, or the id for one not listed. */
export function decoderNamer(
	decoders: readonly { id: string; type: string }[],
): (id: string) => string {
	return id => decoderLabel(decoders.find(d => d.id === id)?.type ?? id)
}

/**
 * What a click on Resume agrees to interrupt: the impact its button came from. A confirm's impact, or, on a scan blocked
 * by someone new, the one the job reports. Null: a plain Resume that named nobody, so it agrees to nothing. A confirm
 * whose impact names nobody is "Resume anyway", which agrees to the tuner fields the core reported.
 */
export function resumeApproved(
	job: Pick<ScanJob, "reason" | "impact">,
	consent: Impact | null,
): Impact | null {
	if (consent) return consent
	if (job.reason !== "resume-blocked" || !job.impact) return null
	return consentNames(job.impact, id => id).length > 0 ? job.impact : null
}

/** Whether a fresh impact holds nothing beyond the approved one, by the same facts as the core's own consent check. */
function approvedCovers(approved: Impact | null, fresh: Impact): boolean {
	if (approved === null) return false
	const within = (ids: readonly string[], agreed: readonly string[]) =>
		ids.every(id => agreed.includes(id))
	return (
		fresh.liveAudioClients <= approved.liveAudioClients &&
		fresh.digitalVoiceListeners <= approved.digitalVoiceListeners &&
		within(fresh.runningDecoders, approved.runningDecoders) &&
		within(fresh.pinnedDecoders, approved.pinnedDecoders) &&
		within(fresh.scannerJobs, approved.scannerJobs) &&
		within(fresh.unrestorable, approved.unrestorable)
	)
}

/** Tells a request's response apart from one superseded by a newer request or another job. */
export interface LatestRequest {
	/** Starts a request; the result says whether it is still the latest. */
	begin(): () => boolean
	/** Supersedes the request in flight, if any. */
	cancel(): void
}

export function latestRequest(): LatestRequest {
	let latest = 0
	return {
		begin() {
			const mine = ++latest
			return () => mine === latest
		},
		cancel() {
			latest++
		},
	}
}

export type ResumeOutcome =
	| { kind: "resumed" }
	/** Ask first: this impact becomes what the next click approves. */
	| { kind: "confirm"; impact: Impact }
	| { kind: "error"; message: string }
	/** A newer request or another job took over: show nothing. */
	| { kind: "superseded" }

export interface ResumeWithConsentInput {
	jobId: string
	/** The impact behind the clicked button (resumeApproved). */
	approved: Impact | null
	resume: (id: string, options: { takeover?: boolean }) => Promise<unknown>
	/** From latestRequest().begin(). */
	current: () => boolean
}

/**
 * One click on Resume. A plain resume goes first, because it may no longer need anyone's consent. A consent refusal is
 * answered with a takeover in the same click only if the core's fresh impact holds nothing the button's did not;
 * otherwise the fresh impact goes back to the user as a confirm. The API has no takeover bound to an impact, so someone
 * who arrives in the tiny window between the two requests is still interrupted unnamed.
 */
export async function resumeWithConsent({
	jobId,
	approved,
	resume,
	current,
}: ResumeWithConsentInput): Promise<ResumeOutcome> {
	const attempt = async (options: {
		takeover?: boolean
	}): Promise<ResumeRefusal | null> => {
		try {
			await resume(jobId, options)
			return null
		} catch (err) {
			return resumeRefusal(err)
		}
	}
	const answer = (refusal: ResumeRefusal | null): ResumeOutcome => {
		if (!current()) return { kind: "superseded" }
		if (refusal === null) return { kind: "resumed" }
		return refusal.kind === "consent"
			? { kind: "confirm", impact: refusal.impact }
			: refusal
	}
	const plain = await attempt({})
	if (
		!current() ||
		plain?.kind !== "consent" ||
		!approvedCovers(approved, plain.impact)
	)
		return answer(plain)
	return answer(await attempt({ takeover: true }))
}

/**
 * Whether Resume can do anything. Two waits have no button, because the core would only refuse: another
 * scan holds the receiver (preempted-job) or the source is gone (source-down). Both carry on by themselves.
 */
export function scanResumable(job: Pick<ScanJob, "state" | "reason">): boolean {
	return (
		job.state === "paused" &&
		job.reason !== "preempted-job" &&
		job.reason !== "source-down"
	)
}

/** The button that names who a takeover interrupts: a confirm, or Resume on a scan blocked by someone new. */
export function consentAction(consent: readonly string[]): HoldAction {
	const label =
		consent.length === 0
			? "Resume anyway"
			: consent.length <= 2
				? `Resume and interrupt ${consent.join(", ")}`
				: `Resume and interrupt ${consent.slice(0, 2).join(", ")} +${consent.length - 2}`
	return {
		id: "takeover",
		label,
		aria: label,
		title:
			consent.length > 0
				? `Resumes the scan. ${consent.join(", ")} stop until the scan ends.`
				: "Resumes the scan and takes the receiver.",
		kind: "primary",
		icon: "play",
	}
}

function splitLine(line: string): { title: string; detail: string } {
	const at = line.indexOf(" · ")
	return at < 0
		? { title: line, detail: "" }
		: { title: line.slice(0, at), detail: line.slice(at) }
}

/** What the hold row shows for a live (pending … paused) sweep job. */
export function holdRowModel(input: HoldRowInput): HoldRowModel {
	const { job, now, heldHz, held, saved, consent } = input
	const name = jobName(job)
	const p = input.progress ?? {
		sweepIndex: job.progress.sweepIndex,
		hopIndex: job.progress.hopIndex,
		hopCount: job.progress.hopCount,
		centerHz: job.plan.hops[job.progress.hopIndex]?.centreHz ?? 0,
	}
	const prog = sweepProgress(p)
	// WG12: a window that fits parks the receiver, like one hop
	const oneHop =
		prog.hopCount === 1 || (input.progress ?? job.progress).parked === true
	const band = planBand(job.plan)
	const how = oneHop
		? band
			? `One hop: the receiver stays at ${scanFreq(p.centerHz)} and watches ${bandText(band.startHz, band.endHz)}`
			: "One hop"
		: `${prog.text}${job.progress.sweepPeriodMs ? ` · full pass ≈ ${formatWait(job.progress.sweepPeriodMs)}` : ""}`

	let tone: HoldRowModel["tone"] = "live"
	let pulse = false
	let glyph: HoldGlyph = "scan"
	let title = name
	let detail = ""
	let freq: string | null = null
	let actions: HoldAction[] = [STOP]
	let bar: number | null = oneHop ? null : prog.fraction
	/** The full words for the tooltip and the accessible name, when the row shows fewer. */
	let full: string | null = null

	switch (job.state) {
		case "pending":
		case "starting":
			detail = " · starting"
			bar = oneHop ? null : 0.03
			break
		case "running":
			if (oneHop) {
				glyph = "eye"
				title = `Watching ${name}`
				freq = band ? bandText(band.startHz, band.endHz) : null
			} else freq = p.centerHz > 0 ? scanFreq(p.centerHz) : null
			{
				// WG12: what the scan is doing now, when it is more than scanning or watching
				const phase = scanPhaseText(input.progress ?? job.progress)
				if (phase !== null && phase !== "Watching")
					detail = ` · ${phase.charAt(0).toLowerCase()}${phase.slice(1)}`
			}
			actions = [PAUSE, STOP]
			break
		case "holding": {
			pulse = true
			title = held
				? `Hearing ${heardOnly(held) && !held.operator?.label?.trim() ? "activity" : discoveryTitle(held)}`
				: splitLine(jobStateLine(job, { now, heldHz })).title
			// without a discovery yet, "Held on 146.9625" already names the frequency
			freq = held ? scanFreq(heldHz ?? held.frequencyHz) : null
			actions = [
				{
					id: "skip",
					label: "Skip",
					aria: "Skip",
					title: "Move on and leave it out for the rest of this scan",
					kind: "chip",
					icon: "skip",
				},
				{
					id: "ignore",
					label: "Ignore",
					aria: "Ignore",
					title: held
						? "Always: never probed, recorded or scanned again"
						: "Waiting for the scan to name this signal",
					kind: "chip",
					icon: "ignore",
				},
				{
					id: "save",
					label: "",
					aria: saved ? "Saved" : "Save frequency",
					title: saved ? "Saved" : "Save frequency",
					kind: "chip",
					icon: "star",
					pressed: saved,
				},
				STOP,
			]
			break
		}
		case "paused": {
			tone = "paused"
			glyph = "pause"
			const line = splitLine(jobStateLine(job, { now }))
			if (consent) {
				glyph = "warn"
				title = "Resume needs your OK"
				detail = ""
				actions = [
					consentAction(consentNames(consent, input.decoderName)),
					STOP,
				]
				break
			}
			switch (job.reason) {
				case "preempted-operator":
				case "preempted-relay": {
					// "Scan paused · you tuned · resumes in 42 s": Stay here keeps it paused, Resume now takes it back.
					// With three buttons the row shows "Scan paused · resumes in 42 s"; the tooltip says who tuned.
					title = line.title
					detail = line.detail.replace(
						/ · (you tuned|a relay client tuned)(?= · resumes)/,
						"",
					)
					if (detail !== line.detail) full = `${line.title}${line.detail}`
					if (job.reason === "preempted-relay") glyph = "plug"
					actions = [
						{
							id: "stay",
							label: "Stay here",
							aria: "Stay here",
							title: "Keep the scan paused. It will not resume on its own.",
							kind: "primary",
							icon: null,
						},
						{
							id: "resume",
							label: "Resume now",
							aria: "Resume now",
							title: "Takes the receiver again",
							kind: "ghost",
							icon: null,
						},
						STOP,
					]
					break
				}
				case "resumed-without-retune":
					// The receiver came back without retuning (another client may be on it): the scan
					// hops again only on this explicit choice.
					title = "Scan paused"
					detail = line.detail
					actions = [
						{
							id: "resume",
							label: "Resume scan",
							aria: "Resume scan",
							title: "Retunes the receiver to the scan's current hop",
							kind: "primary",
							icon: "play",
						},
						STOP,
					]
					break
				case "preempted-job":
				case "source-down":
					if (job.reason === "source-down") glyph = "plug"
					title = line.title
					detail = `${line.detail} · carries on when ${job.reason === "source-down" ? "it returns" : "it ends"}`
					actions = [STOP]
					break
				case "resume-blocked": {
					// Automatic resume found someone new on the receiver: the button names them, so one click is
					// an informed one. It asks first if the core reports anyone it did not name.
					title = "Scan paused"
					detail = " · someone else is using the receiver"
					const approved = resumeApproved(job, null)
					actions = [
						approved
							? consentAction(consentNames(approved, input.decoderName))
							: {
									id: "resume",
									label: "Resume",
									aria: "Resume",
									title:
										"Carry on where it left off. Asks first if it interrupts anyone.",
									kind: "primary",
									icon: "play",
								},
						STOP,
					]
					break
				}
				default:
					title = line.title === "Paused" ? "Scan paused" : line.title
					detail = line.detail
					actions = [
						{
							id: "resume",
							label: "Resume",
							aria: "Resume",
							title: "Carry on where it left off",
							kind: "primary",
							icon: "play",
						},
						STOP,
					]
			}
			break
		}
		default:
			// ended: the row leaves with the job (the store drops ended sweeps)
			title = jobStateLine(job, { now })
			actions = []
			bar = null
	}
	if (input.readOnly) actions = []
	const words = `${full ?? `${title}${detail}`}${freq ? ` · ${freq}` : ""}`
	return {
		tone,
		pulse,
		glyph,
		title,
		detail,
		freq,
		actions,
		bar,
		tooltip: `${words}${title.startsWith(name) || title.endsWith(name) ? "" : ` · ${name}`} · ${how} · open the scan plan`,
		aria: `${words}. Open the scan plan`,
	}
}

/** Whether the sweep is moving the receiver (the tuned card hides; Listen follows the scan). */
export function sweepMoving(state: ScanJob["state"] | undefined): boolean {
	return state === "pending" || state === "starting" || state === "running"
}

/** Whether the sweep is live (moving or holding on a hit): Listen says it follows the scan. */
export function sweepLive(state: ScanJob["state"] | undefined): boolean {
	return sweepMoving(state) || state === "holding"
}

/**
 * The discovery a holding job sits on: an active observation credited to the job with a discovery,
 * nearest the held frequency (else the strongest). Null when none is known yet.
 */
export function heldDiscoveryId(
	job: Pick<ScanJob, "id">,
	activity: Iterable<
		Pick<
			ScannerActivityEventData,
			"discoveryId" | "jobIds" | "frequencyHz" | "peakDbfs" | "active"
		>
	>,
	heldHz: number | null,
): string | null {
	let best: {
		id: string
		dist: number
		peak: number
	} | null = null
	for (const a of activity) {
		if (!a.active || !a.discoveryId || !a.jobIds.includes(job.id)) continue
		const dist = heldHz === null ? 0 : Math.abs(a.frequencyHz - heldHz)
		if (
			!best ||
			dist < best.dist ||
			(dist === best.dist && a.peakDbfs > best.peak)
		)
			best = { id: a.discoveryId, dist, peak: a.peakDbfs }
	}
	return best?.id ?? null
}

/** The reason a Skip writes on its exclusion; it tells a Skip apart from the plan's own skips. */
export const SKIP_REASON = "Skipped"

/**
 * Skip: the job's exclusions plus the held channel (± half its bandwidth, at least 6.25 kHz), for
 * PATCH /api/scanner/jobs/:id. Core drops the frequency at the next hop for the rest of this scan.
 */
export function skipPatch(
	job: Pick<ScanJob, "spec">,
	hz: number,
	bandwidthHz: number | null | undefined,
): ScanJobSpec {
	const half = Math.max(6_250, Math.round((bandwidthHz ?? 12_500) / 2))
	const startHz = Math.round(hz - half)
	const endHz = Math.round(hz + half)
	const have = job.spec.exclusions
	if (have.some(e => e.startHz <= startHz && e.endHz >= endHz))
		return { exclusions: have }
	return {
		exclusions: [...have, { startHz, endHz, reason: SKIP_REASON }],
	}
}

/** How a frequency sits in the job's skips: "you" (a Skip from this scan, removable), "plan" (the plan's), or null. */
export function skipState(
	job: Pick<ScanJob, "spec">,
	hz: number,
): "you" | "plan" | null {
	let plan = false
	for (const e of job.spec.exclusions) {
		if (hz < e.startHz || hz > e.endHz) continue
		if (e.reason === SKIP_REASON) return "you"
		plan = true
	}
	return plan ? "plan" : null
}

/** Undoes Skip: the job's exclusions without the "Skipped" ones that hold `hz`. */
export function unskipPatch(
	job: Pick<ScanJob, "spec">,
	hz: number,
): ScanJobSpec {
	return {
		exclusions: job.spec.exclusions.filter(
			e => e.reason !== SKIP_REASON || hz < e.startHz || hz > e.endHz,
		),
	}
}

/** The name "Save" gives a held signal: the operator's label, else its one-line title ("DMR · CC 1"), else `fallback`. */
export function holdSaveName(d: Discovery | null, fallback: string): string {
	if (!d) return fallback
	const label = d.operator?.label?.trim()
	if (label) return label
	return heardOnly(d) ? fallback : discoveryTitle(d)
}

/**
 * What Listen says while live audio follows a sweep (Immersive board `followingText`): the held signal's name or
 * frequency on a hit, "Waits for a channel" for a one-hop watch, else "Following the scan".
 */
export function followingText(
	job: Pick<ScanJob, "state" | "progress">,
	heldHz: number | null,
	held: Discovery | null,
): { text: string; title: string } {
	if (job.state === "holding" && (held || heldHz !== null)) {
		const named = held && (!heardOnly(held) || held.operator?.label?.trim())
		const text = named
			? discoveryTitle(held)
			: scanFreq(heldHz ?? held?.frequencyHz ?? 0)
		return {
			text,
			title: `The scan moved the audio to ${text} and plays it until it goes quiet`,
		}
	}
	if (job.progress.hopCount === 1)
		return {
			text: "Waits for a channel",
			title: "Waits for a channel · the scan keeps the receiver where it is",
		}
	return {
		text: "Following the scan",
		title:
			"Live audio follows the scan: you hear each hop and every signal it holds on",
	}
}

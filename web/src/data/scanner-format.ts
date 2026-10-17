/**
 * Words for scanner data (docs/web/DESIGN.md, Scanner): confidence, protocol names, identities,
 * failure reasons, job state lines and sweep progress. Pure; no raw core ids reach the UI.
 */
import type {
	Discovery,
	Identity,
	IdentityKind,
	JobState,
	ScanJob,
	ScannerConfidence,
	ScannerProtocol,
	ScannerTrialOutcome,
} from "@wavekit/api-types"
import { formatMHz } from "../features/format.ts"

const PROTOCOL_NAMES: Readonly<Record<ScannerProtocol, string>> = {
	"analog-fm": "FM voice",
	"analog-am": "AM voice",
	dmr: "DMR",
	p25p1: "P25",
	p25p2: "P25",
	nxdn48: "NXDN",
	nxdn96: "NXDN",
	ysf: "YSF",
	dstar: "D-STAR",
	dpmr: "dPMR",
	pocsag: "POCSAG",
	flex: "FLEX",
	aprs: "APRS",
	ism: "ISM",
	lora: "LoRa",
	ais: "AIS",
	acars: "ACARS",
	vdl2: "VDL2",
	"digital-unknown": "Digital",
	carrier: "Carrier",
	unknown: "Unknown",
}

/** "FM voice", "DMR", "P25"…; an id this build does not know reads "Unknown". */
export function protocolName(protocol: ScannerProtocol | string): string {
	return Object.hasOwn(PROTOCOL_NAMES, protocol)
		? PROTOCOL_NAMES[protocol as ScannerProtocol]
		: "Unknown"
}

const CONFIDENCE_RANK: Readonly<Record<ScannerConfidence, number>> = {
	activity: 0,
	candidate: 1,
	classified: 2,
	decoded: 3,
}

/** 0 (activity) to 3 (decoded); for sorting and `minConfidence` checks. */
export function confidenceRank(confidence: ScannerConfidence): number {
	return CONFIDENCE_RANK[confidence]
}

/**
 * Confidence in words: "Heard" (activity), "Maybe DMR" (candidate), "Likely DMR" (classified),
 * "DMR" (decoded). A protocol nobody could name (unknown) stays "Heard"; a carrier is "Carrier".
 */
export function confidenceText(
	d: Pick<Discovery, "confidence" | "protocol">,
): string {
	if (d.confidence === "activity" || d.protocol === "unknown") return "Heard"
	const name = protocolName(d.protocol)
	if (d.protocol === "carrier" || d.confidence === "decoded") return name
	return d.confidence === "candidate" ? `Maybe ${name}` : `Likely ${name}`
}

/** Why the confidence is capped: second-line words, or null. */
export function confidenceCapText(
	cap: Discovery["confidenceCap"] | undefined,
): string | null {
	if (cap === "adjacent-leak") return "May be a neighbour's leak"
	if (cap === "suspected-intermod") return "May be intermodulation"
	return null
}

const UNDECODED: Readonly<
	Record<NonNullable<Discovery["undecodedReason"]>, string>
> = {
	"no-sync": "No sync",
	"crc-errors": "CRC errors",
	timeout: "Timed out",
	"no-probe-transport": "No decoder route",
	budget: "Skipped (busy)",
	"unsupported-format": "Unsupported format",
}

/** Why a decode failed, in words ("No sync", "CRC errors", "Timed out"…), or null. */
export function undecodedReasonText(
	reason: Discovery["undecodedReason"] | undefined,
): string | null {
	return reason === undefined ? null : UNDECODED[reason]
}

const TRIAL_OUTCOMES: Readonly<Record<ScannerTrialOutcome, string>> = {
	pending: "Waiting",
	running: "Trying",
	decoded: "Decoded",
	"no-sync": "No sync",
	"crc-errors": "CRC errors",
	timeout: "Timed out",
	"skipped-budget": "Skipped (busy)",
	unsupported: "Needs S2",
	"not-needed": "Not needed",
	cancelled: "Stopped",
}

/** An identify trial's outcome in words (DESIGN.md "Identify in the tuned card"). */
export function trialOutcomeText(outcome: ScannerTrialOutcome): string {
	return TRIAL_OUTCOMES[outcome]
}

const IDENTITY_PREFIX: Readonly<Record<IdentityKind, string>> = {
	"dmr-cc": "CC",
	"p25-nac": "NAC",
	"nxdn-ran": "RAN",
	"ysf-dgid": "DG-ID",
	"dstar-call": "",
	"dpmr-cc": "CC",
	"pocsag-capcode": "Capcode",
	"aprs-call": "",
	"ism-model": "",
	"ais-mmsi": "MMSI",
	"acars-reg": "",
	"vdl2-addr": "Address",
	"lora-node": "Node",
}

/** "CC 1", "NAC 293", "Capcode 1234567", "MMSI 235…"; callsigns, registrations and models as they are. */
export function identityText(identity: Identity | undefined | null): string {
	if (!identity) return ""
	const value = identity.value.trim()
	const prefix = Object.hasOwn(IDENTITY_PREFIX, identity.kind)
		? IDENTITY_PREFIX[identity.kind]
		: ""
	return prefix ? `${prefix} ${value}` : value
}

/** The `identity` query parameter of GET /api/scanner/discoveries: `kind:value`. */
export function identityQuery(identity: Identity): string {
	return `${identity.kind}:${identity.value}`
}

/** "DMR · CC 1", "FM voice", "Maybe DMR": a discovery's one-line name (label wins when set). */
export function discoveryTitle(d: Discovery): string {
	const label = d.operator?.label?.trim()
	if (label) return label
	const id = identityText(d.identity)
	const what = confidenceText(d)
	return id ? `${what} · ${id}` : what
}

// ---- jobs

const LIVE: ReadonlySet<JobState> = new Set([
	"pending",
	"starting",
	"running",
	"holding",
	"paused",
])

/** Not completed, cancelled or failed. */
export function isJobActive(state: JobState): boolean {
	return LIVE.has(state)
}

/** For colour: running sweep is `live` (phosphor), paused `paused` (amber). */
export type JobTone = "live" | "paused" | "ended" | "failed"

export function jobTone(job: Pick<ScanJob, "state">): JobTone {
	switch (job.state) {
		case "paused":
			return "paused"
		case "failed":
			return "failed"
		case "completed":
		case "cancelled":
			return "ended"
		default:
			return "live"
	}
}

/** "58 s", "2 min", "1 h 5 min" (rounded up, never below 1 s). */
export function formatWait(ms: number): string {
	const s = Math.max(1, Math.ceil(ms / 1000))
	if (s < 90) return `${s} s`
	const min = Math.round(s / 60)
	if (min < 60) return `${min} min`
	const h = Math.floor(min / 60)
	const rest = min % 60
	return rest > 0 ? `${h} h ${rest} min` : `${h} h`
}

const HELD_BY: Readonly<Record<NonNullable<ScanJob["resumeHeldBy"]>, string>> =
	{
		audio: "live audio",
		identify: "an identify",
		recording: "a recording",
	}

export interface JobStateLineOptions {
	/** Clock for "resumes in …" (ms since the epoch). Default Date.now(). */
	now?: number
	/** The frequency the job holds on (see heldFrequencyHz). */
	heldHz?: number | null
}

/**
 * The job's state in words: "Scanning", "Held on 146.9625", "Paused",
 * "Scan paused · you tuned · resumes in 58 s", "Paused by Marine VHF", "Source down"…
 */
export function jobStateLine(
	job: Pick<
		ScanJob,
		"state" | "reason" | "resumeAt" | "resumeHeldBy" | "preemptedBy"
	>,
	options: JobStateLineOptions = {},
): string {
	switch (job.state) {
		case "pending":
		case "starting":
			return "Starting"
		case "running":
			return "Scanning"
		case "holding":
			return options.heldHz !== null && options.heldHz !== undefined
				? `Held on ${formatMHz(options.heldHz)}`
				: "Holding"
		case "completed":
			return "Finished"
		case "cancelled":
			return "Stopped"
		case "failed":
			if (job.reason === "source-removed") return "Failed · source removed"
			if (job.reason === "tuner-unavailable") return "Failed · no tuner control"
			if (job.reason === "invalid") return "Failed · invalid plan"
			return "Failed"
		case "paused":
			return pausedLine(job, options.now ?? Date.now())
	}
}

function pausedLine(
	job: Pick<ScanJob, "reason" | "resumeAt" | "resumeHeldBy" | "preemptedBy">,
	now: number,
): string {
	const parts: string[] = []
	switch (job.reason) {
		case "preempted-operator":
			parts.push("Scan paused", "you tuned")
			break
		case "preempted-relay":
			parts.push("Scan paused", "a relay client tuned")
			break
		case "preempted-job": {
			const name = job.preemptedBy?.name?.trim()
			parts.push(name ? `Paused by ${name}` : "Paused by another scan")
			break
		}
		case "source-down":
			parts.push("Source down")
			break
		case "core-restart":
			parts.push("Paused", "WaveKit restarted")
			break
		case "resume-blocked":
			parts.push("Paused")
			break
		default:
			parts.push("Paused")
	}
	const resumeAt = job.resumeAt === null ? NaN : Date.parse(job.resumeAt)
	if (Number.isFinite(resumeAt) && resumeAt > now)
		parts.push(`resumes in ${formatWait(resumeAt - now)}`)
	else if (job.resumeHeldBy !== null)
		parts.push(`resumes after ${HELD_BY[job.resumeHeldBy]}`)
	return parts.join(" · ")
}

/**
 * The frequency a holding job sits on: the probe on the held track, else the strongest active
 * observation credited to the job (from `scanner:activity`). Null when unknown.
 */
export function heldFrequencyHz(
	job: Pick<ScanJob, "id" | "progress">,
	holdingOn: string | null | undefined,
	activity: Iterable<{
		jobIds: readonly string[]
		frequencyHz: number
		peakDbfs: number
		active: boolean
	}> = [],
): number | null {
	const track = holdingOn ?? job.progress.holdingOn
	if (track) {
		const probe = job.progress.probes.find(p => p.trackId === track)
		if (probe) return probe.targetHz
	}
	let best: { frequencyHz: number; peakDbfs: number } | null = null
	for (const a of activity)
		if (a.active && a.jobIds.includes(job.id))
			if (!best || a.peakDbfs > best.peakDbfs) best = a
	return best?.frequencyHz ?? null
}

export interface SweepProgress {
	/** 1-based pass number. */
	pass: number
	/** 1-based hop being visited. */
	hop: number
	hopCount: number
	/** 0..1 of the current pass. */
	fraction: number
	/** 0..100, rounded. */
	percent: number
	/** "Pass 2 · hop 7/44". */
	text: string
}

/** Pass number and the share of the current pass from a job's progress (indices are 0-based). */
export function sweepProgress(p: {
	sweepIndex: number
	hopIndex: number
	hopCount: number
}): SweepProgress {
	const hopCount = Math.max(0, Math.floor(p.hopCount))
	const hop = hopCount > 0 ? Math.min(hopCount, Math.max(1, p.hopIndex + 1)) : 0
	const fraction = hopCount > 0 ? hop / hopCount : 0
	const pass = Math.max(1, Math.floor(p.sweepIndex) + 1)
	return {
		pass,
		hop,
		hopCount,
		fraction,
		percent: Math.round(fraction * 100),
		text:
			hopCount > 0 ? `Pass ${pass} · hop ${hop}/${hopCount}` : `Pass ${pass}`,
	}
}

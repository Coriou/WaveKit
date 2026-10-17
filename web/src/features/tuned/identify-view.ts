// Identify in the tuned card (docs/web/canvas/Identify.dc.html, Tuned.dc.html; DESIGN.md "Identify in the
// tuned card"): maps the identify store's state to what the card's "now" block shows. Pure.
import type {
	ScannerIdentifyMeasurements,
	ScannerIdentifyResult,
	ScannerIdentifyTrial,
	ScannerProtocol,
	ScannerClass,
	ScannerTrialOutcome,
} from "@wavekit/api-types"
import type { IdentifyState } from "../../data/index.ts"
import { formatDb, formatWidth } from "../format.ts"

export type IdentifyPhase =
	| "idle"
	| "starting"
	| "waiting"
	| "trying"
	| "identified"
	| "candidate"
	| "unidentified"
	| "artefact"
	| "interrupted"
	| "error"

export type TrialTone = "ok" | "busy" | "fail" | "queued" | "skip" | "stopped"

export interface IdentifyTrialRow {
	key: string
	protocol: string
	decoder: string
	word: string
	tone: TrialTone
	/** Drawn as an outline tag (not available yet). */
	tag: boolean
	title: string
}

export interface IdentifyView {
	phase: IdentifyPhase
	/** Still listening: the close button stops, the countdown runs. */
	running: boolean
	title: string
	/** Quiet suffix of the title: " · 12 s", " · 2 of 4". */
	secs: string
	/** An answer, drawn in the head font. */
	big: boolean
	line: string
	/** Outline tag beside the title (the reason of a "maybe"). */
	reason: string
	note: string
	trials: IdentifyTrialRow[]
	/** "12.5 kHz wide · SNR 18 dB · peak −62 dBFS", null before the first measurement. */
	measured: string | null
	/** Countdown to the listening timeout while waiting or trying. */
	bar: { fraction: number; leftS: number; windowS: number } | null
}

const DEFAULT_WINDOW_MS = 15_000

const PROTOCOL: Readonly<Record<ScannerProtocol, string>> = {
	"analog-fm": "FM voice",
	"analog-am": "AM voice",
	dmr: "DMR",
	p25p1: "P25",
	p25p2: "P25 Phase 2",
	nxdn48: "NXDN",
	nxdn96: "NXDN 96",
	ysf: "YSF",
	dstar: "D-STAR",
	dpmr: "dPMR",
	pocsag: "POCSAG",
	flex: "FLEX",
	aprs: "APRS",
	ism: "ISM",
	ais: "AIS",
	acars: "ACARS",
	vdl2: "VDL2",
	lora: "LoRa",
	"digital-unknown": "digital",
	carrier: "carrier",
	unknown: "unknown",
}

export function protocolLabel(protocol: ScannerProtocol): string {
	return PROTOCOL[protocol]
}

const CLASS: Readonly<Record<ScannerClass, string>> = {
	"fsk4-12k5": "4FSK 12.5 kHz",
	"fsk4-6k25": "4FSK 6.25 kHz",
	"tdma-ms": "TDMA bursts",
	"fsk2-wide": "wide FSK bursts",
	"gmsk-narrow": "narrow GMSK",
	"afsk-fm": "AFSK over FM",
	"analog-fm": "analog FM",
	"ook-burst": "on-off keyed bursts",
	carrier: "a steady carrier",
	wideband: "a wideband signal",
	unknown: "",
}

const WORD: Readonly<Record<ScannerTrialOutcome, string>> = {
	pending: "Queued",
	running: "Trying",
	decoded: "Decoded",
	"no-sync": "No sync",
	"crc-errors": "CRC errors",
	timeout: "Timed out",
	"skipped-budget": "Skipped (busy)",
	unsupported: "Not available yet",
	"not-needed": "Not needed",
	cancelled: "Stopped",
}

const TONE: Readonly<Record<ScannerTrialOutcome, TrialTone>> = {
	pending: "queued",
	running: "busy",
	decoded: "ok",
	"no-sync": "fail",
	"crc-errors": "fail",
	timeout: "fail",
	"skipped-budget": "skip",
	unsupported: "skip",
	"not-needed": "skip",
	cancelled: "stopped",
}

const REASON: Readonly<
	Record<NonNullable<ScannerIdentifyTrial["reason"]>, string>
> = {
	"no-decoder": "no decoder installed",
	"needs-channelizer": "needs the channelizer",
	"unsupported-format": "unsupported format",
	"no-ambient-decoder": "no decoder running here",
	"decoder-unavailable": "decoder could not start",
	"no-live-audio": "live audio was not on it",
}

export function trialRow(
	trial: ScannerIdentifyTrial,
	index: number,
): IdentifyTrialRow {
	const protocol = protocolLabel(trial.protocol)
	// WG7 ambient trials read a decoder already running there (AIS, ACARS, VDL2, LoRa): no probe
	const decoder =
		trial.transport === "ambient"
			? `running ${trial.decoder ?? "decoder"}`
			: (trial.decoder ?? "no decoder")
	const word = WORD[trial.outcome]
	const why = trial.reason ? REASON[trial.reason] : null
	return {
		key: `${index}-${trial.protocol}-${trial.mode ?? ""}`,
		protocol,
		decoder,
		word,
		tone: TONE[trial.outcome],
		tag: trial.outcome === "unsupported",
		title: `${protocol} with ${decoder}: ${word}${why ? ` (${why})` : ""}`,
	}
}

/** "12.5 kHz wide · SNR 18 dB · peak −62 dBFS · 40 % duty". */
export function measuredLine(m: ScannerIdentifyMeasurements): string | null {
	const parts: string[] = []
	if (m.obwHz !== null) parts.push(`${formatWidth(m.obwHz)} wide`)
	if (m.snrDb !== null) parts.push(`SNR ${Math.round(m.snrDb)} dB`)
	if (m.peakDbfs !== null) parts.push(`peak ${formatDb(m.peakDbfs, 0)} dBFS`)
	if (m.dutyCycle !== null)
		parts.push(
			m.dutyCycle >= 0.99
				? "steady"
				: `${Math.round(m.dutyCycle * 100)} % duty`,
		)
	return parts.length ? parts.join(" · ") : null
}

const ARTEFACT: Readonly<
	Record<
		NonNullable<ScannerIdentifyResult["artefact"]>,
		{ title: string; line: string }
	>
> = {
	dc: {
		title: "This is the receiver’s own centre spike",
		line: "Every SDR shows a small peak where it is centred. Nothing is transmitting here.",
	},
	spur: {
		title: "A spur from the receiver",
		line: "A steady tone made inside the receiver, not on the air. It stays with the antenna unplugged.",
	},
	image: {
		title: "A mirror image",
		line: "A strong carrier the other side of the centre shows up here, flipped.",
	},
	rfi: {
		title: "Local interference",
		line: "Noise from nearby electronics, not a transmission.",
	},
}

/** Identity and metadata of an answer, in words: "CC 1 · TG 2081 · radio 2081107". */
export function resultDetails(result: ScannerIdentifyResult): string {
	const parts: string[] = []
	const id = result.identity
	if (id) {
		const prefix: Record<typeof id.kind, string> = {
			"dmr-cc": "CC",
			"p25-nac": "NAC",
			"nxdn-ran": "RAN",
			"ysf-dgid": "DG-ID",
			"dstar-call": "",
			"dpmr-cc": "CC",
			"pocsag-capcode": "capcode",
			"aprs-call": "",
			"ism-model": "",
			"ais-mmsi": "MMSI",
			"acars-reg": "",
			"vdl2-addr": "address",
			"lora-node": "node",
		}
		parts.push(`${prefix[id.kind]} ${id.value}`.trim())
	}
	const md = result.metadata
	if (md.talkgroups[0]) parts.push(`TG ${md.talkgroups[0]}`)
	if (md.sources[0]) parts.push(`radio ${md.sources[0]}`)
	if (md.callsigns[0]) parts.push(md.callsigns[0])
	if (md.capcodes[0] && !id) parts.push(`capcode ${md.capcodes[0]}`)
	if (md.ismModels[0] && !id) parts.push(md.ismModels[0])
	if (md.ctcssHz !== undefined) parts.push(`CTCSS ${md.ctcssHz.toFixed(1)} Hz`)
	return parts.join(" · ")
}

/** The most telling failure among the trials, for the "maybe" tag. */
function failureReason(trials: readonly ScannerIdentifyTrial[]): string {
	for (const outcome of ["crc-errors", "no-sync", "timeout"] as const)
		if (trials.some(t => t.outcome === outcome)) return WORD[outcome]
	return ""
}

const EMPTY: IdentifyView = {
	phase: "idle",
	running: false,
	title: "",
	secs: "",
	big: false,
	line: "",
	reason: "",
	note: "",
	trials: [],
	measured: null,
	bar: null,
}

/** What the card shows for an identify state at `nowMs`. */
export function identifyView(
	state: IdentifyState,
	nowMs: number,
): IdentifyView {
	if (state.error !== null && state.job === null)
		return {
			...EMPTY,
			phase: "error",
			title: "Could not identify",
			line:
				state.errorCode === "OUT_OF_WINDOW"
					? "This frequency is outside the receiver’s window. Tune to it first."
					: state.error,
		}
	if (state.starting || (state.targetHz !== null && !state.job))
		return state.starting
			? { ...EMPTY, phase: "starting", running: true, title: "Starting" }
			: EMPTY
	const job = state.job
	if (!job) return EMPTY

	const windowMs = job.identify?.timeoutMs ?? DEFAULT_WINDOW_MS
	const started = Date.parse(job.startedAt ?? job.createdAt)
	const leftMs = Number.isFinite(started)
		? Math.min(windowMs, Math.max(0, windowMs - (nowMs - started)))
		: windowMs
	const windowS = Math.round(windowMs / 1000)
	const bar = {
		fraction: windowMs > 0 ? leftMs / windowMs : 0,
		leftS: Math.ceil(leftMs / 1000),
		windowS,
	}
	const event = state.event
	const trials = event?.trials ?? []
	const rows = trials.map(trialRow)
	const result = event?.result
	const measured = result ? measuredLine(result.measurements) : null
	const n = trials.length
	const done = trials.filter(
		t => t.outcome !== "pending" && t.outcome !== "running",
	).length
	const note = result?.discoveryId ? "Added to discoveries" : ""

	if (result?.ended === "window-moved")
		return {
			...EMPTY,
			phase: "interrupted",
			title: "Stopped · you tuned away",
			line:
				done > 0
					? `Tried ${done} of ${n} decoders before the receiver moved. Nothing was kept.`
					: "Stopped before a transmission came. Nothing was kept.",
			trials: rows.filter(r => r.tone !== "queued"),
			measured: done > 0 ? measured : null,
		}
	if (result?.artefact) {
		const a = ARTEFACT[result.artefact]
		return {
			...EMPTY,
			phase: "artefact",
			title: a.title,
			line: a.line,
			note: "Answered from the receiver’s settings, without listening",
		}
	}

	switch (event?.state ?? "waiting-for-signal") {
		case "waiting-for-signal":
			return {
				...EMPTY,
				phase: "waiting",
				running: true,
				title: "Waiting for a transmission",
				secs: ` · ${bar.leftS} s`,
				bar,
			}
		case "trying":
			return {
				...EMPTY,
				phase: "trying",
				running: true,
				title: "Trying decoders",
				secs: n > 0 ? ` · ${Math.min(done + 1, n)} of ${n}` : "",
				trials: rows,
				measured,
				bar,
			}
		case "identified": {
			const label = result?.protocol
				? protocolLabel(result.protocol)
				: "Identified"
			return {
				...EMPTY,
				phase: "identified",
				title: label,
				big: true,
				line: result ? resultDetails(result) : "",
				note: note || "Identified",
				trials: rows,
				measured,
			}
		}
		case "candidate": {
			const proto =
				result?.protocol && result.protocol !== "unknown"
					? protocolLabel(result.protocol)
					: ""
			const looks = result ? CLASS[result.measurements.class] : ""
			const details = result ? resultDetails(result) : ""
			return {
				...EMPTY,
				phase: "candidate",
				title: proto ? `Maybe ${proto}` : "Maybe",
				big: true,
				line: [
					looks ? `Looks like ${looks}` : "",
					details,
					n > 0 ? "no decoder synced" : "",
				]
					.filter(Boolean)
					.join(" · "),
				reason: failureReason(trials),
				note,
				trials: rows,
				measured,
			}
		}
		case "unidentified": {
			const looks = result ? CLASS[result.measurements.class] : ""
			return {
				...EMPTY,
				phase: "unidentified",
				title: "Not identified",
				big: true,
				line: `${looks ? `Looks like ${looks}. ` : ""}No decoder synced in ${windowS} s.`,
				note,
				trials: rows,
				measured,
			}
		}
	}
}

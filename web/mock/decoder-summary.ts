// GET /api/decoders/summary for the mock: the core's per-decoder verdict (src/api/routes/decoder-summary.ts),
// derived from the mock's GET /api/decoders statuses with the same precedence and wording.
import {
	DECODER_COUNTER_CLASSES,
	DECODER_SUMMARY_MAX_HZ,
} from "@wavekit/api-types"
import type {
	DecoderCounterName,
	DecoderCounters,
	DecoderInfo,
	DecoderReceptionHint,
	DecoderSummary,
	DecoderVerdict,
	DecoderVerdictAction,
	DecoderVerdictCode,
	ScanRange,
} from "@wavekit/api-types"
import {
	clusterHolds,
	fixedTargetsHz,
	planListsHz,
} from "../src/features/tuned/decoder-protocols.ts"
import { SCANNER_BANDPLANS } from "./data.ts"

/** The core's decoding window: output in the last minute reads "decoding". */
const DECODING_WINDOW_MS = 60_000

/** ADS-B waits for CPU budget while tuned within this of 1090 MHz and the budget was never raised. */
export const MOCK_ADSB_BUDGET_REACH_HZ = 200_000
export const MOCK_ADSB_HZ = 1_090_000_000

const NAMES: Readonly<Record<string, string>> = {
	readsb: "ADS-B",
	"ais-catcher": "AIS",
	acarsdec: "ACARS",
	dumpvdl2: "VDL2",
	rtl433: "ISM",
	direwolf: "APRS",
	"multimon-ng": "Pager",
	"dsd-fme": "Digital voice",
	"lora-meshtastic": "LoRa",
}

/** Each code's sentence (after the decoder name) and suggested actions, as the core's VERDICTS. */
const VERDICTS: Readonly<
	Record<
		DecoderVerdictCode,
		{ text: string; actions: readonly DecoderVerdictAction[] }
	>
> = {
	decoding: { text: "decoding", actions: [] },
	listening: {
		text: "listening: nothing decoded in the last minute",
		actions: [],
	},
	starting: { text: "starting", actions: [] },
	off: { text: "off in Settings", actions: ["turn-on"] },
	stopped: { text: "stopped", actions: ["start"] },
	failed: { text: "failed to run", actions: ["restart"] },
	"out-of-band": {
		text: "waiting: the tuned frequency is outside its band",
		actions: ["tune-to-band"],
	},
	"no-channel": {
		text: "waiting: no channel in view",
		actions: ["tune-to-band"],
	},
	"capture-too-narrow": {
		text: "waiting: the capture is too narrow for its band",
		actions: ["raise-sample-rate"],
	},
	"source-unavailable": {
		text: "waiting for the source",
		actions: ["check-source"],
	},
	"source-paused": {
		text: "waiting: Receiver paused",
		actions: ["resume-source"],
	},
	"unsupported-rate": {
		text: "paused: the sample rate does not suit it",
		actions: ["change-sample-rate"],
	},
	"scanner-busy": {
		text: "paused: the scanner holds the tuner",
		actions: ["pause-scanner"],
	},
	"efficiency-budget": {
		text: "paused: CPU budget full",
		actions: ["raise-budget", "turn-off-others", "pause-scanner"],
	},
	"efficiency-cpu": {
		text: "paused: the CPU is busy",
		actions: ["turn-off-others", "pause-scanner"],
	},
	"efficiency-drops": {
		text: "paused: the source was dropping samples",
		actions: ["lower-sample-rate", "turn-off-others"],
	},
	"efficiency-late-drops": {
		text: "paused: samples were dropped while it ran",
		actions: ["turn-off-others", "lower-sample-rate"],
	},
	"efficiency-waiting": {
		text: "waiting for the source to settle",
		actions: [],
	},
	"decoder-unavailable": {
		text: "unavailable: its program is not installed",
		actions: ["install-decoder"],
	},
	"channelizer-unavailable": {
		text: "paused: needs the channelizer",
		actions: ["enable-channelizer"],
	},
	unknown: { text: "status unknown", actions: [] },
}

const RATE_REASONS: ReadonlySet<string> = new Set([
	"insufficient-sample-rate",
	"unsupported-sample-rate",
	"unsupported-input-kind",
	"unsupported-input-format",
	"unsupported-frontend-rate",
	"unsupported-decoder-input-rate",
	"unknown-requirements",
])

/** The decoder fields the verdict reads (the core's DecoderStatus has the same names). */
export type VerdictInput = Pick<
	DecoderInfo,
	| "mode"
	| "desiredRunning"
	| "running"
	| "suspension"
	| "efficiency"
	| "placements"
	| "health"
	| "nextRestartAt"
	| "restartInFlight"
>

/**
 * The core's "failed: restarting on its own": a restart is scheduled or under way (`restartInFlight`), or a
 * crash-loop retry runs on probation.
 */
function retrying(d: VerdictInput): boolean {
	return (
		d.restartInFlight === true ||
		d.nextRestartAt !== undefined ||
		d.health === "restarting" ||
		(d.health === "faulted" && d.running)
	)
}

function efficiencyCode(d: VerdictInput): DecoderVerdictCode {
	const detail: string | undefined =
		d.efficiency?.detail ??
		d.placements?.find(p => p.efficiencyDetail !== undefined)?.efficiencyDetail
	switch (detail) {
		case "budget":
			return "efficiency-budget"
		case "cpu":
			return "efficiency-cpu"
		case "drops":
			return "efficiency-drops"
		case "late-drops":
			return "efficiency-late-drops"
		case "unknown":
		case undefined:
			// no refusal from the gate: only the wait, never a full budget
			return "efficiency-waiting"
		default:
			// a detail this build does not know: no cause claimed, no action
			return "unknown"
	}
}

function suspensionCode(reason: string | undefined): DecoderVerdictCode {
	if (reason === undefined) return "unknown"
	if (reason === "frequency-out-of-band") return "out-of-band"
	if (reason === "no-channel-selected") return "no-channel"
	if (reason === "capture-too-narrow") return "capture-too-narrow"
	if (reason === "tuner-scanning") return "scanner-busy"
	if (reason === "source-paused") return "source-paused"
	if (reason === "decoder-unavailable") return "decoder-unavailable"
	if (reason === "channelizer-unavailable") return "channelizer-unavailable"
	if (
		reason === "source-rate-unknown" ||
		reason === "adaptation-unknown" ||
		reason === "external-input"
	)
		return "source-unavailable"
	if (RATE_REASONS.has(reason)) return "unsupported-rate"
	return "unknown"
}

/** The core's precedence: failure, mode off, operator stop, suspension (efficiency first), output, a wanted start. */
export function mockVerdictCode(
	d: VerdictInput,
	health: DecoderSummary["health"],
): DecoderVerdictCode {
	if (health === "failed") return "failed"
	if (d.mode === "off") return "off"
	if (d.desiredRunning === false && !d.running) return "stopped"
	if (health === "suspended") {
		const reason = d.suspension?.reasonCode
		return reason !== "source-paused" &&
			(reason === "efficiency-budget" || d.efficiency !== undefined)
			? efficiencyCode(d)
			: suspensionCode(reason)
	}
	if (health === "decoding") return "decoding"
	if (d.running) return "listening"
	if (d.desiredRunning === true) return "starting"
	return "unknown"
}

/**
 * Synthetic frame counters per decoder type (the core's `counters`, from adapters that report
 * them): the LoRa modem hears preambles it cannot decode, the ISM decoder decoded earlier and
 * hears bursts it has not decoded in the last minute.
 */
export const MOCK_COUNTERS: Readonly<Record<string, DecoderCounters>> = {
	"lora-meshtastic": {
		inputSamples: { total: 1_500_000_000, perMin: 30_000_000 },
		preambles: { total: 12, perMin: 1 },
		headersOk: { total: 3, perMin: 0 },
		framesOk: { total: 0, perMin: 0 },
		crcBad: { total: 3, perMin: 0 },
		parseDrops: { total: 0, perMin: 0 },
	},
	rtl433: {
		detections: { total: 840, perMin: 6 },
		framesOk: { total: 96, perMin: 0 },
	},
}

/**
 * The core's receptionHint (src/decoders/decoder-counters.ts) on a listening
 * verdict. The core reads growth since the decoder last started or moved; a
 * mock decoder never restarts or moves and its fixture counts are fresh, so
 * its whole run is one listening period and that growth is its total.
 */
export function mockReception(
	counters: DecoderCounters | undefined,
	code: DecoderVerdictCode,
): DecoderReceptionHint | undefined {
	if (code !== "listening" || !counters) return undefined
	let heard = false
	let decoded = false
	let heardListening = 0
	let heardRecent = 0
	let decodedListening = 0
	let decodedRecent = 0
	for (const [name, counter] of Object.entries(counters)) {
		if (!counter || !Object.hasOwn(DECODER_COUNTER_CLASSES, name)) continue
		const kind = DECODER_COUNTER_CLASSES[name as DecoderCounterName]
		if (kind === "heard" || kind === "failed") {
			heard = true
			heardListening += counter.total
			heardRecent += Math.min(counter.perMin, counter.total)
		} else if (kind === "decoded") {
			decoded = true
			decodedListening += counter.total
			decodedRecent += Math.min(counter.perMin, counter.total)
		}
	}
	if (!heard || !decoded) return undefined
	if (decodedListening === 0)
		return heardListening > 0 ? "heard-undecoded" : "nothing-heard"
	return heardRecent > 0 && decodedRecent === 0
		? "heard-undecoded"
		: "nothing-heard"
}

/** The core's listening sentence for a reception hint. */
const RECEPTION_TEXT: Readonly<Record<DecoderReceptionHint, string>> = {
	"heard-undecoded": "listening: heard signals but decoded none",
	"nothing-heard": "listening: heard nothing it recognises",
}

/** The core's host-busy sentence: host starvation, no decoder is the cause. */
const HOST_BUSY_TEXT = "host busy: samples were dropped on several streams"
const LOSS_CODES: ReadonlySet<DecoderVerdictCode> = new Set([
	"efficiency-drops",
	"efficiency-late-drops",
	"efficiency-cpu",
])

/** The core's decoderVerdict; `counters` are the decoder's, as the core reads them from its status. */
export function mockVerdict(
	d: DecoderInfo,
	health: DecoderSummary["health"],
	counters?: DecoderCounters,
	now?: number,
): DecoderVerdict {
	const code = mockVerdictCode(d, health)
	const reception = mockReception(counters, code)
	let entry: {
		text: string
		actions: readonly DecoderVerdictAction[]
		cause?: "host" | "decoder"
		retryAt?: string
	} =
		code === "failed" && retrying(d)
			? { text: "failed: restarting on its own", actions: [] }
			: reception !== undefined
				? { text: RECEPTION_TEXT[reception], actions: VERDICTS[code].actions }
				: VERDICTS[code]
	// The core's host-busy (over any reception hint) and retry wording
	// (src/api/routes/decoder-summary.ts).
	const hostBusy = d.hostBusy !== undefined
	const cause = d.efficiency?.cause
	if ((code === "decoding" || code === "listening") && hostBusy)
		entry = { text: `${code}: ${HOST_BUSY_TEXT}`, actions: [], cause: "host" }
	else if (LOSS_CODES.has(code)) {
		if (
			cause === "host" ||
			(cause === undefined && hostBusy && code !== "efficiency-cpu")
		)
			entry = {
				text: `paused: ${HOST_BUSY_TEXT}`,
				actions: ["turn-off-others", "pause-scanner"],
				cause: "host",
			}
		else if (cause === "decoder") entry = { ...entry, cause: "decoder" }
		const at = Date.parse(d.efficiency?.retryAt ?? "")
		if (now !== undefined && Number.isFinite(at) && at > now)
			entry = {
				...entry,
				text: `${entry.text}; retrying in ${Math.max(1, Math.ceil((at - now) / 1_000))} s`,
				retryAt: new Date(at).toISOString(),
			}
	}
	return {
		code,
		text: `${mockDecoderName(d.type)} ${entry.text}`,
		actions: [...entry.actions],
		...(entry.cause ? { cause: entry.cause } : {}),
		...(entry.retryAt ? { retryAt: entry.retryAt } : {}),
	}
}

/** The core's decoderName: the plain name of a type, "Decoder" for any other. */
export function mockDecoderName(type: string): string {
	return Object.hasOwn(NAMES, type) ? NAMES[type]! : "Decoder"
}

/** The core's tuned-band reach (TUNED_TARGET_TOLERANCE_HZ): 200 kHz, the offset readsb accepts from 1090 MHz. */
export const MOCK_TUNED_REACH_HZ = 200_000

const positive = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n > 0

/**
 * The core's built-in band plan ranges for EU (builtinBandplansFor("EU")): SCANNER_BANDPLANS without the canvas's
 * synthetic `pager-431` (the core has no such built-in), plus the French paging supplement of
 * src/core/bandplans/builtin-supplement.ts. The mock is an EU receiver, so any region code reads these.
 */
export const MOCK_PLAN_RANGES: readonly ScanRange[] = [
	...SCANNER_BANDPLANS.filter(plan => plan.id !== "pager-431").flatMap(
		plan => plan.ranges,
	),
	{
		startHz: 466_025_000,
		endHz: 466_230_000,
		rasters: [{ spacingHz: 12_500, firstChannelHz: 466_025_000 }],
		obwHz: [12_000],
		protocols: ["pocsag"],
		bandplanId: "pager-fr",
	},
	{
		startHz: 446_532_500 - 6250,
		endHz: 446_532_500 + 6250,
		rasters: [{ spacingHz: 12_500, firstChannelHz: 446_532_500 }],
		obwHz: [12_000],
		protocols: ["pocsag"],
		bandplanId: "pager-fr",
	},
]

/**
 * The core's tuned-band rule (bandContainsTuned) over one band: a followCenter band holds its whole span between
 * the lowest and highest target; malformed values never match.
 */
function bandHolds(
	targetsHz: readonly unknown[],
	rangesHz: readonly { minHz: unknown; maxHz: unknown }[],
	hz: number,
	followCenter = false,
): boolean {
	const reach = MOCK_TUNED_REACH_HZ
	const targets = targetsHz.filter(positive)
	if (targets.some(t => Math.abs(t - hz) <= reach)) return true
	if (
		followCenter &&
		targets.length > 1 &&
		hz >= Math.min(...targets) - reach &&
		hz <= Math.max(...targets) + reach
	)
		return true
	if (clusterHolds(targets, hz, reach)) return true
	return rangesHz.some(
		r =>
			positive(r.minHz) &&
			positive(r.maxHz) &&
			r.minHz <= r.maxHz &&
			hz >= r.minHz - reach &&
			hz <= r.maxHz + reach,
	)
}

/**
 * The core's decoderCoversHz over the band assessment: within MOCK_TUNED_REACH_HZ of a target, between
 * neighbouring targets of one channel cluster, or inside a range widened by the reach. Without an assessed band (before the first
 * source capabilities) the same rule runs over the fixed configured targets (fixedTargetsHz: a frequency that only
 * follows the tuner never counts). A decoder with neither covers `hz` only
 * when a built-in band plan range there lists one of its protocols (planListsHz over
 * MOCK_PLAN_RANGES, the protocol map the web's status fallback shares). Scanner probes never cover; malformed values never match.
 */
export function mockCoversHz(
	d: Pick<
		DecoderInfo,
		| "type"
		| "owner"
		| "ephemeral"
		| "bandAssessment"
		| "targetFrequenciesHz"
		| "placements"
	>,
	hz: number,
): boolean {
	if (!positive(hz) || d.owner === "scanner" || d.ephemeral === true)
		return false
	const targets = d.bandAssessment?.targetsHz ?? []
	const ranges = d.bandAssessment?.rangesHz ?? []
	if (targets.length > 0 || ranges.length > 0)
		return bandHolds(
			targets,
			ranges,
			hz,
			d.bandAssessment?.followCenter === true,
		)
	const configured = fixedTargetsHz(d)
	if (configured.length > 0) return bandHolds(configured, [], hz)
	return planListsHz(d.type, MOCK_PLAN_RANGES, hz)
}

/** What the core's 400 says `hz` accepts (its Zod description of the query). */
export const SUMMARY_HZ_EXPECTED = `number (> 0, <= ${DECODER_SUMMARY_MAX_HZ}), Hz`

/**
 * The core's `?hz=` reading: a positive finite number up to DECODER_SUMMARY_MAX_HZ, absent when not given,
 * "invalid" otherwise (the core answers 400).
 */
export function summaryHzQuery(raw: unknown): number | undefined | "invalid" {
	if (raw === undefined) return undefined
	const hz = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN
	return Number.isFinite(hz) && hz > 0 && hz <= DECODER_SUMMARY_MAX_HZ
		? hz
		: "invalid"
}

function healthOf(d: DecoderInfo, now: number): DecoderSummary["health"] {
	if (d.health === "faulted" || d.health === "restarting") return "failed"
	if (d.suspended || d.suspension) return "suspended"
	const last = d.lastOutputAt ? Date.parse(d.lastOutputAt) : NaN
	if (d.running && last <= now && now - last <= DECODING_WINDOW_MS)
		return "decoding"
	return "idle"
}

/** One summary item per decoder, in the core's shape. */
export function buildDecoderSummaries(
	decoders: readonly DecoderInfo[],
	now: number,
	hz?: number,
): DecoderSummary[] {
	return decoders.map(d => {
		const health = healthOf(d, now)
		const counters = Object.hasOwn(MOCK_COUNTERS, d.type)
			? MOCK_COUNTERS[d.type]
			: undefined
		const verdict = mockVerdict(d, health, counters, now)
		const reception = mockReception(counters, verdict.code)
		return {
			id: d.id,
			name: mockDecoderName(d.type),
			protocol: d.type,
			state: d.running ? "running" : "stopped",
			placements: d.running
				? [
						{
							sourceId: d.sourceId ?? null,
							frequencyHz:
								d.targetFrequenciesHz?.length === 1
									? d.targetFrequenciesHz[0]!
									: null,
						},
					]
				: [],
			eventsOut: d.stats.eventsOut,
			lastOutputAt: d.lastOutputAt ?? null,
			suspensionReason: d.suspension?.reasonCode ?? null,
			health,
			verdict,
			...(hz === undefined ? {} : { coversHz: mockCoversHz(d, hz) }),
			...(counters === undefined ? {} : { counters }),
			...(reception === undefined ? {} : { reception }),
		}
	})
}

/**
 * The mock's ADS-B budget case: tuned near 1090 MHz with the CPU budget never raised from its
 * default, ADS-B waits as `efficiency-budget` (the core's tuned-band admission when the budget is
 * full). Raising the budget, a stop/start of ADS-B, or tuning away clears it.
 */
export function withAdsbBudget(
	list: DecoderInfo[],
	tunedHz: number,
	budgetRaised: boolean,
	since: string,
): DecoderInfo[] {
	if (
		budgetRaised ||
		Math.abs(tunedHz - MOCK_ADSB_HZ) > MOCK_ADSB_BUDGET_REACH_HZ
	)
		return list
	return list.map(d => {
		if (d.type !== "readsb" || !d.running || d.mode !== "auto") return d
		if (d.startMode === "operator") return d
		const paused: DecoderInfo = {
			...d,
			running: false,
			suspended: true,
			uptime: 0,
			suspension: { reasonCode: "efficiency-budget", since },
			efficiency: { detail: "budget" },
		}
		delete paused.pid
		return paused
	})
}

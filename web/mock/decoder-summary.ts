// GET /api/decoders/summary for the mock: the core's per-decoder verdict (src/api/routes/decoder-summary.ts),
// derived from the mock's GET /api/decoders statuses with the same precedence and wording.
import type {
	DecoderInfo,
	DecoderSummary,
	DecoderVerdict,
	DecoderVerdictAction,
	DecoderVerdictCode,
} from "@wavekit/api-types"

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
>

function efficiencyCode(d: VerdictInput): DecoderVerdictCode {
	const detail: string | undefined =
		d.efficiency?.detail ??
		d.placements?.find(p => p.efficiencyDetail !== undefined)?.efficiencyDetail
	switch (detail) {
		case "budget":
		case undefined:
			return "efficiency-budget"
		case "cpu":
			return "efficiency-cpu"
		case "drops":
			return "efficiency-drops"
		case "late-drops":
			return "efficiency-late-drops"
		case "unknown":
			return "efficiency-waiting"
		default:
			// a detail this build does not know: no cause claimed, no action
			return "unknown"
	}
}

function suspensionCode(reason: string | undefined): DecoderVerdictCode {
	if (reason === undefined) return "unknown"
	if (reason === "efficiency-budget") return "efficiency-budget"
	if (reason === "frequency-out-of-band") return "out-of-band"
	if (reason === "no-channel-selected") return "no-channel"
	if (reason === "capture-too-narrow") return "capture-too-narrow"
	if (reason === "tuner-scanning") return "scanner-busy"
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
		return reason === "efficiency-budget" || d.efficiency !== undefined
			? efficiencyCode(d)
			: suspensionCode(reason)
	}
	if (health === "decoding") return "decoding"
	if (d.running) return "listening"
	if (d.desiredRunning === true) return "starting"
	return "unknown"
}

export function mockVerdict(
	d: DecoderInfo,
	health: DecoderSummary["health"],
): DecoderVerdict {
	const code = mockVerdictCode(d, health)
	const entry = VERDICTS[code]
	const name = NAMES[d.type] ?? "Decoder"
	return { code, text: `${name} ${entry.text}`, actions: [...entry.actions] }
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
): DecoderSummary[] {
	return decoders.map(d => {
		const health = healthOf(d, now)
		return {
			id: d.id,
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
			verdict: mockVerdict(d, health),
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

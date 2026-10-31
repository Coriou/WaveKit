import {
	DECODER_VERDICT_TEXT_MAX_LENGTH,
	decoderVerdictSchema,
} from "@wavekit/api-types"
import type {
	DecoderSummary,
	DecoderVerdict,
	DecoderVerdictAction,
	DecoderVerdictCode,
} from "@wavekit/api-types"
import type { FastifyPluginAsync } from "fastify"
import type { DecoderManager } from "../../decoders/manager.js"
import type { DecoderStatus } from "../../decoders/types.js"

/** 60 seconds × 1,000 milliseconds; inclusive at the last millisecond. */
export const DECODING_WINDOW_MS = 60 * 1_000

// Precedence: crash/restart failure, suspension, recent running output, idle.
// A retained lastError alone is historical and does not mark a recovered run failed.
function healthOf(
	status: DecoderStatus,
	last: number | undefined,
	now: number,
): DecoderSummary["health"] {
	if (status.health === "faulted" || status.health === "restarting")
		return "failed"
	if (status.suspension || status.suspended) return "suspended"
	if (
		status.running &&
		last !== undefined &&
		last <= now &&
		now - last <= DECODING_WINDOW_MS
	)
		return "decoding"
	return "idle"
}

/** Plain names of the built-in decoder types; any other type reads "Decoder". */
const DECODER_NAMES: Readonly<Record<string, string>> = {
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

const RATE_REASONS: ReadonlySet<string> = new Set([
	"insufficient-sample-rate",
	"unsupported-sample-rate",
	"unsupported-input-kind",
	"unsupported-input-format",
	"unsupported-frontend-rate",
	"unsupported-decoder-input-rate",
	"unknown-requirements",
])

/** Each code's sentence (after the decoder name) and suggested actions. */
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
		text: "waiting: Receiver paused — Resume",
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

function efficiencyCode(status: DecoderStatus): DecoderVerdictCode {
	const detail =
		status.efficiency?.detail ??
		status.placements?.find(p => p.efficiencyDetail !== undefined)
			?.efficiencyDetail
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
			return "efficiency-waiting"
		case undefined:
			// No refusal from the gate (the core is about to evaluate it again):
			// claim no cause, least of all a full budget, only the wait.
			return "efficiency-waiting"
		default:
			// A detail this build does not know (a newer core): claim no cause
			// and suggest no budget action; the generic verdict is the safe one.
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

/**
 * The decoder's one verdict. Precedence: failure, mode off, operator stop,
 * suspension (efficiency detail first), running output, a wanted start not
 * yet running; anything unrecognised reads "unknown" (the safe generic).
 */
export function decoderVerdict(
	status: DecoderStatus,
	health: DecoderSummary["health"],
	running: boolean,
): DecoderVerdict {
	let code: DecoderVerdictCode
	if (health === "failed") code = "failed"
	else if (status.mode === "off") code = "off"
	else if (status.desiredRunning === false && !running) code = "stopped"
	else if (health === "suspended") {
		const reason = status.suspension?.reasonCode
		// The operator's pause outranks a stale efficiency state.
		code =
			reason !== "source-paused" &&
			(reason === "efficiency-budget" || status.efficiency !== undefined)
				? efficiencyCode(status)
				: suspensionCode(reason)
	} else if (health === "decoding") code = "decoding"
	else if (running) code = "listening"
	else if (status.desiredRunning === true) code = "starting"
	else code = "unknown"
	const name = Object.hasOwn(DECODER_NAMES, status.type)
		? DECODER_NAMES[status.type]!
		: "Decoder"
	const entry = VERDICTS[code]
	const verdict = {
		code,
		text: `${name} ${entry.text}`.slice(0, DECODER_VERDICT_TEXT_MAX_LENGTH),
		actions: [...entry.actions],
	}
	const parsed = decoderVerdictSchema.safeParse(verdict)
	return parsed.success
		? parsed.data
		: { code: "unknown", text: "Decoder status unknown", actions: [] }
}

export function decoderSummary(
	status: DecoderStatus,
	now: number,
): DecoderSummary {
	// A decoder's placement workers (instances such as `<type>#<channel>@<source>`)
	// run for it: any running placement makes the decoder running.
	const running =
		status.running || (status.placements ?? []).some(p => p.running)
	const aggregated: DecoderStatus = { ...status, running }
	const last = status.lastOutputAt?.getTime()
	// Precedence: crash/restart failure, suspension, recent running output, idle.
	// A retained lastError alone is historical and does not mark a recovered run failed.
	const health = healthOf(aggregated, last, now)
	return {
		id: status.id,
		protocol: status.type,
		state: running ? "running" : "stopped",
		placements:
			status.placements !== undefined
				? status.placements
						.filter(p => p.running)
						.map(p => ({
							sourceId: p.sourceId,
							frequencyHz: p.channelHz ?? null,
						}))
				: status.running
					? [
							{
								sourceId: status.sourceId ?? null,
								// Without a placement view, only a single declared target is unambiguous.
								frequencyHz:
									status.targetFrequenciesHz?.length === 1
										? status.targetFrequenciesHz[0]!
										: null,
							},
						]
					: [],
		eventsOut: status.stats.eventsOut,
		lastOutputAt: status.lastOutputAt?.toISOString() ?? null,
		suspensionReason: status.suspension?.reasonCode ?? null,
		health,
		verdict: decoderVerdict(status, health, running),
	}
}

export const decoderSummaryRoutes: FastifyPluginAsync<{
	decoderManager: Pick<DecoderManager, "getAllStatus">
}> = async (app, { decoderManager }) => {
	app.get(
		"/api/decoders/summary",
		{
			schema: {
				summary: "Summarize decoder output and health",
				tags: ["decoders"],
			},
		},
		async () => {
			const now = Date.now()
			return decoderManager
				.getAllStatus()
				.map(status => decoderSummary(status, now))
		},
	)
}

import {
	DECODER_SUMMARY_MAX_HZ,
	DECODER_VERDICT_TEXT_MAX_LENGTH,
	decoderVerdictSchema,
} from "@wavekit/api-types"
import type {
	BandRegion,
	DecoderBandRange,
	DecoderCounters,
	DecoderInputState,
	DecoderReceptionHint,
	DecoderPlacementView,
	DecoderSummary,
	DecoderVerdict,
	DecoderVerdictAction,
	DecoderVerdictCode,
} from "@wavekit/api-types"
import type { FastifyPluginAsync } from "fastify"
import { z } from "zod"
import { builtinBandplansFor } from "../../core/bandplans/builtin-supplement.js"
import type { ScanRange } from "../../core/scanner/types.js"
import { BAND_REGIONS } from "../../decoders/band-region.js"
import { DECODER_PROTOCOLS } from "../../decoders/enablement/contract.js"
import { VFO_CHANNEL_TYPES } from "../../decoders/enablement/placement.js"
import { bandContainsTuned } from "../../decoders/enablement/tuned-band.js"
import type { DecoderManager } from "../../decoders/manager.js"
import type { SourceManager, SourceStatus } from "../../core/source-manager.js"
import {
	receptionHint,
	type DecoderCountersStatus,
} from "../../decoders/decoder-counters.js"
import type { DecoderStatus } from "../../decoders/types.js"
import { zodValidationBody } from "../validation-errors.js"

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

/** The plain name of a decoder type; any other type reads "Decoder". */
export function decoderName(type: string): string {
	return Object.hasOwn(DECODER_NAMES, type) ? DECODER_NAMES[type]! : "Decoder"
}

/**
 * A failed decoder the manager is already bringing back: an automatic restart
 * is scheduled or under way (restartInFlight: a crash-loop respawn, or a
 * placement start that outlived its timeout), or a crash-loop retry runs on
 * probation. Restarting it by hand would only race that, so its verdict
 * offers no action.
 */
function retrying(status: DecoderStatus, running: boolean): boolean {
	return (
		status.restartInFlight === true ||
		status.nextRestartAt !== undefined ||
		status.health === "restarting" ||
		(status.health === "faulted" && running)
	)
}

/** A failed verdict's sentence while the manager restarts it on its own. */
const RETRYING_TEXT = "failed: restarting on its own"

/** Host starvation: no decoder is the cause, so no rate or decoder action helps. */
const HOST_BUSY_TEXT = "host busy: samples were dropped on several streams"
const HOST_BUSY_ACTIONS: readonly DecoderVerdictAction[] = [
	"turn-off-others",
	"pause-scanner",
]
const LOSS_CODES: ReadonlySet<DecoderVerdictCode> = new Set([
	"efficiency-drops",
	"efficiency-late-drops",
	"efficiency-cpu",
])

/** Whole seconds until `retryAt`, at least 1; null when absent, malformed or past. */
function retryInSeconds(retryAt: unknown, now: number): number | null {
	if (typeof retryAt !== "string" || !Number.isFinite(now)) return null
	const at = Date.parse(retryAt)
	return Number.isFinite(at) && at > now
		? Math.max(1, Math.ceil((at - now) / 1_000))
		: null
}

/** A listening verdict's sentence when the decoder's counters give a reception hint. */
const RECEPTION_TEXT: Readonly<Record<DecoderReceptionHint, string>> = {
	"heard-undecoded": "listening: heard signals but decoded none",
	"nothing-heard": "listening: heard nothing it recognises",
}

/** The reception hint of a listening verdict, else none (decoder-counters.ts receptionHint). */
export function decoderReception(
	status: DecoderStatus,
	code: DecoderVerdictCode,
): DecoderReceptionHint | undefined {
	return code === "listening" ? receptionHint(status.counters) : undefined
}

/** `counters` for the summary: total and rate per name, without the child's raw reading. */
export function compactCounters(
	counters: DecoderCountersStatus | undefined,
): DecoderCounters | undefined {
	if (!counters) return undefined
	const compact: DecoderCounters = {}
	let any = false
	for (const [name, counter] of Object.entries(counters) as Array<
		[keyof DecoderCounters, DecoderCountersStatus[keyof DecoderCounters]]
	>) {
		if (!counter) continue
		compact[name] = { total: counter.total, perMin: counter.perMin }
		any = true
	}
	return any ? compact : undefined
}

/**
 * The decoder's one verdict. Precedence: failure, mode off, operator stop,
 * suspension (efficiency detail first), running output, a wanted start not
 * yet running; anything unrecognised reads "unknown" (the safe generic). A
 * failure the manager is already restarting suggests no action.
 */
export function decoderVerdict(
	status: DecoderStatus,
	health: DecoderSummary["health"],
	running: boolean,
	now?: number,
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
	const name = decoderName(status.type)
	const reception = decoderReception(status, code)
	let entry: {
		text: string
		actions: readonly DecoderVerdictAction[]
		cause?: "host" | "decoder"
		retryAt?: string
	} =
		code === "failed" && retrying(status, running)
			? { text: RETRYING_TEXT, actions: [] }
			: reception !== undefined
				? { text: RECEPTION_TEXT[reception], actions: VERDICTS[code].actions }
				: VERDICTS[code]
	// Host starvation: a running decoder says the host is busy (over any
	// reception hint); a loss shed the host caused says so instead of
	// suggesting a lower rate. A loss shed says when it is retried.
	const hostBusy = status.hostBusy !== undefined && status.hostBusy !== null
	const shedCause = status.efficiency?.cause
	if ((code === "decoding" || code === "listening") && hostBusy)
		entry = { text: `${code}: ${HOST_BUSY_TEXT}`, actions: [], cause: "host" }
	else if (LOSS_CODES.has(code)) {
		const host =
			shedCause === "host" ||
			(shedCause === undefined && hostBusy && code !== "efficiency-cpu")
		if (host)
			entry = {
				text: `paused: ${HOST_BUSY_TEXT}`,
				actions: HOST_BUSY_ACTIONS,
				cause: "host",
			}
		else if (shedCause === "decoder") entry = { ...entry, cause: "decoder" }
		const seconds =
			now === undefined ? null : retryInSeconds(status.efficiency?.retryAt, now)
		if (seconds !== null)
			entry = {
				...entry,
				text: `${entry.text}; retrying in ${seconds} s`,
				retryAt: new Date(
					Date.parse(status.efficiency!.retryAt!),
				).toISOString(),
			}
	}
	const verdict = {
		code,
		text: `${name} ${entry.text}`.slice(0, DECODER_VERDICT_TEXT_MAX_LENGTH),
		actions: [...entry.actions],
		...(entry.cause ? { cause: entry.cause } : {}),
		...(entry.retryAt ? { retryAt: entry.retryAt } : {}),
	}
	const parsed = decoderVerdictSchema.safeParse(verdict)
	if (!parsed.success)
		return { code: "unknown", text: "Decoder status unknown", actions: [] }
	const { cause, retryAt, ...rest } = parsed.data
	return {
		...rest,
		...(cause ? { cause } : {}),
		...(retryAt ? { retryAt } : {}),
	}
}

const positive = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n > 0

/** Built-in band plan ranges per region, read once (the catalogue is static data). */
const planRanges = new Map<BandRegion, readonly ScanRange[]>()
function rangesFor(region: BandRegion): readonly ScanRange[] {
	let ranges = planRanges.get(region)
	if (ranges === undefined) {
		ranges = builtinBandplansFor(region).flatMap(plan => plan.ranges)
		planRanges.set(region, ranges)
	}
	return ranges
}

/** True when a built-in band plan range holding `hz` lists one of `protocols` (the decoder's region, else any). */
function planListsAt(
	protocols: readonly string[],
	hz: number,
	region: unknown,
): boolean {
	const regions: readonly BandRegion[] =
		typeof region === "string" &&
		(BAND_REGIONS as readonly string[]).includes(region)
			? [region as BandRegion]
			: BAND_REGIONS
	return regions.some(r =>
		rangesFor(r).some(
			range =>
				hz >= range.startHz &&
				hz <= range.endHz &&
				(range.protocols ?? []).some(p => protocols.includes(p)),
		),
	)
}

/**
 * The fixed frequencies among a decoder's configured targets. targetFrequenciesHz
 * also carries placement frequencies that only follow the tuner: a VFO or
 * fallback channel, a centre-reach placement (the source centre) and, for a
 * single-channel audio type (VFO_CHANNEL_TYPES), a "configured" channel, which
 * sits on the VFO or the centre when no channel is configured. Without
 * placements the targets are the config's; with only fixed placements of a
 * wideband type they are too (channels plus declared frequencies). Otherwise
 * only band, band plan and activity channels (and a wideband type's configured
 * ones) count.
 */
function fixedTargetsHz(status: DecoderStatus): number[] {
	const raw: unknown = status.targetFrequenciesHz
	const declared = Array.isArray(raw) ? (raw as unknown[]).filter(positive) : []
	const rawPlacements: unknown = status.placements
	const placements = Array.isArray(rawPlacements)
		? (rawPlacements as DecoderPlacementView[])
		: []
	if (placements.length === 0) return declared
	const audio = VFO_CHANNEL_TYPES.includes(status.type)
	const fixed = (p: DecoderPlacementView): boolean =>
		p != null &&
		p.reach !== "centre" &&
		(p.origin === "band" ||
			p.origin === "bandplan" ||
			p.origin === "activity" ||
			(p.origin === "configured" && !audio))
	if (!audio && placements.every(fixed)) return declared
	return placements
		.filter(fixed)
		.flatMap(p => (positive(p.channelHz) ? [p.channelHz] : []))
}

/**
 * Whether the decoder's own band holds `hz`: the core's tuned-band rule
 * (bandContainsTuned) over its band assessment's targets and ranges (a
 * followCenter assessment holds its whole span between them). Before
 * the first assessment (no source capabilities yet, at boot) or when it names
 * no band, the same rule runs over the fixed configured targets (fixedTargetsHz).
 * A decoder with neither covers `hz` only when a built-in band plan range there
 * lists one of its protocols. A frequency that only follows the tuner (a VFO,
 * fallback or centre placement) never counts; scanner probes never cover;
 * anything malformed reads false.
 */
export function decoderCoversHz(status: DecoderStatus, hz: number): boolean {
	if (!positive(hz)) return false
	if (status.owner === "scanner" || status.ephemeral === true) return false
	const band = status.bandAssessment
	const rawTargets: unknown = band?.targetsHz
	const rawRanges: unknown = band?.rangesHz
	const targetsHz = Array.isArray(rawTargets) ? (rawTargets as number[]) : []
	const rangesHz = Array.isArray(rawRanges)
		? (rawRanges as DecoderBandRange[])
		: []
	if (targetsHz.length > 0 || rangesHz.length > 0)
		return bandContainsTuned(
			{
				basis: band?.basis ?? "configured",
				targetsHz,
				rangesHz,
				...(band?.followCenter === true ? { followCenter: true as const } : {}),
			},
			hz,
		)
	const configured = fixedTargetsHz(status)
	if (configured.length > 0)
		return bandContainsTuned(
			{ basis: "configured", targetsHz: configured, rangesHz: [] },
			hz,
		)
	const protocols = Object.hasOwn(DECODER_PROTOCOLS, status.type)
		? DECODER_PROTOCOLS[status.type as keyof typeof DECODER_PROTOCOLS]
		: undefined
	if (!protocols || protocols.length === 0) return false
	return planListsAt(protocols, hz, band?.region?.code)
}

/** A source's activity state by id; undefined for an unknown source. */
export type SourceActivityOf = (
	sourceId: string,
) => SourceStatus["activity"]["state"] | undefined

/**
 * Reads activity through `getStatus`; a manager without it reads every source unknown. A source in
 * its commanded rate-change recovery (at most 9 s) is on its way back, not broken, so it reads as
 * one just connecting. A recording that ended keeps reading `ended`: nothing brings it back.
 */
export function sourceActivityReader(
	manager: Partial<Pick<SourceManager, "getStatus" | "isCommandedRecovery">>,
): SourceActivityOf {
	return id => {
		const activity = manager.getStatus?.(id)?.activity.state
		return (activity === "disconnected" || activity === "stale") &&
			manager.isCommandedRecovery?.(id) === true
			? "waiting"
			: activity
	}
}

/**
 * Whether samples reach the decoder, from the activity of the sources it runs on (its running
 * placements, else its own source). A source delivering nothing is known from its own sample age:
 * `stale` is past the source's sample timeout, so a sparse band is never `none`. A source just
 * connecting (`waiting`) or backed up (`paused`) says nothing, and neither does a decoder with no
 * source: both read `unknown`, which never changes a verdict.
 */
export function decoderInput(
	status: DecoderStatus,
	activityOf: SourceActivityOf | undefined,
): DecoderInputState {
	if (!activityOf) return "unknown"
	const running = (status.placements ?? [])
		.filter(placement => placement.running)
		.map(placement => placement.sourceId)
	const sources =
		running.length > 0
			? running
			: status.sourceId !== undefined
				? [status.sourceId]
				: []
	if (sources.length === 0) return "unknown"
	let silent = 0
	for (const id of sources) {
		const activity = activityOf(id)
		if (activity === "streaming") return "flowing"
		if (
			activity === "disconnected" ||
			activity === "stale" ||
			activity === "ended"
		)
			silent++
	}
	return silent === sources.length ? "none" : "unknown"
}

/** A running decoder whose every source delivers nothing is broken, not quiet. */
const NO_INPUT_VERDICT = {
	code: "source-unavailable",
	actions: ["check-source"],
} as const satisfies Pick<DecoderVerdict, "code" | "actions">
const NO_INPUT_TEXT = "has no input: its source delivers no samples"

/**
 * One decoder's summary item. With `hz`, `coversHz` says whether its band
 * holds that frequency (decoderCoversHz); without, the field is absent. With
 * `activityOf`, a `listening` decoder without input reads `source-unavailable`
 * (quiet versus broken, docs/API.md); without it, `input` is `unknown`.
 */
export function decoderSummary(
	status: DecoderStatus,
	now: number,
	hz?: number,
	activityOf?: SourceActivityOf,
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
	const input = decoderInput(status, activityOf)
	const judged = decoderVerdict(status, health, running, now)
	const verdict: DecoderVerdict =
		judged.code === "listening" && input === "none"
			? {
					...NO_INPUT_VERDICT,
					actions: [...NO_INPUT_VERDICT.actions],
					text: `${decoderName(status.type)} ${NO_INPUT_TEXT}`,
				}
			: judged
	const counters = compactCounters(status.counters)
	const reception = decoderReception(status, verdict.code)
	return {
		id: status.id,
		name: decoderName(status.type),
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
		verdict,
		...(hz === undefined ? {} : { coversHz: decoderCoversHz(status, hz) }),
		...(counters === undefined ? {} : { counters }),
		...(reception === undefined ? {} : { reception }),
		input,
	}
}

/** `?hz=`: a positive finite frequency up to DECODER_SUMMARY_MAX_HZ, or absent. */
const SummaryQuerySchema = z.object({
	hz: z.coerce
		.number()
		.finite()
		.positive()
		.max(DECODER_SUMMARY_MAX_HZ)
		.optional(),
})

export const decoderSummaryRoutes: FastifyPluginAsync<{
	decoderManager: Pick<DecoderManager, "getAllStatus">
	sourceManager?: Partial<Pick<SourceManager, "getStatus">> | undefined
}> = async (app, { decoderManager, sourceManager }) => {
	app.get(
		"/api/decoders/summary",
		{
			schema: {
				summary: "Summarize decoder output and health",
				tags: ["decoders"],
			},
		},
		async (request, reply) => {
			const query = SummaryQuerySchema.safeParse(request.query ?? {})
			if (!query.success)
				return reply.code(400).send(
					zodValidationBody(query.error, SummaryQuerySchema, {
						part: "query",
					}),
				)
			const now = Date.now()
			const { hz } = query.data
			const activityOf = sourceManager
				? sourceActivityReader(sourceManager)
				: undefined
			return decoderManager
				.getAllStatus()
				.map(status => decoderSummary(status, now, hz, activityOf))
		},
	)
}

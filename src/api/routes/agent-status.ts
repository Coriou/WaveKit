import {
	AGENT_STATUS_LIMITS,
	agentStatusResponseSchema,
	jsonStringBytes,
} from "@wavekit/api-types"
import type {
	AgentActivity,
	AgentLiveAudio,
	AgentScanner,
	AgentSource,
	AgentSourceWarning,
	AgentStatus,
	AgentTuner,
	ScanJob,
	TunerState,
} from "@wavekit/api-types"
import type { FastifyPluginAsync } from "fastify"
import type { ActivityStoreStats } from "../../core/activity/storage/contract.js"
import type { LiveDemodulator } from "../../core/live-demodulator.js"
import type { ScannerService } from "../../core/scanner/scanner-service.js"
import type { SourceManager } from "../../core/source-manager.js"
import type { TunerController } from "../../core/tuner-controller.js"
import type { DecoderManager } from "../../decoders/manager.js"
import { decoderSummary } from "./decoder-summary.js"

export interface AgentStatusRoutesOptions {
	decoderManager: Pick<DecoderManager, "getAllStatus">
	sourceManager: Pick<SourceManager, "getAllStatus">
	tunerController?: Pick<TunerController, "getAllStates"> | undefined
	liveDemod?: Pick<LiveDemodulator, "getStatus"> | undefined
	scanner?:
		| Pick<ScannerService, "status" | "listJobs" | "tunerLeaseHolder">
		| undefined
	/** Same inputs as the Activity routes: disabled, unavailable, or the store's stats. */
	activity: {
		enabled: boolean
		unavailable?: boolean
		stats?: () => ActivityStoreStats | Promise<ActivityStoreStats>
	}
}

/** Verdicts that need nothing from the operator; every other code is a problem row. */
const QUIET_VERDICTS: ReadonlySet<string> = new Set([
	"decoding",
	"listening",
	"off",
])

/** A job that has not ended (it may still resume and take a tuner). */
const LIVE_JOB_STATES: ReadonlySet<ScanJob["state"]> = new Set([
	"pending",
	"starting",
	"running",
	"holding",
	"paused",
])

const L = AGENT_STATUS_LIMITS

/**
 * `value` cut at a code point boundary so its JSON string body (escapes and UTF-8
 * included) is at most `maxBytes`: the byte caps in `AGENT_STATUS_LIMITS` hold
 * whatever characters an id carries.
 */
export function clipJson(value: string, maxBytes: number): string {
	if (jsonStringBytes(value) <= maxBytes) return value
	let bytes = 0
	let end = 0
	for (const char of value) {
		bytes += jsonStringBytes(char)
		if (bytes > maxBytes) return value.slice(0, end)
		end += char.length
	}
	return value
}

/** Shortens strings and lists to their caps, remembering whether anything was cut. */
class Bounds {
	truncated = false

	id(value: string, maxBytes: number = L.idMaxBytes): string {
		const clipped = clipJson(value, maxBytes)
		if (clipped !== value) this.truncated = true
		return clipped
	}

	list<T>(items: readonly T[], max: number): T[] {
		if (items.length > max) this.truncated = true
		return items.slice(0, max)
	}
}

function tunerRow(
	state: TunerState,
	leaseHolder: (sourceId: string) => string | null,
	bounds: Bounds,
): AgentTuner {
	const unknown = new Set(state.unknownFields ?? [])
	const declared = state.declaredOnlyFields ?? []
	const gainKnown =
		state.gainMode === "manual" &&
		!unknown.has("gain") &&
		!unknown.has("gainMode")
	return {
		sourceId: bounds.id(state.sourceId),
		frequencyHz: unknown.has("frequency") ? null : state.frequency,
		sampleRateHz: unknown.has("sampleRate") ? null : state.sampleRate,
		gainMode: unknown.has("gainMode") ? null : state.gainMode,
		gain: gainKnown ? state.gain : null,
		// External control wins: WaveKit then sends no commands, the scanner included.
		// Otherwise only a scanner tuner lease moves it (job state does not say who holds one).
		owner:
			state.controlMode === "external"
				? "external"
				: leaseHolder(state.sourceId) !== null
					? "scanner"
					: "wavekit",
		declaredOnly:
			declared.includes("frequency") || declared.includes("sampleRate"),
	}
}

/** Tuner fields whose unknown value means the receiver may be tuned elsewhere. */
const TUNING_FIELDS = ["frequency", "sampleRate", "gain", "gainMode"] as const

/** A sweep a plain feed resume held: it waits for an explicit job resume. */
const isHeldSweep = (job: ScanJob): boolean =>
	job.state === "paused" && job.reason === "resumed-without-retune"

function sourceRows(
	sourceManager: AgentStatusRoutesOptions["sourceManager"],
	unverified: ReadonlySet<string>,
	bounds: Bounds,
): AgentSource[] {
	return bounds.list(sourceManager.getAllStatus(), L.sourcesMax).map(status => {
		const warnings: AgentSourceWarning[] = []
		if (status.rateMismatch) warnings.push("rate-mismatch")
		if (status.signalFlat) warnings.push("signal-flat")
		return {
			id: bounds.id(status.id),
			connected: status.connected,
			state: status.activity.state,
			sampleAgeMs: status.activity.sampleAgeMs,
			warnings,
			feed: status.feed?.state ?? "live",
			tuningUnverified: unverified.has(status.id),
		}
	})
}

function liveAudioRow(
	liveDemod: AgentStatusRoutesOptions["liveDemod"],
	bounds: Bounds,
): AgentLiveAudio | null {
	if (!liveDemod) return null
	const status = liveDemod.getStatus()
	return {
		running: status.running,
		health: status.pipelineHealth,
		sourceId: bounds.id(status.sourceId),
		modulation: clipJson(status.config.modulation, L.modulationMaxBytes),
		offsetHz: status.config.offsetHz ?? 0,
		clients: status.clientCount,
		squelchOpen: status.running ? (status.squelchOpen ?? null) : null,
	}
}

function scannerRow(
	jobs: readonly ScanJob[],
	enabled: boolean,
	bounds: Bounds,
): AgentScanner {
	const live = jobs.filter(job => LIVE_JOB_STATES.has(job.state))
	const held = live.filter(isHeldSweep)
	// A held sweep first, so a newer job never hides it; then newest update first
	// (ISO times of one clock compare as strings).
	const current = (held.length > 0 ? held : live).reduce<ScanJob | undefined>(
		(best, job) => (!best || job.updatedAt > best.updatedAt ? job : best),
		undefined,
	)
	return {
		enabled,
		activeJobs: live.length,
		heldJobs: held.length,
		job: current
			? {
					id: bounds.id(current.id),
					name:
						current.name === null
							? null
							: clipJson(current.name, L.jobNameMaxBytes),
					kind: current.spec.kind,
					state: current.state,
					reason:
						current.reason === undefined
							? null
							: clipJson(current.reason, L.reasonMaxBytes),
					sourceId: bounds.id(current.spec.sourceId),
				}
			: null,
	}
}

async function activityRow(
	activity: AgentStatusRoutesOptions["activity"],
): Promise<AgentActivity> {
	if (activity.unavailable) return { state: "unavailable", rows: null }
	if (!activity.enabled) return { state: "disabled", rows: null }
	if (!activity.stats) return { state: "unavailable", rows: null }
	try {
		const stats = await activity.stats()
		const state = stats.lifecycle?.state ?? "available"
		return { state, rows: state === "available" ? stats.rows : null }
	} catch {
		// A failed stats read claims nothing about the store beyond "not readable now".
		return { state: "unavailable", rows: null }
	}
}

/** Pure composition of one status answer; exported for the size and shape tests. */
export async function buildAgentStatus(
	options: AgentStatusRoutesOptions,
	now: number,
): Promise<AgentStatus> {
	const bounds = new Bounds()
	const scanner = options.scanner
	const jobs = scanner?.listJobs() ?? []
	const leaseHolder = (sourceId: string): string | null =>
		scanner?.tunerLeaseHolder(sourceId) ?? null
	const summaries = options.decoderManager
		.getAllStatus()
		.map(status => decoderSummary(status, now))
	// Newest output per protocol over every decoder, not only the rows shown.
	const newest = new Map<string, string>()
	for (const summary of summaries) {
		const at = summary.lastOutputAt
		if (at === null) continue
		const previous = newest.get(summary.protocol)
		if (previous === undefined || at > previous)
			newest.set(summary.protocol, at)
	}
	const lastDecode = [...newest]
		.map(([protocol, at]) => ({ protocol, at }))
		.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
	const tunerStates = options.tunerController?.getAllStates() ?? []
	const tuners = bounds
		.list(tunerStates, L.sourcesMax)
		.map(state => tunerRow(state, leaseHolder, bounds))
	const unverified = new Set(
		tunerStates
			.filter(state =>
				TUNING_FIELDS.some(field => state.unknownFields?.includes(field)),
			)
			.map(state => state.sourceId),
	)
	const sources = sourceRows(options.sourceManager, unverified, bounds)
	const liveAudio = liveAudioRow(options.liveDemod, bounds)
	const scannerStatus = scanner
		? scannerRow(jobs, scanner.status().enabled, bounds)
		: null
	// Problem rows first (stable otherwise), so the cut drops healthy decoders before
	// a failed or suspended one; `hiddenProblems` counts the problem rows still cut.
	const isProblem = (code: string) => !QUIET_VERDICTS.has(code)
	const ordered = [
		...summaries.filter(summary => isProblem(summary.verdict.code)),
		...summaries.filter(summary => !isProblem(summary.verdict.code)),
	]
	const problems = ordered.filter(summary =>
		isProblem(summary.verdict.code),
	).length
	const hiddenProblems = Math.max(0, problems - L.decodersMax)
	const decoders = bounds.list(ordered, L.decodersMax).map(summary => ({
		id: bounds.id(summary.id),
		protocol: bounds.id(summary.protocol, L.protocolMaxBytes),
		verdict: {
			code: summary.verdict.code,
			actions: bounds.list(summary.verdict.actions, L.actionsMax),
		},
	}))
	const lastDecodeRows = bounds.list(lastDecode, L.decodersMax).map(row => ({
		protocol: bounds.id(row.protocol, L.protocolMaxBytes),
		at: row.at,
	}))
	const activity = await activityRow(options.activity)
	return {
		at: new Date(now).toISOString(),
		truncated: bounds.truncated,
		tuners,
		sources,
		liveAudio,
		scanner: scannerStatus,
		decoders,
		hiddenProblems,
		activity,
		lastDecode: lastDecodeRows,
	}
}

export const agentStatusRoutes: FastifyPluginAsync<
	AgentStatusRoutesOptions
> = async (app, options) => {
	app.get(
		"/api/agent/status",
		{
			schema: {
				summary: "What the receiver is doing, in one compact answer",
				tags: ["health"],
				response: { 200: agentStatusResponseSchema },
			},
		},
		async () => buildAgentStatus(options, Date.now()),
	)
}

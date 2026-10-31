import {
	AGENT_STATUS_LIMITS,
	agentStatusResponseSchema,
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
	scanner?: Pick<ScannerService, "status" | "listJobs"> | undefined
	/** Same inputs as the Activity routes: disabled, unavailable, or the store's stats. */
	activity: {
		enabled: boolean
		unavailable?: boolean
		stats?: () => ActivityStoreStats | Promise<ActivityStoreStats>
	}
}

/** A job that may hold a tuner: everything before a terminal state. */
const LIVE_JOB_STATES: ReadonlySet<ScanJob["state"]> = new Set([
	"pending",
	"starting",
	"running",
	"holding",
	"paused",
])
/** Jobs that hold the tuner now (a paused or pending job has released it). */
const HOLDING_JOB_STATES: ReadonlySet<ScanJob["state"]> = new Set([
	"starting",
	"running",
	"holding",
])

function tunerRow(
	state: TunerState,
	scanning: ReadonlySet<string>,
): AgentTuner {
	const unknown = new Set(state.unknownFields ?? [])
	const declared = state.declaredOnlyFields ?? []
	const gainKnown =
		state.gainMode === "manual" &&
		!unknown.has("gain") &&
		!unknown.has("gainMode")
	return {
		sourceId: state.sourceId,
		frequencyHz: unknown.has("frequency") ? null : state.frequency,
		sampleRateHz: unknown.has("sampleRate") ? null : state.sampleRate,
		gainMode: unknown.has("gainMode") ? null : state.gainMode,
		gain: gainKnown ? state.gain : null,
		// External control wins: WaveKit then sends no commands, the scanner included.
		owner:
			state.controlMode === "external"
				? "external"
				: scanning.has(state.sourceId)
					? "scanner"
					: "wavekit",
		declaredOnly:
			declared.includes("frequency") || declared.includes("sampleRate"),
	}
}

function sourceRows(
	sourceManager: AgentStatusRoutesOptions["sourceManager"],
): AgentSource[] {
	return sourceManager.getAllStatus().map(status => {
		const warnings: AgentSourceWarning[] = []
		if (status.rateMismatch) warnings.push("rate-mismatch")
		if (status.signalFlat) warnings.push("signal-flat")
		return {
			id: status.id,
			connected: status.connected,
			state: status.activity.state,
			sampleAgeMs: status.activity.sampleAgeMs,
			warnings,
		}
	})
}

function liveAudioRow(
	liveDemod: AgentStatusRoutesOptions["liveDemod"],
): AgentLiveAudio | null {
	if (!liveDemod) return null
	const status = liveDemod.getStatus()
	return {
		running: status.running,
		health: status.pipelineHealth,
		sourceId: status.sourceId,
		modulation: status.config.modulation,
		offsetHz: status.config.offsetHz ?? 0,
		clients: status.clientCount,
		squelchOpen: status.running ? (status.squelchOpen ?? null) : null,
	}
}

function scannerRow(jobs: readonly ScanJob[], enabled: boolean): AgentScanner {
	const live = jobs.filter(job => LIVE_JOB_STATES.has(job.state))
	// Newest update first; ISO times of one clock compare as strings.
	const current = live.reduce<ScanJob | undefined>(
		(best, job) => (!best || job.updatedAt > best.updatedAt ? job : best),
		undefined,
	)
	return {
		enabled,
		activeJobs: live.length,
		job: current
			? {
					id: current.id,
					name:
						current.name === null
							? null
							: current.name.slice(0, AGENT_STATUS_LIMITS.jobNameMaxLength),
					kind: current.spec.kind,
					state: current.state,
					reason: current.reason ?? null,
					sourceId: current.spec.sourceId,
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
	const jobs = options.scanner?.listJobs() ?? []
	const scanning = new Set(
		jobs
			.filter(job => HOLDING_JOB_STATES.has(job.state))
			.map(job => job.spec.sourceId),
	)
	const decoders = options.decoderManager.getAllStatus().map(status => {
		const summary = decoderSummary(status, now)
		return { id: summary.id, protocol: summary.protocol, summary }
	})
	const newest = new Map<string, string>()
	for (const { summary } of decoders) {
		const at = summary.lastOutputAt
		if (at === null) continue
		const previous = newest.get(summary.protocol)
		if (previous === undefined || at > previous)
			newest.set(summary.protocol, at)
	}
	return {
		at: new Date(now).toISOString(),
		tuners: (options.tunerController?.getAllStates() ?? []).map(state =>
			tunerRow(state, scanning),
		),
		sources: sourceRows(options.sourceManager),
		liveAudio: liveAudioRow(options.liveDemod),
		scanner: options.scanner
			? scannerRow(jobs, options.scanner.status().enabled)
			: null,
		decoders: decoders.map(({ id, protocol, summary }) => ({
			id,
			protocol,
			verdict: summary.verdict,
		})),
		activity: await activityRow(options.activity),
		lastDecode: [...newest]
			.map(([protocol, at]) => ({ protocol, at }))
			.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)),
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

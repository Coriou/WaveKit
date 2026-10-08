import { z } from "zod"
import type {
	ReadingState,
	SamplingState,
	SdrHostDelivery,
	SdrHostDeliveryClient,
	SdrHostSampling,
	StatsError,
} from "@wavekit/api-types"

/**
 * Canonical slepp/rtlmux /stats.json. `server.dataIn` counts bytes read from
 * rtl_tcp since rtlmux started; rtlmux reads upstream continuously even with
 * no clients. `server.dataOut` is upstream command traffic, never IQ output.
 */
export const RtlmuxStatsSchema = z.object({
	server: z.object({
		dataIn: z.number().nonnegative(),
		dataOut: z.number().nonnegative(),
	}),
	clients: z
		.array(
			z.object({
				client: z.object({ host: z.string().max(128), port: z.number().int() }),
				dataIn: z.number().nonnegative().default(0),
				dataOut: z.number().nonnegative(),
				dropped: z
					.object({
						size: z.number().nonnegative(),
						count: z.number().nonnegative(),
					})
					.default({ size: 0, count: 0 }),
				connected: z.number().optional(),
			}),
		)
		.max(256),
})
export type RtlmuxStatsSnapshot = z.infer<typeof RtlmuxStatsSchema>

/** Legacy `/api/status` rtlmux.stats shape; core's SdrHostPoller parses it. */
export interface RtlmuxStats {
	clients: number
	bytesPerSec: number
	totalBytesSent: number
	clientDetails: Array<{ id: number; address: string; bytesDropped: number }>
}

export const SAMPLE_TIMEOUT_MS = 10_000
/** Canonical rtlmux increments are ≥16 KiB; guards header-only reconnects in other builds. */
export const MIN_EVIDENCE_BYTES = 65_536
const RATE_WINDOW_MS = 10_000
const MIN_RATE_SPAN_MS = 4_000
const STATS_OK_MS = 6_000
const STATS_EXPIRE_MS = 30_000
const DROP_WINDOW_MS = 60_000
const HISTORY_MS = 5 * 60_000
const LOW_RATE_FRACTION = 0.9
/** Half of rtl-sdr's lowest valid sample rate (225 kS/s × 2 bytes / 2). */
const RATE_FLOOR_BYTES_PER_SEC = 225_000

interface ClientTrack {
	key: string
	address: string
	connectedAt: string | null
	lastOut: number
	lastAt: number
	queuedBytesPerSec: number | null
	lastDroppedBytes: number
	lastDroppedChunks: number
	droppedBytes: number
	droppedChunks: number
	commandBytes: number
	drops: Array<{ at: number; bytes: number }>
}

export interface SamplingMonitorOptions {
	sampleRate: number
	/** Monotonic milliseconds; all deltas and deadlines use this. */
	now?: () => number
	/** Wall-clock milliseconds; only used to render ISO timestamps. */
	wallNow?: () => number
	/** Longer gaps between successful stats rebaseline instead of counting growth. */
	maxObservationGapMs?: number
}

/**
 * Derives upstream sampling evidence, delivery and drops from rtlmux counters.
 * USB presence and running processes never count as sampling on their own.
 */
export class SamplingMonitor {
	private readonly now: () => number
	private readonly wallNow: () => number
	private readonly configuredExpected: number
	private readonly startedAt: number
	private readonly maxObservationGapMs: number

	private rtlmuxPid: number | undefined
	private rtlTcpPid: number | undefined
	private processesSeen = false

	private epoch: { pid: number; startedAt: number } | null = null
	private lastDataIn: number | null = null
	private window: Array<{ at: number; dataIn: number }> = []
	private lastEvidenceAt: number | null = null
	private expectedSince: number
	private lastObservationAt: number | null = null
	private lastError: StatsError | null = null
	private rateBasis: "configured" | "client-controlled" = "configured"
	private lowEvaluations = 0
	private resets = 0
	private lastResetReason: SdrHostSampling["epoch"]["lastResetReason"] = null

	private clients = new Map<string, ClientTrack>()
	private drops: Array<{ at: number; bytes: number; chunks: number }> = []
	private droppedSinceStart = 0
	private history: Array<{ at: number; bytesPerSec: number | null }> = []

	constructor(options: SamplingMonitorOptions) {
		this.now = options.now ?? (() => performance.now())
		this.wallNow = options.wallNow ?? (() => Date.now())
		this.configuredExpected = options.sampleRate * 2
		this.maxObservationGapMs = options.maxObservationGapMs ?? 5_000
		this.startedAt = this.now()
		this.expectedSince = this.startedAt
	}

	/** Called on every poll with the current supervised process IDs. */
	observeProcesses(
		rtlmuxPid: number | undefined,
		rtlTcpPid: number | undefined,
	): void {
		const at = this.now()
		if (this.processesSeen && rtlmuxPid !== this.rtlmuxPid) {
			// rtlmux restarted or stopped: its counters, clients and evidence are gone.
			if (this.epoch) this.markReset("rtlmux-restart")
			this.dropEpoch(at)
		}
		if (this.processesSeen && rtlTcpPid !== this.rtlTcpPid) {
			// Same rtlmux counter keeps growing, but evidence must be re-earned
			// from the new rtl_tcp (it may hold a dead USB handle).
			// The first delta after a restart would include the old instance's
			// bytes, so the next sample is a baseline only.
			this.rearmDeadline(at)
			this.lastEvidenceAt = null
			this.lastDataIn = null
			this.window = []
			this.lowEvaluations = 0
			this.pushHistory(at, null)
		}
		this.rtlmuxPid = rtlmuxPid
		this.rtlTcpPid = rtlTcpPid
		this.processesSeen = true
	}

	observeStats(snapshot: RtlmuxStatsSnapshot, pid: number): void {
		const at = this.now()
		const dataIn = snapshot.server.dataIn
		const previousObservationAt = this.lastObservationAt
		this.lastObservationAt = at
		this.lastError = null

		if (!this.epoch || this.epoch.pid !== pid) {
			if (this.epoch) this.markReset("rtlmux-restart")
			this.startEpoch(pid, at, dataIn)
		} else if (this.lastDataIn !== null && dataIn < this.lastDataIn) {
			this.markReset("counter-decrease")
			this.startEpoch(pid, at, dataIn)
		} else if (
			previousObservationAt === null ||
			at - previousObservationAt > this.maxObservationGapMs
		) {
			// After an observation gap the delta spans unknown time; growth from a
			// trickle long ago must not read as current evidence.
			this.lastDataIn = dataIn
			this.window = [{ at, dataIn }]
			this.pushHistory(at, null)
		} else {
			const previous = this.window[this.window.length - 1]
			const delta = this.lastDataIn === null ? 0 : dataIn - this.lastDataIn
			if (delta >= MIN_EVIDENCE_BYTES) this.lastEvidenceAt = at
			this.pushHistory(
				at,
				previous && at > previous.at
					? (delta * 1000) / (at - previous.at)
					: null,
			)
			this.window.push({ at, dataIn })
			this.window = this.window.filter(
				sample => at - sample.at <= RATE_WINDOW_MS,
			)
			this.lastDataIn = dataIn
		}

		this.observeClients(snapshot, pid, at)
		this.evaluateRate()
	}

	observeFailure(error: StatsError): void {
		this.lastError = error
		this.pushHistory(this.now(), null)
	}

	sampling(): SdrHostSampling {
		const at = this.now()
		const stats = this.statsReading(at)
		const { state, reason } = this.evaluate(at)
		const rate = stats.state === "unavailable" ? null : this.rate()
		const expected = this.expected()
		const sampleAgeMs =
			this.lastEvidenceAt === null ? null : Math.round(at - this.lastEvidenceAt)
		return {
			state,
			reason,
			timeoutMs: SAMPLE_TIMEOUT_MS,
			lastSampleAt: this.iso(this.lastEvidenceAt),
			sampleAgeMs,
			upstream: {
				bytesTotal: stats.state === "unavailable" ? null : this.lastDataIn,
				bytesPerSec: rate?.bytesPerSec ?? null,
				windowMs: rate?.windowMs ?? null,
				expectedBytesPerSec: expected,
				rateBasis: this.rateBasis,
				rateStatus: this.rateStatus(rate?.bytesPerSec ?? null, state),
			},
			epoch: {
				rtlmuxPid: this.epoch?.pid ?? null,
				rtlTcpPid: this.rtlTcpPid ?? null,
				startedAt: this.iso(this.epoch?.startedAt ?? null),
				resets: this.resets,
				lastResetReason: this.lastResetReason,
			},
			stats,
		}
	}

	delivery(): SdrHostDelivery {
		const at = this.now()
		const statsState = this.statsReading(at).state
		const recentDrops = this.drops.filter(
			drop => at - drop.at <= DROP_WINDOW_MS,
		)
		const droppedBytesLast60s = recentDrops.reduce(
			(sum, drop) => sum + drop.bytes,
			0,
		)
		const droppedChunksLast60s = recentDrops.reduce(
			(sum, drop) => sum + drop.chunks,
			0,
		)
		const clients: SdrHostDeliveryClient[] =
			statsState === "unavailable"
				? []
				: [...this.clients.values()].map(client => ({
						key: client.key,
						address: client.address,
						connectedAt: client.connectedAt,
						queuedBytes: client.lastOut,
						queuedBytesPerSec: client.queuedBytesPerSec,
						droppedBytes: client.droppedBytes,
						droppedChunks: client.droppedChunks,
						droppedBytesLast60s: client.drops
							.filter(drop => at - drop.at <= DROP_WINDOW_MS)
							.reduce((sum, drop) => sum + drop.bytes, 0),
						commandBytes: client.commandBytes,
					}))
		const rates = clients
			.map(client => client.queuedBytesPerSec)
			.filter((rate): rate is number => rate !== null)
		let state: SdrHostDelivery["state"] = "unknown"
		if (statsState === "ok") {
			state =
				droppedBytesLast60s > 0
					? "dropping"
					: clients.length === 0
						? "idle"
						: "delivering"
		}
		return {
			state,
			clients,
			queuedBytesPerSec:
				rates.length > 0 ? rates.reduce((sum, rate) => sum + rate, 0) : null,
			droppedBytesLast60s,
			droppedChunksLast60s,
			droppedBytesSinceMonitorStart: this.droppedSinceStart,
			monitorStartedAt:
				this.iso(this.startedAt) ?? new Date(this.wallNow()).toISOString(),
		}
	}

	/** Per-poll upstream rate for the last five minutes, ages relative to now. */
	recentHistory(): Array<[ageMs: number, bytesPerSec: number | null]> {
		const at = this.now()
		return this.history
			.filter(point => at - point.at <= HISTORY_MS)
			.map(point => [
				Math.round(at - point.at),
				point.bytesPerSec === null ? null : Math.round(point.bytesPerSec),
			])
	}

	legacyStats(): RtlmuxStats {
		const delivery = this.delivery()
		return {
			clients: delivery.clients.length,
			bytesPerSec: delivery.queuedBytesPerSec ?? 0,
			totalBytesSent: delivery.clients.reduce(
				(sum, client) => sum + client.queuedBytes,
				0,
			),
			clientDetails: delivery.clients.map((client, index) => ({
				id: index,
				address: client.address,
				bytesDropped: client.droppedBytes,
			})),
		}
	}

	private evaluate(at: number): {
		state: SamplingState
		reason: string | null
	} {
		if (this.processesSeen && this.rtlmuxPid === undefined) {
			return { state: "disconnected", reason: "rtlmux not running" }
		}
		if (this.processesSeen && this.rtlTcpPid === undefined) {
			return { state: "disconnected", reason: "rtl_tcp not running" }
		}
		const observationAge =
			this.lastObservationAt === null ? null : at - this.lastObservationAt
		if (
			!this.epoch ||
			observationAge === null ||
			observationAge > SAMPLE_TIMEOUT_MS
		) {
			if (at - this.expectedSince < SAMPLE_TIMEOUT_MS) {
				return { state: "waiting", reason: "starting" }
			}
			return {
				state: "unknown",
				reason: `rtlmux stats ${this.lastError ?? "timeout"}`,
			}
		}
		if (
			this.lastEvidenceAt !== null &&
			at - this.lastEvidenceAt < SAMPLE_TIMEOUT_MS
		) {
			return { state: "streaming", reason: null }
		}
		const since = Math.max(this.lastEvidenceAt ?? -Infinity, this.expectedSince)
		if (at - since >= SAMPLE_TIMEOUT_MS) {
			return {
				state: "stale",
				reason:
					this.lastEvidenceAt === null
						? "no samples since receiver start"
						: "upstream byte count stopped growing",
			}
		}
		return { state: "waiting", reason: "starting" }
	}

	private rate(): { bytesPerSec: number; windowMs: number } | null {
		const first = this.window[0]
		const last = this.window[this.window.length - 1]
		if (!first || !last || last.at - first.at < MIN_RATE_SPAN_MS) return null
		return {
			bytesPerSec: ((last.dataIn - first.dataIn) * 1000) / (last.at - first.at),
			windowMs: Math.round(last.at - first.at),
		}
	}

	private expected(): number | null {
		return this.rateBasis === "configured" ? this.configuredExpected : null
	}

	private evaluateRate(): void {
		const rate = this.rate()?.bytesPerSec ?? null
		const expected = this.expected()
		const below =
			rate !== null && expected !== null && rate < expected * LOW_RATE_FRACTION
		this.lowEvaluations = below ? this.lowEvaluations + 1 : 0
	}

	private rateStatus(
		rate: number | null,
		state: SamplingState,
	): SdrHostSampling["upstream"]["rateStatus"] {
		if (rate === null) return "unknown"
		if (state === "streaming" && rate < RATE_FLOOR_BYTES_PER_SEC) return "low"
		const expected = this.expected()
		if (expected === null) return "unknown"
		if (state === "streaming" && this.lowEvaluations >= 2) return "low"
		return state === "streaming" ? "nominal" : "unknown"
	}

	private statsReading(at: number): SdrHostSampling["stats"] {
		const age =
			this.lastObservationAt === null ? null : at - this.lastObservationAt
		let state: ReadingState = "unavailable"
		if (age !== null && age <= STATS_OK_MS) state = "ok"
		else if (age !== null && age <= STATS_EXPIRE_MS) state = "stale"
		return {
			state,
			observedAt: this.iso(this.lastObservationAt),
			ageMs: age === null ? null : Math.round(age),
			lastError: this.lastError,
		}
	}

	private observeClients(
		snapshot: RtlmuxStatsSnapshot,
		pid: number,
		at: number,
	): void {
		const seen = new Set<string>()
		for (const raw of snapshot.clients) {
			const host = raw.client.host.replace(/^::ffff:/i, "")
			const key = `${pid}|${host}|${raw.client.port}|${raw.connected ?? ""}`
			seen.add(key)
			if (raw.dataIn > 0) this.rateBasis = "client-controlled"
			const known = this.clients.get(key)
			if (!known) {
				// First sighting is only a baseline; earlier drops are not ours to count.
				this.clients.set(key, {
					key,
					address: host.includes(":")
						? `[${host}]:${raw.client.port}`
						: `${host}:${raw.client.port}`,
					connectedAt:
						raw.connected === undefined
							? null
							: new Date(raw.connected * 1000).toISOString(),
					lastOut: raw.dataOut,
					lastAt: at,
					queuedBytesPerSec: null,
					lastDroppedBytes: raw.dropped.size,
					lastDroppedChunks: raw.dropped.count,
					droppedBytes: raw.dropped.size,
					droppedChunks: raw.dropped.count,
					commandBytes: raw.dataIn,
					drops: [],
				})
				continue
			}
			const elapsed = at - known.lastAt
			known.queuedBytesPerSec =
				elapsed > 0
					? Math.max(0, ((raw.dataOut - known.lastOut) * 1000) / elapsed)
					: null
			const droppedBytes = Math.max(
				0,
				raw.dropped.size - known.lastDroppedBytes,
			)
			const droppedChunks = Math.max(
				0,
				raw.dropped.count - known.lastDroppedChunks,
			)
			if (droppedBytes > 0 || droppedChunks > 0) {
				known.drops.push({ at, bytes: droppedBytes })
				this.drops.push({ at, bytes: droppedBytes, chunks: droppedChunks })
				this.droppedSinceStart += droppedBytes
			}
			known.drops = known.drops.filter(drop => at - drop.at <= DROP_WINDOW_MS)
			known.lastOut = raw.dataOut
			known.lastAt = at
			known.lastDroppedBytes = raw.dropped.size
			known.lastDroppedChunks = raw.dropped.count
			known.droppedBytes = raw.dropped.size
			known.droppedChunks = raw.dropped.count
			known.commandBytes = raw.dataIn
		}
		for (const key of this.clients.keys()) {
			if (!seen.has(key)) this.clients.delete(key)
		}
		// Departed clients' drops stay in the aggregate until they age out.
		this.drops = this.drops.filter(drop => at - drop.at <= DROP_WINDOW_MS)
	}

	private startEpoch(pid: number, at: number, dataIn: number): void {
		this.epoch = { pid, startedAt: at }
		this.lastDataIn = dataIn
		this.window = [{ at, dataIn }]
		this.rearmDeadline(at)
		this.lastEvidenceAt = null
		this.rateBasis = "configured"
		this.lowEvaluations = 0
		this.clients.clear()
		this.pushHistory(at, null)
	}

	private dropEpoch(at: number): void {
		this.epoch = null
		this.lastDataIn = null
		this.window = []
		this.rearmDeadline(at)
		this.lastEvidenceAt = null
		this.lastObservationAt = null
		this.rateBasis = "configured"
		this.lowEvaluations = 0
		this.clients.clear()
		this.pushHistory(at, null)
	}

	/**
	 * A restart grants a fresh start-up grace period only if the previous run
	 * produced evidence. A crash-looping receiver keeps its earliest unmet
	 * deadline, so it reaches "stale" instead of waiting forever.
	 */
	private rearmDeadline(at: number): void {
		if (this.lastEvidenceAt !== null) this.expectedSince = at
	}

	private markReset(
		reason: NonNullable<SdrHostSampling["epoch"]["lastResetReason"]>,
	): void {
		this.resets += 1
		this.lastResetReason = reason
	}

	private pushHistory(at: number, bytesPerSec: number | null): void {
		const last = this.history[this.history.length - 1]
		// Collapse consecutive gaps; one null is enough to break the trace.
		if (bytesPerSec === null && last?.bytesPerSec === null) return
		this.history.push({ at, bytesPerSec })
		while (
			this.history.length > 0 &&
			at - (this.history[0]?.at ?? at) > HISTORY_MS
		) {
			this.history.shift()
		}
	}

	private iso(monotonic: number | null): string | null {
		if (monotonic === null) return null
		return new Date(this.wallNow() - (this.now() - monotonic)).toISOString()
	}
}

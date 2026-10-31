/**
 * Source Manager - TCP connections to SDR sources with auto-reconnect
 *
 * Requirements:
 * - 1.1: Establish TCP connection to specified host and port
 * - 1.2: Retry with exponential backoff (2s, 4s, 8s, max 30s)
 * - 1.3: Emit 'connected' event with source ID
 * - 1.4: Emit 'disconnected' event and begin reconnection attempts
 * - 1.5: Emit data rate metrics every 5 seconds
 * - 1.6: Handle connection errors gracefully (ECONNREFUSED, ETIMEDOUT, ECONNRESET)
 * - 1.7: Return status information including connection state, bytes received, and data rate
 * - 10.2: Keep API responsive when source unavailable
 * - 10.3: Report degraded status in health check
 * - 15.1: Establish independent TCP connections to multiple sources
 * - 15.2: Assign decoders to specific sources by source ID
 * - 15.3: Prevent multiple decoders from sharing exclusive sources
 * - 15.4: Return capabilities (kind, sampleRate, format, exclusive) for each source
 * - 15.5: Support source kinds: audio_pcm, iq, recording
 * - 16.1: Validate and store source capabilities
 * - 16.2: Verify capability compatibility before attachment
 * - 16.3: Return compatibility error if decoder input type doesn't match source kind
 */

import { EventEmitter } from "node:events"
import { AsyncLocalStorage } from "node:async_hooks"
import * as net from "node:net"
import * as fs from "node:fs"
import { types as utilTypes } from "node:util"
import type { Readable } from "node:stream"
import { PassThrough } from "node:stream"
import { SOURCE_RESUME_FAILED_MESSAGE } from "@wavekit/api-types"
import type {
	SourceActivity,
	SourceEndpoint,
	SourceFeed,
	SourceFeedState,
} from "@wavekit/api-types"
import type { Logger } from "../utils/logger.js"
import { SourceConnectionError, WaveKitError } from "../utils/errors.js"
import type { SourceConfig, SourceCaps } from "../config.js"
import { detectAudioFormat } from "../utils/audio-analyzer.js"
import { convertFloat32ToS16LE } from "../utils/converters.js"
import {
	RateTruthTracker,
	bytesPerSampleFor,
	type RateMismatch,
} from "./rate-truth.js"
import {
	SignalLevelTracker,
	iqComponentFormatFor,
	type SignalFlat,
} from "./signal-level.js"
import {
	SourceFeedStore,
	type SourceFeedPersistence,
} from "./source-feed-store.js"

import {
	isReceiverSourceId,
	isReceiverTime,
	isReceiverToken,
} from "./tuner-capabilities/types.js"
import type {
	ReceiverEvidenceRead,
	ReceiverEvidencePageRead,
	SourceReceiverEvidence,
} from "./tuner-capabilities/types.js"

// Bound startup/reconnect waits without treating quiet connected sources as failures.
export const SOURCE_CONNECT_TIMEOUT_MS = 5000
// One command gets the same budget as one maximum first reconnect attempt:
// 2^1 × 2 s backoff + 5 s connect timeout = 9 s, excluding FIFO/recovery waits.
export const TUNER_COMMAND_TIMEOUT_MS =
	2 ** 1 * 2000 + SOURCE_CONNECT_TIMEOUT_MS
// 1 executing command + 15 waiting commands = at most 16 retained requests per source.
export const TUNER_COMMAND_QUEUE_LIMIT = 16
// Default stall watchdog for continuous-stream rtl_tcp IQ sessions (0 = off).
export const SOURCE_STALL_TIMEOUT_MS = 15_000
// TCP keepalive is defence in depth for a dead peer (Node 21+ on Linux probes
// every 1 s, 10 probes). It cannot detect a live rtlmux whose upstream dongle /
// rtl_tcp is gone: that socket stays healthy but silent, hence the watchdog.
export const SOURCE_KEEPALIVE_DELAY_MS = 5000

/** Reconnect delay after a deliberate endpoint switch (not a failure). */
export const SOURCE_RETARGET_RECONNECT_MS = 250
/**
 * A pause half-closes the receiver connection (FIN) and waits this long for the peer to
 * close its side before destroying the socket; rtl_tcp closes at once on end of stream.
 */
export const SOURCE_PAUSE_CLOSE_TIMEOUT_MS = 2000
/**
 * Fallback from a selected endpoint (receiver-endpoints 3.4): this many failures
 * (a failed attempt, or any session that ends without a deliberate switch)
 * within SOURCE_ENDPOINT_FAILURE_WINDOW_MS send the source back to its
 * configured host. An endpoint that fails more often than every 300 s (3 inside
 * 600 s) therefore falls back, whatever each session's length. A dead endpoint falls
 * back after 3 refused attempts: the 250 ms switch delay, then reconnect
 * backoff of 2-4 s and 4-8 s, about 12.3 s at most. Isolated drops more than
 * 300 s apart never trigger it.
 */
export const SOURCE_ENDPOINT_FALLBACK_FAILURES = 3
export const SOURCE_ENDPOINT_FAILURE_WINDOW_MS = 10 * 60_000

/** Failure times on a selected endpoint, in a sliding window. */
export class EndpointFailureWindow {
	private times: number[] = []

	constructor(
		private readonly threshold = SOURCE_ENDPOINT_FALLBACK_FAILURES,
		private readonly windowMs = SOURCE_ENDPOINT_FAILURE_WINDOW_MS,
	) {}

	/** Records a failure at `now`; true when the window now holds the threshold. */
	record(now: number): boolean {
		this.times = this.times.filter(t => now - t < this.windowMs)
		this.times.push(now)
		return this.times.length >= this.threshold
	}

	reset(): void {
		this.times = []
	}
}

// Re-export types from config for convenience
export type { SourceConfig, SourceCaps } from "../config.js"

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Source kind - the type of data the source provides (Requirement 15.5)
 */
export type SourceKind = "audio_pcm" | "iq" | "recording"

/**
 * Decoder capabilities - used for compatibility checking (Requirements 16.2, 16.3)
 */
export type DecoderInputType = "audio_pcm" | "iq" | "external"

export interface DecoderCaps {
	/** Type of input the decoder expects */
	input: DecoderInputType
	/** Whether the decoder wants exclusive access to the source */
	wantsExclusiveSource?: boolean
	/** Preferred sample rates for the decoder */
	preferredSampleRates?: number[]
}

export interface SourceStatus {
	id: string
	type?: SourceConfig["type"]
	url?: string
	connected: boolean
	activity: SourceActivity
	bytesReceived: number
	dataRate: number // KB/s
	lastError?: string | undefined
	reconnectAttempts: number
	caps: SourceCaps
	/** Present only while the measured rate disagrees with caps (rate-truth check). */
	rateMismatch?: RateMismatch | undefined
	/** Present only while the IQ level has stayed implausibly low (signal-flat check). */
	signalFlat?: SignalFlat | undefined
	/** Latest measured IQ level (dBFS); IQ network sources with data only. */
	signalLevelDbfs?: number | undefined
	/** Receiver endpoint selection; only for sources it tracks. */
	endpoint?: SourceEndpoint | undefined
	/** Pause / resume state; network sources only (recordings omit it). */
	feed?: SourceFeed | undefined
}

/** What pause() and resume() answer. */
export interface SourceFeedResult {
	feed: SourceFeed
	/** True when this call changed the feed (false for a repeated pause or resume). */
	changed: boolean
	/**
	 * False when saving the paused feeds failed: the change holds in memory until the core
	 * restarts, and a repeated pause or resume retries the write. True without persistence.
	 */
	persisted: boolean
}

export interface SourceManagerOptions {
	/** Signal-flat threshold in dBFS (default SIGNAL_FLAT_THRESHOLD_DBFS). */
	signalFlatThresholdDbfs?: number | undefined
	/** Signal-flat hold time in ms (default SIGNAL_FLAT_HOLD_MS). */
	signalFlatHoldMs?: number | undefined
	/**
	 * Persists paused feeds in `<stateDir>/source-feed.json` (SourceFeedStore). Without it
	 * (or `feedPersistence`) a pause lasts until the process ends.
	 */
	stateDir?: string | undefined
	/** Overrides the store built from `stateDir` (tests). */
	feedPersistence?: SourceFeedPersistence | undefined
}

/**
 * RTL-TCP header information captured from the source stream (if available).
 */
export interface RtlTcpHeaderInfo {
	magic: string
	tunerType: number
	gainCount: number
}

function formatSourceUrl(config: SourceConfig): string {
	if (config.type === "recording") {
		return config.filePath ?? ""
	}
	if (config.host && config.port) {
		return `${config.host}:${config.port}`
	}
	return ""
}

export interface SourceManagerEvents {
	connected: (sourceId: string) => void
	disconnected: (sourceId: string, error?: Error) => void
	"commanded-recovery-failed": (sourceId: string) => void
	error: (sourceId: string, error: Error) => void
	data: (sourceId: string, chunk: Buffer) => void
	metrics: (
		sourceId: string,
		metrics: { bytesReceived: number; dataRate: number },
	) => void
	ended: (sourceId: string) => void // For recording sources
	/** Internal teardown signal: permanent removal, reconnect and shutdown (see teardown()). */
	removed: (sourceId: string) => void
	/** Permanent removal only (disconnect()); never on reconnect or shutdown. */
	"source-removed": (sourceId: string, removedAt: Date) => void
	/**
	 * The feed state changed (pause, resume start, resume success or failure). While it is
	 * not "live" the source is paused: consumers hold back with reason "source-paused".
	 * A pause's "disconnected" follows once the connection closed.
	 */
	"feed-changed": (sourceId: string, feed: SourceFeed) => void
	"caps-changed": (sourceId: string, caps: SourceCaps) => void // For dynamic sample rate
	/** The rate-truth mismatch flag was raised or cleared (see getStatus().rateMismatch). */
	"rate-truth-changed": (sourceId: string) => void
	/** The signal-flat flag was raised or cleared (see getStatus().signalFlat). */
	"signal-flat-changed": (sourceId: string) => void
	/**
	 * First payload bytes of a session (after rtl_tcp header stripping), once
	 * per connection. Through rtlmux this means the upstream dongle is back.
	 */
	"payload-started": (sourceId: string) => void
	/**
	 * A selected endpoint failed repeatedly and the source went back to its
	 * configured host (receiver-endpoints 3.4); `host` is the endpoint left.
	 */
	"endpoint-fallback": (sourceId: string, host: string) => void
}

// Exponential backoff constants
const BASE_DELAY_MS = 2000
const MAX_DELAY_MS = 30000
const METRICS_INTERVAL_MS = 5000
const RTL_TCP_HEADER_SIZE = 12
const SAMPLE_TIMEOUT_MS = 10000

/**
 * Calculates exponential backoff delay for reconnection attempts.
 * Formula: min(2^attempts * baseDelay, maxDelay)
 *
 * @param attempts - Number of consecutive failed attempts
 * @returns Delay in milliseconds before next attempt
 */
/**
 * True while the operator holds the feed off on purpose (paused, or resuming from a pause): the
 * source is meant to be disconnected, so health and the degraded-mode monitor leave it out. A
 * failed resume ("error") is not held: the operator asked for the feed and it did not come back.
 */
export function feedHeldOffline(status: {
	feed?: SourceFeed | undefined
}): boolean {
	return status.feed?.state === "paused" || status.feed?.state === "resuming"
}

export function calculateBackoffDelay(attempts: number): number {
	const delay = Math.pow(2, attempts) * BASE_DELAY_MS
	return Math.min(delay, MAX_DELAY_MS)
}

function parseRtlTcpHeader(buffer: Buffer): RtlTcpHeaderInfo | null {
	if (buffer.length < RTL_TCP_HEADER_SIZE) {
		return null
	}
	try {
		const magic = buffer.toString("ascii", 0, 4)
		const tunerType = buffer.readUInt32BE(4)
		const gainCount = buffer.readUInt32BE(8)
		return { magic, tunerType, gainCount }
	} catch {
		return null
	}
}

interface SourceAttempt {
	socket: net.Socket
	phase: "connecting" | "connected" | "failed" | "closed"
	sessionId: string | null
	lastSampleAt: number | null
	expectedSince: number
	paused: boolean
	header: Buffer | null
	headerBuffer: Buffer | null
	headerAt: number | null
	watchdog: ReturnType<typeof setInterval> | null
	/** Opened by resume() of a paused feed (isResumedSession). */
	resumed?: boolean
}

interface SourceState {
	incarnation: string | null
	attempt: SourceAttempt | null
	evidencePaused: boolean

	config: SourceConfig
	socket: net.Socket | null
	stream: PassThrough
	connected: boolean
	lastSampleAt: number | null
	expectedSince: number
	recordingEnded: boolean
	bytesReceived: number
	sessionBytesReceived: number
	bytesReceivedSinceLastMetric: number
	lastMetricTime: number
	dataRate: number
	/** Measured versus declared rate; network sources only. */
	rateTruth: RateTruthTracker
	/** Subsampled IQ level; IQ network sources only. */
	signalLevel: SignalLevelTracker
	/** The socket was paused for backpressure during the current metrics interval. */
	pausedSinceLastMetric: boolean
	/** Metrics intervals completed in this session (the first one is partial). */
	metricTicksSinceConnect: number
	lastError?: string | undefined
	reconnectAttempts: number
	reconnectTimer: ReturnType<typeof setTimeout> | null
	/** Host override from endpoint selection; null uses config.host. */
	activeHost: string | null
	/** Endpoint selection status; null when selection does not track the source. */
	endpoint: SourceEndpoint | null
	/** The next reconnect follows a deliberate switch: short delay, no backoff step. */
	retargetPending: boolean
	/** connect() still awaits its first attempt; that attempt must settle it. */
	connectPending: boolean
	/** Failures on the selected endpoint since the last switch (sliding window). */
	endpointFailures: EndpointFailureWindow

	metricsTimer: ReturnType<typeof setInterval> | null
	stallTimer: ReturnType<typeof setInterval> | null
	stopping: boolean
	// Format detection
	activeFormat: SourceCaps["format"] | "UNKNOWN"
	detectionBuffer: Buffer | null
	conversionRemainder: Buffer
	iqRemainder: Buffer
	// RTL-TCP header capture (IQ sources)
	rtlTcpHeader: Buffer | null
	rtlTcpHeaderInfo: RtlTcpHeaderInfo | null
	rtlTcpHeaderBuffer: Buffer | null
	/** Pause / resume state (network sources; a recording stays "live"). */
	feed: { state: SourceFeedState; since: number }
	// Recording source specific state
	recordingState?: RecordingState | undefined
}

/**
 * State for recording sources (Requirement 21)
 */
interface RecordingState {
	fileDescriptor: number | null
	playbackTimer: ReturnType<typeof setTimeout> | null
	position: number
	fileSize: number
	chunkSize: number
	isPlaying: boolean
}

/**
 * Tracks decoder-source assignments (Requirement 15.2)
 */
interface DecoderAssignment {
	wantsExclusiveSource: boolean
	decoderId: string
	sourceId: string
	assignedAt: Date
}

/**
 * Error thrown when source-decoder compatibility check fails (Requirement 16.3)
 */
export class SourceCompatibilityError extends Error {
	constructor(
		public readonly sourceId: string,
		public readonly decoderId: string,
		public readonly reason: string,
	) {
		super(
			`Source ${sourceId} is not compatible with decoder ${decoderId}: ${reason}`,
		)
		this.name = "SourceCompatibilityError"
	}
}

/**
 * Error thrown when trying to assign multiple decoders to an exclusive source (Requirement 15.3)
 */
export class ExclusiveSourceError extends Error {
	constructor(
		public readonly sourceId: string,
		public readonly existingDecoderId: string,
		public readonly newDecoderId: string,
	) {
		super(
			`Source ${sourceId} is exclusive and already assigned to decoder ${existingDecoderId}. Cannot assign to ${newDecoderId}.`,
		)
		this.name = "ExclusiveSourceError"
	}
}

/**
 * Bytes per complex sample for IQ formats (CU8 pair 2, CS16 pair 4, CF32
 * pair 8); null for audio and undeclared formats, which are not aligned.
 */
export function iqFrameBytes(
	caps: Pick<SourceCaps, "kind" | "format">,
): number | null {
	if (caps.kind !== "iq") return null
	switch (caps.format) {
		case "U8_IQ":
			return 2
		case "S16_IQ":
			return 4
		case "FLOAT32LE":
			return 8
		default:
			return null
	}
}

/** Prepends the carried remainder and cuts `chunk` to whole frames. */
export function alignIqChunk(
	remainder: Buffer,
	chunk: Buffer,
	frameBytes: number,
): { aligned: Buffer; remainder: Buffer } {
	const input = remainder.length ? Buffer.concat([remainder, chunk]) : chunk
	const length = input.length - (input.length % frameBytes)
	return {
		aligned: input.subarray(0, length),
		remainder: Buffer.from(input.subarray(length)),
	}
}

/**
 * Listener cap per event on SourceManager (Node warns past it; 10 by default). Its busiest
 * event, `caps-changed`, has one listener per subsystem, not per connection:
 * - 8 fixed: the fanout router (rate and caps), the entry point's fan-out (VFO, coverage,
 *   the sources WebSocket), DecoderManager, ChannelizerManager, ScannerService, the source
 *   status publisher and LiveDemodulator;
 * - 2 per source: its SpectrumEngine and, for up to 1 s after a lease restore, the scanner's
 *   restore waiter;
 * - 1 per IQ snapshot request in flight.
 * Two sources and four concurrent snapshots: 8 + 2 x 2 + 4 = 16. A count past that is a leak
 * worth the warning. A reconnect adds none (source-caps-listeners test).
 */
export const SOURCE_MANAGER_MAX_LISTENERS = 16

export class SourceManager extends EventEmitter {
	private sources: Map<string, SourceState> = new Map()
	private evidenceCounter: bigint = 1n
	private evidenceFailed = false
	private decoderAssignments: Map<string, DecoderAssignment> = new Map()
	private logger: Logger
	private readonly options: SourceManagerOptions
	/** Ids whose feed the operator paused (persisted); outlives a registration. */
	private readonly pausedIds = new Set<string>()
	private readonly feedPersistence: SourceFeedPersistence | null
	/** Settles once the persisted pauses were read (null: nothing to read). */
	private feedLoad: Promise<void> | null = null
	private feedsLoaded: boolean
	/** Pause and resume of one source run one at a time, in call order. */
	private readonly feedChains = new Map<string, Promise<unknown>>()
	/**
	 * The state file may not match `pausedIds`: the latest write failed (or none settled yet).
	 * A repeated pause or resume writes again even when the in-memory set did not change.
	 */
	private feedsUnsaved = false
	/** Generation of the latest write; only its outcome sets `feedsUnsaved`. */
	private feedSaveGeneration = 0

	constructor(logger: Logger, options: SourceManagerOptions = {}) {
		super()
		this.setMaxListeners(SOURCE_MANAGER_MAX_LISTENERS)
		this.logger = logger.child({ component: "SourceManager" })
		this.options = options
		this.feedPersistence =
			options.feedPersistence ??
			(options.stateDir !== undefined
				? new SourceFeedStore({ stateDir: options.stateDir, logger })
				: null)
		this.feedsLoaded = this.feedPersistence === null
	}

	private plainSourceData<T>(value: T): T {
		let nodes = 0
		const copy = (item: unknown, depth: number): unknown => {
			if (++nodes > 128 || depth > 4)
				throw new WaveKitError("Invalid source data", "SOURCE_CONFIG_INVALID")
			if (
				item === null ||
				item === undefined ||
				typeof item === "string" ||
				typeof item === "number" ||
				typeof item === "boolean"
			)
				return item
			if (
				typeof item !== "object" ||
				utilTypes.isProxy(item) ||
				(Object.getPrototypeOf(item) !== Object.prototype &&
					Object.getPrototypeOf(item) !== null)
			)
				throw new WaveKitError("Invalid source data", "SOURCE_CONFIG_INVALID")
			const keys = Reflect.ownKeys(item)
			if (keys.length > 32)
				throw new WaveKitError("Invalid source data", "SOURCE_CONFIG_INVALID")
			const result: Record<string, unknown> = {}
			for (const key of keys) {
				if (typeof key !== "string")
					throw new WaveKitError("Invalid source data", "SOURCE_CONFIG_INVALID")
				const descriptor = Object.getOwnPropertyDescriptor(item, key)
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
					throw new WaveKitError("Invalid source data", "SOURCE_CONFIG_INVALID")
				Object.defineProperty(result, key, {
					value: copy(descriptor.value, depth + 1),
					enumerable: true,
					writable: true,
					configurable: true,
				})
			}
			return result
		}
		return copy(value, 0) as T
	}

	private isCurrent(state: SourceState): boolean {
		return !state.stopping && this.sources.get(state.config.id) === state
	}

	private isActiveAttempt(state: SourceState, attempt: SourceAttempt): boolean {
		return (
			this.isCurrent(state) &&
			state.attempt === attempt &&
			state.socket === attempt.socket &&
			(attempt.phase === "connecting" || attempt.phase === "connected")
		)
	}

	private allocateEvidenceToken(): string | null {
		if (this.evidenceFailed) return null
		if (
			typeof this.evidenceCounter !== "bigint" ||
			this.evidenceCounter < 1n ||
			this.evidenceCounter > (1n << 128n) - 1n
		) {
			this.evidenceFailed = true
			return null
		}
		try {
			const token = this.evidenceCounter.toString(16).padStart(32, "0")
			this.evidenceCounter += 1n
			return token
		} catch {
			this.evidenceFailed = true
			return null
		}
	}

	/** Data descriptors only: a capture never invokes a config/caps getter. */
	private evidencePrimitive(object: object, key: string): unknown {
		const descriptor = Object.getOwnPropertyDescriptor(object, key)
		return descriptor && "value" in descriptor ? descriptor.value : undefined
	}

	private evidencePrecheck(
		id: string,
		state: SourceState,
	): "unavailable" | "conflict" | "limit" | null {
		if (!isReceiverSourceId(id)) return "limit"
		if (!this.isCurrent(state)) return "conflict"
		if (state.incarnation === null) return "unavailable"
		if (!isReceiverToken(state.incarnation)) return "conflict"
		const config = state.config
		const type = this.evidencePrimitive(config, "type")
		const caps: unknown = this.evidencePrimitive(config, "caps")
		if (caps === null || typeof caps !== "object") return "conflict"
		const kind = this.evidencePrimitive(caps, "kind")
		const format = this.evidencePrimitive(caps, "format")
		const sampleRate = this.evidencePrimitive(caps, "sampleRate")
		const centerFreq = this.evidencePrimitive(caps, "centerFreq")
		if (
			typeof type !== "string" ||
			typeof kind !== "string" ||
			typeof format !== "string" ||
			!["rtl_tcp", "sdrpp-network", "recording"].includes(type) ||
			!["iq", "audio_pcm", "recording"].includes(kind) ||
			!["U8_IQ", "S16_IQ", "S16LE", "FLOAT32LE", "auto"].includes(format)
		)
			return "conflict"
		if (
			typeof sampleRate !== "number" ||
			!Number.isSafeInteger(sampleRate) ||
			sampleRate <= 0 ||
			(centerFreq !== undefined &&
				(typeof centerFreq !== "number" ||
					!Number.isSafeInteger(centerFreq) ||
					centerFreq <= 0))
		)
			return "conflict"
		if (
			!isReceiverTime(state.expectedSince) ||
			(state.lastSampleAt !== null && !isReceiverTime(state.lastSampleAt))
		)
			return "conflict"
		const attempt = state.attempt
		if (
			type !== "recording" &&
			attempt &&
			(attempt.phase === "connecting" || attempt.phase === "connected")
		) {
			if (attempt.sessionId === null) return "unavailable"
			if (
				!isReceiverToken(attempt.sessionId) ||
				!isReceiverTime(attempt.expectedSince) ||
				(attempt.lastSampleAt !== null && !isReceiverTime(attempt.lastSampleAt))
			)
				return "conflict"
			if (
				state.socket !== attempt.socket ||
				(attempt.headerAt !== null && !isReceiverTime(attempt.headerAt))
			)
				return "conflict"
		}
		return null
	}

	private copyReceiverEvidence(
		id: string,
		state: SourceState,
		now: number,
		snapshotId: string,
	): SourceReceiverEvidence {
		// Preflight has checked descriptors/types. No user callback occurs in this copy.
		const caps = this.evidencePrimitive(state.config, "caps") as SourceCaps
		const type = this.evidencePrimitive(
			state.config,
			"type",
		) as SourceConfig["type"]
		const source = {
			type,
			kind: this.evidencePrimitive(caps, "kind") as SourceCaps["kind"],
			format: this.evidencePrimitive(caps, "format") as SourceCaps["format"],
		}
		const attempt = state.attempt
		const phase =
			type === "recording"
				? state.recordingEnded
					? "ended"
					: state.connected
						? "connected"
						: "disconnected"
				: attempt?.phase === "connected"
					? "connected"
					: attempt?.phase === "connecting"
						? "connecting"
						: "disconnected"
		const sample =
			phase === "connected"
				? type === "recording"
					? state.lastSampleAt
					: attempt!.lastSampleAt
				: null
		const expectedSince =
			type === "recording"
				? state.expectedSince
				: (attempt?.expectedSince ?? state.expectedSince)
		const paused =
			type === "recording" ? state.evidencePaused : (attempt?.paused ?? false)
		const age = sample === null ? null : Math.max(0, now - sample)
		const sinceSample = now - Math.max(sample ?? 0, expectedSince)
		const delivery =
			phase === "ended"
				? "ended"
				: phase === "disconnected"
					? "disconnected"
					: phase === "connecting"
						? "waiting"
						: paused
							? "paused"
							: age !== null && age < SAMPLE_TIMEOUT_MS
								? "streaming"
								: sinceSample >= SAMPLE_TIMEOUT_MS
									? "stale"
									: "waiting"
		const headerApplicable =
			type === "rtl_tcp" && source.kind === "iq" && source.format === "U8_IQ"
		const complete =
			headerApplicable && phase === "connected" && attempt!.header !== null
		const partial =
			headerApplicable &&
			phase === "connected" &&
			(attempt!.headerBuffer?.length ?? 0) > 0
		return {
			sourceId: id,
			sourceStateToken: state,
			sourceIncarnation: state.incarnation!,
			sessionId:
				type !== "recording" &&
				(phase === "connecting" || phase === "connected")
					? attempt!.sessionId
					: null,
			snapshotId,
			capturedAt: now,
			source,
			caps: {
				sampleRate: this.evidencePrimitive(caps, "sampleRate") as number,
				centerFreq:
					(this.evidencePrimitive(caps, "centerFreq") as number | undefined) ??
					null,
			},
			connection: phase,
			delivery: {
				state: delivery,
				lastSampleAt: sample,
				sampleAgeMs: age,
				timeoutMs: 10000,
			},
			header: {
				capture: !headerApplicable
					? "not-applicable"
					: complete
						? "complete"
						: partial
							? "partial"
							: "missing",
				bytes: complete ? Buffer.from(attempt!.header!) : null,
				capturedAt: complete ? attempt!.headerAt : null,
			},
		}
	}

	getReceiverEvidence(id: string): ReceiverEvidenceRead {
		const state = this.sources.get(id)
		if (!state) return { kind: "missing" }
		const failure = this.evidencePrecheck(id, state)
		if (failure !== null) return { kind: failure }
		const now = Date.now()
		if (!isReceiverTime(now)) return { kind: "conflict" }
		const snapshotId = this.allocateEvidenceToken()
		if (snapshotId === null) return { kind: "unavailable" }
		return {
			kind: "present",
			evidence: this.copyReceiverEvidence(id, state, now, snapshotId),
		}
	}

	getReceiverEvidencePage(
		after: string | null,
		limit: number,
	): ReceiverEvidencePageRead {
		if (
			(after !== null && !isReceiverSourceId(after)) ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 16
		)
			return { kind: "conflict" }
		const selected: { id: string; state: SourceState }[] = []
		const compare = (a: string, b: string) =>
			Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
		for (const [id, state] of this.sources) {
			if (!isReceiverSourceId(id)) return { kind: "limit" }
			if (after !== null && compare(id, after) <= 0) continue
			let index = 0
			while (index < selected.length && compare(selected[index]!.id, id) < 0)
				index++
			if (index <= limit) {
				if (selected.length === limit + 1) selected.pop()
				selected.splice(index, 0, { id, state })
			}
		}
		for (const { id, state } of selected) {
			const failure = this.evidencePrecheck(id, state)
			if (failure !== null) return { kind: failure }
		}
		const now = Date.now()
		if (!isReceiverTime(now)) return { kind: "conflict" }
		if (selected.length === 0)
			return {
				kind: "candidates",
				candidates: [],
				capturedAt: now,
				snapshotId: null,
			}
		const snapshotId = this.allocateEvidenceToken()
		if (snapshotId === null) return { kind: "unavailable" }
		return {
			kind: "candidates",
			candidates: selected.map(({ id, state }) =>
				this.copyReceiverEvidence(id, state, now, snapshotId),
			),
			capturedAt: now,
			snapshotId,
		}
	}

	/**
	 * Connects to an SDR source over TCP.
	 * Returns a Readable stream that emits audio data.
	 *
	 * @param config - Source configuration
	 * @returns Readable stream for the source data
	 */
	async connect(config: SourceConfig): Promise<Readable> {
		config = this.plainSourceData(config)
		// The persisted pauses are read once, before the first registration; nothing awaits
		// between the duplicate check below and the registration.
		if (!this.feedsLoaded) await this.loadFeeds()
		if (this.sources.has(config.id)) {
			throw new Error(`Source ${config.id} already exists`)
		}

		// Validate config has required fields based on type
		if (config.type === "recording") {
			if (!config.filePath) {
				throw new Error(`Recording source ${config.id} requires filePath`)
			}
		} else {
			if (!config.host || !config.port) {
				throw new Error(`Network source ${config.id} requires host and port`)
			}
		}

		const stream = new PassThrough({
			highWaterMark: 256 * 1024, // 256KB buffer
		})

		const state: SourceState = {
			incarnation: this.allocateEvidenceToken(),
			attempt: null,
			evidencePaused: false,
			config,
			socket: null,
			stream,
			connected: false,
			lastSampleAt: null,
			expectedSince: Date.now(),
			recordingEnded: false,
			bytesReceived: 0,
			sessionBytesReceived: 0,
			bytesReceivedSinceLastMetric: 0,
			rateTruth: new RateTruthTracker(),
			signalLevel: this.createSignalLevelTracker(config),
			pausedSinceLastMetric: false,
			metricTicksSinceConnect: 0,
			lastMetricTime: Date.now(),
			dataRate: 0,
			reconnectAttempts: 0,
			reconnectTimer: null,
			activeHost: null,
			endpoint: null,
			retargetPending: false,
			connectPending: false,
			endpointFailures: new EndpointFailureWindow(),
			metricsTimer: null,
			stallTimer: null,
			stopping: false,
			activeFormat: config.caps.format,
			detectionBuffer: config.caps.format === "auto" ? Buffer.alloc(0) : null,
			conversionRemainder: Buffer.alloc(0),
			iqRemainder: Buffer.alloc(0),
			rtlTcpHeader: null,
			rtlTcpHeaderInfo: null,
			rtlTcpHeaderBuffer:
				config.type === "rtl_tcp" && config.caps.format === "U8_IQ"
					? Buffer.alloc(0)
					: null,
			feed: {
				state:
					config.type !== "recording" && this.pausedIds.has(config.id)
						? "paused"
						: "live",
				since: Date.now(),
			},
		}

		this.sources.set(config.id, state)
		stream.on("drain", () => {
			if (!this.isCurrent(state)) return
			state.evidencePaused = false
			state.expectedSince = Date.now()
			const attempt = state.attempt
			if (attempt && this.isActiveAttempt(state, attempt)) {
				attempt.paused = false
				attempt.expectedSince = state.expectedSince
				attempt.socket.resume()
			}
			if (!this.isCurrent(state)) return
			if (state.recordingState)
				this.scheduleNextChunk(config.id, state, state.recordingState)
		})

		// Start metrics emission interval (Requirement 1.5)
		state.metricsTimer = setInterval(() => {
			this.emitMetrics(config.id, state)
		}, METRICS_INTERVAL_MS)

		// Handle recording sources (Requirement 21)
		if (config.type === "recording") {
			try {
				await this.startRecordingSource(config.id, state)
			} catch (err) {
				// Startup owns its resources and retains a current failed registration.
				// This continuation must never re-fetch or delete a replacement.
				throw err
			}
		} else if (state.feed.state === "paused") {
			// A paused feed registers (status, caps, stream) but never dials the receiver.
			this.logger.info(
				{ sourceId: config.id },
				"Source feed is paused; not connecting (POST /api/sources/:id/resume)",
			)
		} else {
			// Attempt initial connection for network sources
			state.connectPending = true
			try {
				await this.attemptConnection(config.id)
				state.connectPending = false
			} catch (err) {
				state.connectPending = false
				// IMPORTANT: Keep the source registered even if the initial connection fails.
				// This allows the built-in reconnection loop to bring the source back when
				// the remote (e.g. pi-iq) reboots or becomes temporarily unavailable.
				// We only tear down the source for non-connection failures.
				if (!(err instanceof SourceConnectionError) && this.isCurrent(state)) {
					state.stopping = true
					this.sources.delete(config.id)
					this.cleanupState(state)
				}
				throw err
			}
		}

		return stream
	}

	private forwardData(id: string, state: SourceState, chunk: Buffer): boolean {
		const attempt = state.attempt
		const recording = state.recordingState
		const current = () =>
			this.isCurrent(state) &&
			(recording
				? state.recordingState === recording && recording.isPlaying
				: attempt !== null && this.isActiveAttempt(state, attempt))
		if (!current()) return false
		// TCP boundaries are arbitrary. Fanout may shed complete chunks, so each
		// IQ chunk must contain whole complex samples before reaching its branches.
		const frameBytes = iqFrameBytes(state.config.caps)
		if (frameBytes !== null) {
			const { aligned, remainder } = alignIqChunk(
				state.iqRemainder,
				chunk,
				frameBytes,
			)
			state.iqRemainder = remainder
			chunk = aligned
			if (!chunk.length) return true
		}

		if (state.config.type !== "recording") state.signalLevel.feed(chunk)

		const firstPayload = chunk.length > 0 && state.lastSampleAt === null
		if (chunk.length > 0) {
			state.lastSampleAt = Date.now()
			if (attempt) attempt.lastSampleAt = state.lastSampleAt
			const recovery = this.rateRecovery.get(id)
			if (recovery && state.socket !== recovery.socket)
				this.finishRateRecovery(
					id,
					recovery.deadline > Date.now() && !recovery.owner.aborted,
				)
		}
		let canWrite = true
		if (!state.stream.destroyed) {
			canWrite = state.stream.write(chunk)
			if (!current()) return false
			if (!canWrite) {
				state.evidencePaused = true
				if (attempt) attempt.paused = true
				state.pausedSinceLastMetric = true
				state.socket?.pause()
				if (!current()) return false
			}
		}
		this.emit("data", id, chunk)
		if (!current()) return false
		if (firstPayload) this.emit("payload-started", id)
		return canWrite
	}

	private convertAudioChunk(state: SourceState, chunk: Buffer): Buffer {
		const input = state.conversionRemainder.length
			? Buffer.concat([state.conversionRemainder, chunk])
			: chunk
		const alignedLength = input.length - (input.length % 4)
		state.conversionRemainder = Buffer.from(input.subarray(alignedLength))
		return convertFloat32ToS16LE(input.subarray(0, alignedLength))
	}

	/**
	 * Cleans up timers and resources for a source state.
	 */
	private cleanupState(state: SourceState): void {
		if (state.reconnectTimer) {
			clearTimeout(state.reconnectTimer)
			state.reconnectTimer = null
		}
		if (state.metricsTimer) {
			clearInterval(state.metricsTimer)
			state.metricsTimer = null
		}
		this.stopStallWatchdog(state)
		// Clean up recording source resources
		if (state.recordingState) {
			const recording = state.recordingState
			state.recordingState = undefined
			this.cleanupRecordingState(recording)
		}
	}

	/**
	 * Cleans up recording source state.
	 */
	private cleanupRecordingState(recordingState: RecordingState): void {
		if (recordingState.playbackTimer) {
			clearTimeout(recordingState.playbackTimer)
			recordingState.playbackTimer = null
		}
		if (recordingState.fileDescriptor !== null) {
			const fd = recordingState.fileDescriptor
			recordingState.fileDescriptor = null
			recordingState.isPlaying = false
			try {
				fs.closeSync(fd)
			} catch {
				// Ignore close errors
			}
			recordingState.fileDescriptor = null
		}
		recordingState.isPlaying = false
	}

	/**
	 * Starts a recording source for file-based IQ/audio replay.
	 * Requirements: 21.1, 21.2, 21.3, 21.4
	 *
	 * @param id - Source ID
	 */
	private async startRecordingSource(
		id: string,
		state: SourceState,
	): Promise<void> {
		let ownedFd: number | null = null
		let recording: RecordingState | null = null
		const current = () =>
			this.isCurrent(state) &&
			(recording === null || state.recordingState === recording)
		try {
			if (!current()) return
			const { config } = state
			if (!config.filePath)
				throw new WaveKitError(
					`Recording source ${id} requires filePath`,
					"RECORDING_START_FAILED",
				)
			const exists = fs.existsSync(config.filePath)
			if (!current()) return
			if (!exists)
				throw new WaveKitError(
					`Recording file not found: ${config.filePath}`,
					"RECORDING_START_FAILED",
				)
			const stats = fs.statSync(config.filePath)
			if (!current()) return
			if (stats.size === 0)
				throw new WaveKitError(
					`Recording file is empty: ${config.filePath}`,
					"RECORDING_START_FAILED",
				)
			ownedFd = fs.openSync(config.filePath, "r")
			if (!current()) return
			recording = {
				fileDescriptor: ownedFd,
				playbackTimer: null,
				position: 0,
				fileSize: stats.size,
				chunkSize: this.calculateChunkSize(config.caps),
				isPlaying: true,
			}
			ownedFd = null
			state.recordingState = recording
			state.connected = true
			state.recordingEnded = false
			state.lastSampleAt = null
			state.expectedSince = Date.now()
			this.logger.info(
				{
					sourceId: id,
					filePath: config.filePath,
					fileSize: stats.size,
					loop: config.loop,
					playbackSpeed: config.playbackSpeed,
				},
				"Recording source started",
			)
			if (!current()) return
			this.emit("connected", id)
			if (!current()) return
			this.scheduleNextChunk(id, state, recording)
		} catch (err) {
			if (current()) {
				state.connected = false
				state.recordingEnded = false
				state.lastSampleAt = null
				state.evidencePaused = false
				state.lastError =
					err instanceof Error ? err.message : "Recording startup failed"
				if (recording) {
					state.recordingState = undefined
					this.cleanupRecordingState(recording)
				}
				if (ownedFd !== null) {
					const fd = ownedFd
					ownedFd = null
					try {
						fs.closeSync(fd)
					} catch {
						/* Preserve the startup error. */
					}
				}
				try {
					if (this.isCurrent(state))
						this.logger.error(
							{ sourceId: id, err },
							"Recording source startup failed",
						)
					if (this.isCurrent(state) && this.listenerCount("error") > 0)
						this.emit("error", id, err)
				} catch {
					// Notification cannot replace the original startup rejection.
				}
			} else if (recording) this.cleanupRecordingState(recording)
			throw err
		} finally {
			if (ownedFd !== null) {
				const fd = ownedFd
				ownedFd = null
				try {
					fs.closeSync(fd)
				} catch {
					/* Own local descriptor only. */
				}
			}
		}
	}

	/**
	 * Calculates the chunk size for recording playback based on format.
	 * Requirements: 21.3
	 */
	private calculateChunkSize(caps: SourceCaps): number {
		// Calculate bytes per sample based on format
		let bytesPerSample: number
		switch (caps.format) {
			case "S16LE":
			case "S16_IQ":
				bytesPerSample = 2
				break
			case "FLOAT32LE":
				bytesPerSample = 4
				break
			case "U8_IQ":
				bytesPerSample = 1
				break
			default:
				bytesPerSample = 2
		}

		// For IQ formats, we have I and Q components
		const isIQ = caps.format === "U8_IQ" || caps.format === "S16_IQ"
		const componentsPerSample = isIQ ? 2 : (caps.channels ?? 1)

		// Calculate bytes per second at the sample rate
		const bytesPerSecond =
			caps.sampleRate * bytesPerSample * componentsPerSample

		// Target ~50ms chunks for smooth playback
		const targetChunkDurationMs = 50
		const chunkSize = Math.floor(
			(bytesPerSecond * targetChunkDurationMs) / 1000,
		)

		// Ensure chunk size is aligned to sample boundaries
		const sampleSize = bytesPerSample * componentsPerSample
		const alignedChunkSize = Math.floor(chunkSize / sampleSize) * sampleSize

		// Minimum 1024 bytes, maximum 65536 bytes
		return Math.max(1024, Math.min(65536, alignedChunkSize))
	}

	/**
	 * Calculates the interval between chunks based on playback speed.
	 * Requirements: 21.4
	 */
	private calculateChunkInterval(
		chunkSize: number,
		caps: SourceCaps,
		playbackSpeed: number,
	): number {
		// Calculate bytes per sample based on format
		let bytesPerSample: number
		switch (caps.format) {
			case "S16LE":
			case "S16_IQ":
				bytesPerSample = 2
				break
			case "FLOAT32LE":
				bytesPerSample = 4
				break
			case "U8_IQ":
				bytesPerSample = 1
				break
			default:
				bytesPerSample = 2
		}

		// For IQ formats, we have I and Q components
		const isIQ = caps.format === "U8_IQ" || caps.format === "S16_IQ"
		const componentsPerSample = isIQ ? 2 : (caps.channels ?? 1)

		// Calculate bytes per second at the sample rate
		const bytesPerSecond =
			caps.sampleRate * bytesPerSample * componentsPerSample

		// Calculate how long this chunk represents in real time
		const chunkDurationMs = (chunkSize / bytesPerSecond) * 1000

		// Adjust for playback speed
		const adjustedInterval = chunkDurationMs / playbackSpeed

		// Minimum 1ms interval
		return Math.max(1, adjustedInterval)
	}

	/**
	 * Schedules the next chunk to be read and emitted.
	 */
	private scheduleNextChunk(
		id: string,
		captured?: SourceState,
		resource?: RecordingState,
	): void {
		const state = captured ?? this.sources.get(id)
		if (
			!state ||
			!this.isCurrent(state) ||
			!state.recordingState ||
			(resource !== undefined && state.recordingState !== resource)
		) {
			return
		}

		const { config } = state
		const recordingState = state.recordingState

		if (!recordingState.isPlaying || recordingState.fileDescriptor === null) {
			return
		}

		const interval = this.calculateChunkInterval(
			recordingState.chunkSize,
			config.caps,
			config.playbackSpeed ?? 1.0,
		)

		if (recordingState.playbackTimer !== null) return
		const timer = setTimeout(() => {
			if (
				!this.isCurrent(state) ||
				state.recordingState !== recordingState ||
				recordingState.playbackTimer !== timer
			)
				return
			recordingState.playbackTimer = null
			this.readAndEmitChunk(id, state, recordingState)
		}, interval)
		recordingState.playbackTimer = timer
	}

	/**
	 * Reads a chunk from the recording file and emits it.
	 */
	private readAndEmitChunk(
		id: string,
		captured?: SourceState,
		resource?: RecordingState,
	): void {
		const state = captured ?? this.sources.get(id)
		if (
			!state ||
			!this.isCurrent(state) ||
			!state.recordingState ||
			(resource !== undefined && state.recordingState !== resource)
		) {
			return
		}

		const recordingState = state.recordingState

		if (!recordingState.isPlaying || recordingState.fileDescriptor === null) {
			return
		}

		// Calculate how many bytes to read
		const remainingBytes = recordingState.fileSize - recordingState.position
		const bytesToRead = Math.min(recordingState.chunkSize, remainingBytes)

		if (bytesToRead <= 0) {
			// End of file reached
			this.handleRecordingEnd(id, true, state, recordingState)
			return
		}

		// Read chunk from file
		const buffer = Buffer.alloc(bytesToRead)
		try {
			const bytesRead = fs.readSync(
				recordingState.fileDescriptor,
				buffer,
				0,
				bytesToRead,
				recordingState.position,
			)

			if (!this.isCurrent(state) || state.recordingState !== recordingState)
				return

			if (bytesRead === 0) {
				// End of file
				this.handleRecordingEnd(id, true, state, recordingState)
				return
			}

			// Update position
			recordingState.position += bytesRead

			// Update stats
			state.bytesReceived += bytesRead
			state.bytesReceivedSinceLastMetric += bytesRead

			// Stop reading until downstream drains instead of buffering the entire file.
			const canWrite = this.forwardData(
				id,
				state,
				buffer.subarray(0, bytesRead),
			)
			if (!this.isCurrent(state) || state.recordingState !== recordingState)
				return
			if (
				recordingState.position >= recordingState.fileSize &&
				!state.config.loop
			) {
				this.handleRecordingEnd(id, true, state, recordingState)
			} else if (canWrite) {
				this.scheduleNextChunk(id, state, recordingState)
			}
		} catch (err) {
			if (!this.isCurrent(state) || state.recordingState !== recordingState)
				return
			state.lastError =
				err instanceof Error ? err.message : "Unknown read error"
			this.handleRecordingEnd(id, false, state, recordingState, err)
		}
	}

	/**
	 * Handles the end of a recording file.
	 * Requirements: 21.2
	 */
	private handleRecordingEnd(
		id: string,
		allowLoop = true,
		captured?: SourceState,
		resource?: RecordingState,
		readError?: unknown,
	): void {
		const state = captured ?? this.sources.get(id)
		if (
			!state ||
			!this.isCurrent(state) ||
			!state.recordingState ||
			(resource !== undefined && state.recordingState !== resource)
		)
			return
		const recording = state.recordingState
		if (state.config.loop && allowLoop) {
			recording.position = 0
			state.iqRemainder = Buffer.alloc(0)
			state.lastSampleAt = null
			state.expectedSince = Date.now()
			state.evidencePaused = false
			this.logger.debug({ sourceId: id }, "Recording source looping")
			if (this.isCurrent(state) && state.recordingState === recording)
				this.scheduleNextChunk(id, state, recording)
		} else {
			state.connected = false
			state.recordingEnded = true
			state.lastSampleAt = null
			state.evidencePaused = false
			state.dataRate = 0
			this.cleanupState(state)
			if (!this.isCurrent(state)) return
			state.stream.end()
			if (!this.isCurrent(state)) return
			if (readError !== undefined)
				this.logger.error(
					{ sourceId: id, err: readError },
					"Error reading recording file",
				)
			if (!this.isCurrent(state)) return
			this.logger.info({ sourceId: id }, "Recording source ended")
			if (this.isCurrent(state)) this.emit("ended", id)
		}
	}

	/**
	 * Attempts to establish a TCP connection to the source.
	 * On failure, schedules a reconnection with exponential backoff.
	 */
	private attemptConnection(id: string): Promise<void> {
		const state = this.sources.get(id)
		if (!state || !this.isCurrent(state) || state.config.type === "recording")
			return Promise.resolve()
		if (state.attempt && this.isActiveAttempt(state, state.attempt))
			return Promise.resolve()
		const { config } = state
		const host = state.activeHost ?? config.host!
		return new Promise<void>((resolve, reject) => {
			const socket = new net.Socket()
			if (!this.isCurrent(state)) {
				socket.destroy()
				resolve()
				return
			}
			const attempt: SourceAttempt = {
				socket,
				phase: "connecting",
				sessionId: this.allocateEvidenceToken(),
				lastSampleAt: null,
				expectedSince: Date.now(),
				paused: false,
				header: null,
				headerBuffer:
					config.type === "rtl_tcp" && config.caps.format === "U8_IQ"
						? Buffer.alloc(0)
						: null,
				headerAt: null,
				watchdog: null,
			}
			state.attempt = attempt
			state.socket = socket
			state.connected = false
			state.lastSampleAt = null
			state.evidencePaused = false
			state.sessionBytesReceived = 0
			state.conversionRemainder = Buffer.alloc(0)
			state.iqRemainder = Buffer.alloc(0)
			state.rtlTcpHeader = null
			state.rtlTcpHeaderInfo = null
			state.rtlTcpHeaderBuffer =
				config.type === "rtl_tcp" && config.caps.format === "U8_IQ"
					? Buffer.alloc(0)
					: null
			const isInitialAttempt = state.reconnectAttempts === 0
			let settled = false
			const safeResolve = () => {
				if (!settled) {
					settled = true
					resolve()
				}
			}
			const safeReject = (err: Error) => {
				if (!settled) {
					settled = true
					reject(err)
				}
			}
			const stopOwnWatchdog = () => {
				const timer = attempt.watchdog
				attempt.watchdog = null
				if (timer !== null) clearInterval(timer)
				if (timer !== null && state.stallTimer === timer)
					state.stallTimer = null
			}
			const cleanup = () => {
				stopOwnWatchdog()
				socket.removeAllListeners()
				// A retired socket can still report a transport error during destruction.
				socket.on("error", () => {})
			}
			const onConnect = () => {
				if (
					!this.isActiveAttempt(state, attempt) ||
					attempt.phase !== "connecting"
				) {
					safeResolve()
					return
				}
				try {
					socket.setTimeout(0)
					if (!this.isActiveAttempt(state, attempt)) return
					socket.setKeepAlive(true, SOURCE_KEEPALIVE_DELAY_MS)
					if (!this.isActiveAttempt(state, attempt)) return
					attempt.phase = "connected"
					state.connected = true
					state.lastSampleAt = null
					state.expectedSince = Date.now()
					attempt.expectedSince = state.expectedSince
					state.dataRate = 0
					state.bytesReceivedSinceLastMetric = 0
					state.lastMetricTime = Date.now()
					state.metricTicksSinceConnect = 0
					state.pausedSinceLastMetric = false
					state.reconnectAttempts = 0
					state.lastError = undefined
					// A resume's connection: the feed is live before "connected" fires.
					if (state.feed.state === "resuming") {
						state.feed = { state: "live", since: Date.now() }
						attempt.resumed = true
					}
					// Connected settlement precedes reentrant lifecycle notifications.
					safeResolve()
					this.resetRateTruth(id, state)
					if (!this.isActiveAttempt(state, attempt)) return
					this.resetSignalLevel(id, state)
					if (!this.isActiveAttempt(state, attempt)) return
					this.logger.info(
						{ sourceId: id, host, port: config.port },
						"Connected to source",
					)
					if (!this.isActiveAttempt(state, attempt)) return
					this.startStallWatchdog(state, socket, onError)
					if (!this.isActiveAttempt(state, attempt)) return
					this.emit("connected", id)
				} finally {
					safeResolve()
				}
			}
			const onData = (chunk: Buffer) => {
				if (
					!this.isActiveAttempt(state, attempt) ||
					attempt.phase !== "connected"
				)
					return
				if (state.sessionBytesReceived === 0) {
					this.logger.info(
						{ sourceId: id, firstChunkSize: chunk.length },
						"First data chunk received from source",
					)
					if (!this.isActiveAttempt(state, attempt)) return
				}
				state.bytesReceived += chunk.length
				state.sessionBytesReceived += chunk.length
				state.bytesReceivedSinceLastMetric += chunk.length

				// Handle Auto-Detection
				if (state.activeFormat === "auto" || state.activeFormat === "UNKNOWN") {
					// Append to detection buffer
					state.detectionBuffer = Buffer.concat([
						state.detectionBuffer || Buffer.alloc(0),
						chunk,
					])

					// If we have enough data (e.g. 10ms of 48kHz float = ~2KB, let's wait for 4KB) or it's been a few packets
					if (
						state.detectionBuffer.length >= 4096 ||
						state.bytesReceived > 8192
					) {
						const detected = detectAudioFormat(
							state.detectionBuffer,
							this.logger,
						)
						if (!this.isActiveAttempt(state, attempt)) return

						if (detected !== "UNKNOWN") {
							this.logger.info(
								{ sourceId: id, detected },
								`Auto-detected source format`,
							)
							if (!this.isActiveAttempt(state, attempt)) return
							state.activeFormat = detected

							// Flush the buffer based on detected format
							let dataToProcess = state.detectionBuffer

							// If float, convert to S16LE
							if (
								state.activeFormat === "FLOAT32LE" &&
								config.caps.kind === "audio_pcm"
							) {
								dataToProcess = this.convertAudioChunk(state, dataToProcess)
							}

							this.forwardData(id, state, dataToProcess)
							if (!this.isActiveAttempt(state, attempt)) return

							state.detectionBuffer = null
						} else {
							// Still unknown, maybe silence? Keep buffering up to a limit
							if (state.detectionBuffer.length > 1024 * 1024) {
								// 1MB limit
								this.logger.warn(
									{ sourceId: id },
									"Could not detect format after 1MB, defaulting to S16LE",
								)
								if (!this.isActiveAttempt(state, attempt)) return
								state.activeFormat = "S16LE"
								// Flush as S16LE
								this.forwardData(id, state, state.detectionBuffer)
								if (!this.isActiveAttempt(state, attempt)) return
								state.detectionBuffer = null
							}
						}
					}
					return
				}

				let dataToProcess = chunk

				// Strip RTL-TCP header (12 bytes) for U8_IQ format
				// This is required because decoders expecting raw IQ (like dumpvdl2 --iq-file)
				// generally don't expect the protocol header.
				if (config.type === "rtl_tcp" && config.caps.format === "U8_IQ") {
					const totalReceived = state.sessionBytesReceived
					const previousReceived = totalReceived - chunk.length

					if (previousReceived < RTL_TCP_HEADER_SIZE) {
						// We are processing part of the header
						const headerRemaining = RTL_TCP_HEADER_SIZE - previousReceived
						const headerSlice = chunk.subarray(
							0,
							Math.min(headerRemaining, chunk.length),
						)

						if (headerSlice.length > 0 && state.rtlTcpHeaderBuffer) {
							state.rtlTcpHeaderBuffer = Buffer.concat([
								state.rtlTcpHeaderBuffer,
								headerSlice,
							])

							attempt.headerBuffer = state.rtlTcpHeaderBuffer
							if (state.rtlTcpHeaderBuffer.length >= RTL_TCP_HEADER_SIZE) {
								const header = state.rtlTcpHeaderBuffer.subarray(
									0,
									RTL_TCP_HEADER_SIZE,
								)
								state.rtlTcpHeader = Buffer.from(header)
								attempt.header = Buffer.from(header)
								attempt.headerBuffer = null
								attempt.headerAt = Date.now()
								state.rtlTcpHeaderInfo = parseRtlTcpHeader(header)
								state.rtlTcpHeaderBuffer = null
								this.logger.debug(
									{ sourceId: id, header: state.rtlTcpHeaderInfo },
									"Captured RTL-TCP header from source",
								)
								if (!this.isActiveAttempt(state, attempt)) return
							}
						}

						if (chunk.length <= headerRemaining) {
							// Entire chunk is header, skip it
							return
						}

						// Slice off the header part
						this.logger.debug(
							{ sourceId: id },
							"Stripping RTL-TCP header from stream",
						)
						if (!this.isActiveAttempt(state, attempt)) return
						dataToProcess = chunk.subarray(headerRemaining)
					}
				}

				// Apply conversion if needed
				if (
					state.activeFormat === "FLOAT32LE" &&
					config.caps.kind === "audio_pcm"
				) {
					// We assume config.caps.format was either FLOAT32LE set explicitly, or auto-resolved to it.
					// Note: if config says auto, state.activeFormat is now FLOAT32LE.
					dataToProcess = this.convertAudioChunk(state, dataToProcess)
				}

				this.forwardData(id, state, dataToProcess)
				if (!this.isActiveAttempt(state, attempt)) return
			}
			const onError = (err: Error) => {
				const current = this.isActiveAttempt(state, attempt)
				const hadConnected = attempt.phase === "connected"
				if (current) {
					attempt.phase = "failed"
					attempt.sessionId = null
					attempt.lastSampleAt = null
					attempt.paused = false
					attempt.header = null
					attempt.headerBuffer = null
					attempt.headerAt = null
					state.lastSampleAt = null
					state.evidencePaused = false
					stopOwnWatchdog()
				}
				try {
					if (current) this.handleConnectionError(id, err, state, attempt)
				} finally {
					if (isInitialAttempt && !hadConnected)
						safeReject(new SourceConnectionError(host, config.port!, err))
					else safeResolve()
					try {
						socket.destroy()
					} catch {
						/* Only this attempt's socket. */
					}
				}
			}
			const onClose = () => {
				const owns =
					this.isCurrent(state) &&
					state.attempt === attempt &&
					state.socket === socket
				const wasConnected = state.connected
				if (owns) this.noteEndpointClose(id, state)
				if (owns) {
					attempt.phase = "closed"
					attempt.sessionId = null
					attempt.lastSampleAt = null
					attempt.paused = false
					attempt.header = null
					attempt.headerBuffer = null
					attempt.headerAt = null
					state.connected = false
					state.lastSampleAt = null
					state.evidencePaused = false
					state.dataRate = 0
					state.bytesReceivedSinceLastMetric = 0
					state.socket = null
				}
				cleanup()
				const closedCurrent = () =>
					this.isCurrent(state) &&
					state.attempt === attempt &&
					attempt.phase === "closed" &&
					state.socket === null
				try {
					if (owns && wasConnected && closedCurrent()) {
						this.logger.info({ sourceId: id }, "Disconnected from source")
						if (closedCurrent())
							this.emit(
								"disconnected",
								id,
								state.lastError
									? new WaveKitError(state.lastError, "SOURCE_DISCONNECTED")
									: undefined,
							)
					}
					const recovery = this.rateRecovery.get(id)
					if (owns && recovery && recovery.socket !== socket)
						this.finishRateRecovery(id, false)
					if (closedCurrent()) this.scheduleReconnect(id, state, attempt)
				} finally {
					if (!wasConnected && isInitialAttempt)
						safeReject(
							new SourceConnectionError(
								host,
								config.port!,
								new WaveKitError(
									state.lastError ??
										"Socket closed before establishing a connection",
									"SOURCE_DISCONNECTED",
								),
							),
						)
					else safeResolve()
				}
			}
			socket.on("connect", onConnect)
			socket.on("data", onData)
			socket.on("error", onError)
			socket.on("close", onClose)
			socket.on("timeout", () => {
				if (
					!this.isActiveAttempt(state, attempt) ||
					attempt.phase !== "connecting"
				)
					return
				onError(
					Object.assign(
						new WaveKitError(
							`Source connection timed out after ${SOURCE_CONNECT_TIMEOUT_MS}ms`,
							"SOURCE_CONNECT_TIMEOUT",
						),
						{ code: "ETIMEDOUT" },
					),
				)
			})
			socket.setTimeout(SOURCE_CONNECT_TIMEOUT_MS)
			if (this.isActiveAttempt(state, attempt))
				socket.connect(config.port!, host)
			else safeResolve()
		})
	}

	/**
	 * Stall watchdog for continuous-stream sessions: rtl_tcp IQ sources stream
	 * without pause while healthy, so once a session has delivered payload, a
	 * gap longer than `stallTimeoutMs` (default 15 s, 0 = off) means a dead or
	 * half-open peer (e.g. a rebooted host that never sent FIN). The socket is
	 * then failed into the normal reconnect/backoff path.
	 *
	 * Covered: rtl_tcp sources with U8_IQ caps, the only format whose 12-byte
	 * protocol header is stripped, so header bytes can never arm the watchdog.
	 * Not covered: recordings, SDR++ network and audio sources (may idle), other
	 * rtl_tcp formats, a session that has not delivered payload yet (kept
	 * connected and reported stale, as e64e16b intends), and time spent paused
	 * by local backpressure.
	 */
	private startStallWatchdog(
		state: SourceState,
		socket: net.Socket,
		fail: (err: Error) => void,
	): void {
		const attempt = state.attempt
		if (
			!attempt ||
			!this.isActiveAttempt(state, attempt) ||
			attempt.socket !== socket
		)
			return
		this.stopStallWatchdog(state)
		const { config } = state
		if (
			config.type !== "rtl_tcp" ||
			config.caps.kind !== "iq" ||
			config.caps.format !== "U8_IQ"
		)
			return
		let timeoutMs = config.stallTimeoutMs ?? SOURCE_STALL_TIMEOUT_MS
		if (!Number.isFinite(timeoutMs)) {
			this.logger.warn(
				{ sourceId: config.id, stallTimeoutMs: config.stallTimeoutMs },
				"Invalid stallTimeoutMs; using the default stall watchdog timeout",
			)
			if (!this.isActiveAttempt(state, attempt)) return
			timeoutMs = SOURCE_STALL_TIMEOUT_MS
		}
		if (timeoutMs <= 0) return

		const checkEveryMs = Math.max(50, Math.min(1000, Math.floor(timeoutMs / 4)))
		const timer = setInterval(() => {
			if (
				!this.isActiveAttempt(state, attempt) ||
				attempt.phase !== "connected" ||
				attempt.watchdog !== timer
			) {
				clearInterval(timer)
				return
			}
			// Not armed until this session delivered payload; paused is local.
			if (state.lastSampleAt === null) return
			if (state.stream.writableNeedDrain || socket.isPaused()) return
			if (!this.isActiveAttempt(state, attempt) || attempt.watchdog !== timer) {
				clearInterval(timer)
				return
			}
			const idleMs =
				Date.now() - Math.max(state.lastSampleAt, state.expectedSince)
			if (idleMs < timeoutMs) return

			this.stopStallWatchdog(state)
			fail(
				new WaveKitError(
					`No data from source for ${idleMs}ms (stall watchdog ${timeoutMs}ms); reconnecting`,
					"SOURCE_STALLED",
				),
			)
		}, checkEveryMs)
		attempt.watchdog = timer
		state.stallTimer = timer
	}

	private stopStallWatchdog(state: SourceState): void {
		if (!state.stallTimer) return
		const timer = state.stallTimer
		state.stallTimer = null
		if (state.attempt?.watchdog === timer) state.attempt.watchdog = null
		clearInterval(timer)
	}

	/**
	 * Handles connection errors gracefully (Requirement 1.6).
	 * Logs the error and prepares for reconnection.
	 */
	private handleConnectionError(
		id: string,
		err: Error,
		state: SourceState,
		attempt: SourceAttempt,
	): void {
		const current = () =>
			this.isCurrent(state) &&
			state.attempt === attempt &&
			state.socket === attempt.socket &&
			attempt.phase === "failed"
		if (!current()) return

		const errorCode = (err as NodeJS.ErrnoException).code

		// Handle known connection errors gracefully (Requirement 1.6)
		const isKnownError =
			errorCode === "ECONNREFUSED" ||
			errorCode === "ETIMEDOUT" ||
			errorCode === "ECONNRESET" ||
			errorCode === "SOURCE_STALLED"

		state.lastError = err.message

		if (isKnownError) {
			this.logger.warn(
				{ sourceId: id, errorCode, message: err.message },
				"Connection error (will retry)",
			)
		} else {
			this.logger.error({ sourceId: id, err }, "Unexpected connection error")
		}

		// Only emit error event if there are listeners (Requirement 1.6)
		if (current() && this.listenerCount("error") > 0) {
			this.emit("error", id, err)
		}
	}

	/**
	 * Schedules a reconnection attempt with exponential backoff (Requirement 1.2).
	 */
	private scheduleReconnect(
		id: string,
		state: SourceState,
		attempt: SourceAttempt,
	): void {
		const current = () =>
			this.isCurrent(state) &&
			state.attempt === attempt &&
			attempt.phase === "closed" &&
			state.socket === null
		if (!current()) return
		if (state.reconnectTimer) return
		// A paused feed, or a resume's single attempt, never retries on its own.
		if (state.feed.state !== "live") return

		let delay: number
		if (state.retargetPending) {
			// A deliberate endpoint switch is not a failure: no backoff step.
			state.retargetPending = false
			delay = SOURCE_RETARGET_RECONNECT_MS
		} else {
			state.reconnectAttempts++
			const baseDelay = calculateBackoffDelay(state.reconnectAttempts)
			// Add small jitter to avoid thundering herd when multiple sources restart.
			// Equal-jitter: base/2 + rand*(base/2)
			delay = Math.round(baseDelay / 2 + Math.random() * (baseDelay / 2))
		}

		this.logger.info(
			{
				sourceId: id,
				attempt: state.reconnectAttempts,
				delayMs: delay,
			},
			"Scheduling reconnection",
		)

		if (!current()) return
		const timer = setTimeout(() => {
			if (!current() || state.reconnectTimer !== timer) return
			state.reconnectTimer = null
			if (state.feed.state !== "live") return
			this.attemptConnection(id).catch(() => {
				// Error already handled in attemptConnection
			})
		}, delay)
		state.reconnectTimer = timer
	}

	/**
	 * Emits metrics for a source (Requirement 1.5).
	 * Calculates data rate based on bytes received since last metric.
	 */
	private emitMetrics(
		id: string,
		state: SourceState | undefined = this.sources.get(id),
	): void {
		if (!state || !this.isCurrent(state)) return
		const attempt = state.attempt
		const current = () => this.isCurrent(state) && state.attempt === attempt

		const now = Date.now()
		const elapsed = (now - state.lastMetricTime) / 1000 // seconds

		// Calculate data rate in KB/s
		if (elapsed > 0) {
			state.dataRate = state.bytesReceivedSinceLastMetric / 1024 / elapsed
		}

		this.checkRateTruth(
			id,
			state,
			state.bytesReceivedSinceLastMetric,
			now - state.lastMetricTime,
			now,
		)
		if (!current()) return
		this.checkSignalLevel(id, state, now - state.lastMetricTime, now)
		if (!current()) return
		state.bytesReceivedSinceLastMetric = 0
		state.lastMetricTime = now

		this.emit("metrics", id, {
			bytesReceived: state.bytesReceived,
			dataRate: state.dataRate,
		})
	}

	/**
	 * Feeds one metrics interval to the rate-truth check. Network sources
	 * only (recordings are paced by playback speed). Intervals that cannot be
	 * trusted (first after connect, backpressure pause) are skipped.
	 */
	private checkRateTruth(
		id: string,
		state: SourceState,
		bytes: number,
		elapsedMs: number,
		now: number,
	): void {
		if (!this.isCurrent(state) || state.config.type === "recording") return
		const attempt = state.attempt
		const current = () => this.isCurrent(state) && state.attempt === attempt
		if (!state.connected) {
			this.resetRateTruth(id, state)
			return
		}
		const caps = state.config.caps
		const bytesPerSample = bytesPerSampleFor(caps)
		const paused = state.socket?.isPaused()
		if (!current()) return
		const stable =
			state.metricTicksSinceConnect > 0 &&
			!state.pausedSinceLastMetric &&
			!paused
		state.metricTicksSinceConnect++
		state.pausedSinceLastMetric = false
		if (bytesPerSample === undefined) return

		const transition = state.rateTruth.observe({
			atMs: now,
			elapsedMs,
			bytes,
			declaredSampleRateHz: caps.sampleRate,
			bytesPerSample,
			stable,
		})
		if (transition === "flagged") {
			this.logger.warn(
				{ sourceId: id, ...state.rateTruth.mismatch },
				"Source delivers a different sample rate than its caps declare; caps left unchanged (check external tuner clients)",
			)
		} else if (transition === "cleared") {
			this.logger.info(
				{ sourceId: id, declaredSampleRateHz: caps.sampleRate },
				"Source rate matches its caps again",
			)
		}
		if (transition && current()) this.emit("rate-truth-changed", id)
	}

	private resetRateTruth(id: string, state: SourceState): void {
		if (this.isCurrent(state) && state.rateTruth.reset())
			this.emit("rate-truth-changed", id)
	}

	private createSignalLevelTracker(config: SourceConfig): SignalLevelTracker {
		const tracker = new SignalLevelTracker({
			thresholdDbfs: this.options.signalFlatThresholdDbfs,
			holdMs: this.options.signalFlatHoldMs,
		})
		// Recordings are not live gain settings; like rate truth, not checked.
		if (config.type !== "recording")
			tracker.setFormat(iqComponentFormatFor(config.caps))
		return tracker
	}

	/**
	 * Closes one metrics interval of the signal-flat check. IQ network sources
	 * only (formats it cannot interpret are never measured); an interval
	 * without data (waiting/stale) never raises the flag.
	 */
	private checkSignalLevel(
		id: string,
		state: SourceState,
		elapsedMs: number,
		now: number,
	): void {
		if (!this.isCurrent(state) || state.config.type === "recording") return
		const attempt = state.attempt
		const current = () => this.isCurrent(state) && state.attempt === attempt
		if (!state.connected) {
			this.resetSignalLevel(id, state)
			return
		}
		const transition = state.signalLevel.observe({ atMs: now, elapsedMs })
		if (transition === "flagged") {
			this.logger.warn(
				{ sourceId: id, ...state.signalLevel.flat },
				"Source IQ level is flat (near-zero gain?); decoders will hear nothing (check external tuner clients)",
			)
		} else if (transition === "cleared") {
			this.logger.info(
				{ sourceId: id, levelDbfs: state.signalLevel.levelDbfs },
				"Source IQ level recovered",
			)
		}
		if (transition && current()) this.emit("signal-flat-changed", id)
	}

	private resetSignalLevel(id: string, state: SourceState): void {
		if (this.isCurrent(state) && state.signalLevel.reset())
			this.emit("signal-flat-changed", id)
	}

	/** A rate, format or kind change restarts the signal-flat check. */
	private onCapsChangedForSignalLevel(
		id: string,
		state: SourceState,
		oldCaps: SourceCaps,
	): void {
		const caps = state.config.caps
		if (
			oldCaps.sampleRate === caps.sampleRate &&
			oldCaps.format === caps.format &&
			oldCaps.kind === caps.kind
		)
			return
		const format =
			state.config.type === "recording" ? undefined : iqComponentFormatFor(caps)
		const cleared = state.signalLevel.setFormat(format)
		if (cleared || state.signalLevel.reset())
			this.emit("signal-flat-changed", id)
	}

	/**
	 * Disconnects from a source, cleans up resources and removes it. Emits
	 * "removed" (internal teardown signal, also fired by reconnect) and then
	 * "source-removed" (the source is gone for good) with the removal time.
	 *
	 * @param id - Source ID to disconnect
	 */
	async disconnect(id: string): Promise<void> {
		// A permanent removal is announced by "source-removed" alone: clear the
		// connected flag first so the socket's late close event cannot emit a
		// "disconnected" for an id clients have already dropped.
		const state = this.sources.get(id)
		if (state) state.connected = false
		this.finishRateRecovery(id, false)
		for (const controller of this.tunerCommandControllers.get(id) ?? [])
			controller.abort(
				new WaveKitError("Source was removed", "SOURCE_NOT_FOUND"),
			)
		this.tunerCommandControllers.delete(id)
		this.tunerCommands.delete(id)
		if (!this.teardown(id)) return
		// Gone for good: a source added again with this id starts live.
		if (this.pausedIds.delete(id)) void this.persistFeeds()
		this.emit("source-removed", id, new Date())
	}

	/**
	 * Tears a source down and emits "removed". Returns false when the source
	 * is unknown. Shared by disconnect (permanent), reconnect and shutdown.
	 */
	private teardown(id: string): boolean {
		const state = this.sources.get(id)
		if (!state) return false
		this.finishRateRecovery(id, false)

		state.stopping = true
		if (state.attempt) {
			state.attempt.phase = "closed"
			state.attempt.sessionId = null
			state.attempt.headerAt = null
		}
		state.lastSampleAt = null
		this.sources.delete(id)
		// Decoder assignments belong to the removed registration.
		for (const [decoderId, assignment] of this.decoderAssignments) {
			if (assignment.sourceId === id) this.decoderAssignments.delete(decoderId)
		}

		// Clear timers and recording state
		this.cleanupState(state)

		// Close socket for network sources
		if (state.socket) {
			state.socket.destroy()
			state.socket = null
		}

		// End the stream
		if (!state.stream.destroyed) {
			state.stream.end()
			state.stream.destroy()
		}

		if (this.sources.has(id)) return false
		this.logger.info({ sourceId: id }, "Source disconnected and cleaned up")
		if (this.sources.has(id)) return false
		this.emit("removed", id)
		return !this.sources.has(id)
	}

	/**
	 * Reconnects to a source by disconnecting and reconnecting.
	 *
	 * @param id - Source ID to reconnect
	 */
	async reconnect(id: string): Promise<void> {
		const state = this.sources.get(id)
		if (!state) {
			throw new Error(`Source ${id} not found`)
		}

		const config = state.config

		// Tear down first (not a removal: the same id comes straight back)
		this.teardown(id)

		// A reentrant teardown consumer may already have recreated the source.
		if (this.sources.has(id)) return
		await this.connect(config)
	}

	/**
	 * Counts a closed session or failed attempt on a selected endpoint and, once
	 * EndpointFailureWindow fires, sends the source back to its configured host
	 * before the reconnect is scheduled (receiver-endpoints 3.4). Independent of
	 * the receiver's API, so a dead endpoint is left even when no poll report
	 * arrives. A deliberate switch never counts.
	 */
	private noteEndpointClose(id: string, state: SourceState): void {
		// A deliberate switch or a paused feed's close is no endpoint failure.
		if (
			state.activeHost === null ||
			state.retargetPending ||
			state.feed.state !== "live"
		)
			return
		if (!state.endpointFailures.record(Date.now())) return
		const left = state.activeHost
		const configured = state.config.host
		if (!configured) return
		state.activeHost = null
		state.endpointFailures.reset()
		state.endpoint = {
			configuredHost: configured,
			activeHost: configured,
			reason: "fallback: selected endpoint failed",
			at: new Date().toISOString(),
		}
		this.logger.warn(
			{ sourceId: id, from: left, to: configured },
			"Source endpoint failed; back to the configured host",
		)
		this.emit("endpoint-fallback", id, left)
	}

	/** A copy of a source's config (endpoint selection checks it is unchanged). */
	getConfig(id: string): SourceConfig | undefined {
		const state = this.sources.get(id)
		return state ? structuredClone(state.config) : undefined
	}

	/**
	 * Starts reporting endpoint selection for a network source (receiver-endpoints
	 * 3.5). Idempotent; returns false for unknown or recording sources.
	 */
	trackEndpoint(id: string): boolean {
		const state = this.sources.get(id)
		if (!state || state.config.type === "recording" || !state.config.host)
			return false
		state.endpoint ??= {
			configuredHost: state.config.host,
			activeHost: state.activeHost ?? state.config.host,
			reason: "configured",
			at: null,
		}
		return true
	}

	/** The host the current or next connection attempt of a network source uses. */
	getActiveHost(id: string): string | undefined {
		const state = this.sources.get(id)
		if (!state || state.config.type === "recording") return undefined
		return state.activeHost ?? state.config.host
	}

	/**
	 * Moves a network source to another host of the same receiver (receiver-endpoints
	 * 3.3). The registration, its stream and its decoder assignments stay; only the
	 * transport changes. A connected or connecting session is closed and the normal
	 * reconnect path dials the new host after a short delay, with tuning restored as
	 * on any reconnect. A pending backoff simply dials the new host when it fires.
	 * The caller verifies the host; the config is never rewritten.
	 */
	retarget(id: string, host: string, reason: string): boolean {
		const state = this.sources.get(id)
		if (!state || state.config.type === "recording" || !state.config.host)
			return false
		const current = state.activeHost ?? state.config.host
		if (host === current) return true
		state.activeHost = host === state.config.host ? null : host
		state.endpointFailures.reset()
		state.endpoint = {
			configuredHost: state.config.host,
			activeHost: host,
			reason,
			at: new Date().toISOString(),
		}
		this.logger.info(
			{ sourceId: id, from: current, to: host, reason },
			"Source endpoint switched",
		)
		const attempt = state.attempt
		// connect()'s first attempt settles connect(); it switches on its next attempt.
		if (
			attempt &&
			this.isActiveAttempt(state, attempt) &&
			(attempt.phase === "connected" ||
				(attempt.phase === "connecting" && !state.connectPending))
		) {
			state.retargetPending = true
			attempt.socket.destroy()
		}
		return true
	}

	// === Feed pause / resume ===

	/** Reads the persisted pauses once; a failed read leaves every feed live. */
	private loadFeeds(): Promise<void> {
		const persistence = this.feedPersistence
		if (persistence === null) return Promise.resolve()
		this.feedLoad ??= persistence.load().then(
			paused => {
				for (const id of paused) this.pausedIds.add(id)
				this.feedsLoaded = true
				if (paused.size > 0)
					this.logger.info(
						{ paused: paused.size },
						"Paused source feeds restored; they stay paused until resumed",
					)
			},
			() => {
				// SourceFeedStore never rejects; another persistence reads as none paused.
				this.feedsLoaded = true
			},
		)
		return this.feedLoad
	}

	/**
	 * Writes the paused ids; never rejects. A failed write is logged (the store logs the cause)
	 * and leaves `feedsUnsaved`, so the next pause or resume of any source retries it. The
	 * store serialises writes in call order, so the latest generation settles last.
	 */
	private async persistFeeds(): Promise<boolean> {
		if (this.feedPersistence === null) return true
		await this.loadFeeds()
		const generation = ++this.feedSaveGeneration
		this.feedsUnsaved = true
		const saved = await this.feedPersistence
			.save(new Set(this.pausedIds))
			.catch(() => false)
		if (generation === this.feedSaveGeneration) this.feedsUnsaved = !saved
		if (!saved)
			this.logger.warn(
				"Saving the paused source feeds failed; the change holds until the core restarts (pause or resume again to retry the write)",
			)
		return saved
	}

	private feedOf(state: SourceState): SourceFeed {
		return {
			state: state.feed.state,
			since: new Date(state.feed.since).toISOString(),
			...(state.feed.state === "error"
				? { error: SOURCE_RESUME_FAILED_MESSAGE }
				: {}),
		}
	}

	/** The source's feed; undefined for unknown ids and recordings. */
	getFeed(id: string): SourceFeed | undefined {
		const state = this.sources.get(id)
		if (!state || state.config.type === "recording") return undefined
		return this.feedOf(state)
	}

	/**
	 * True while the source's current connection was opened by resume() of a paused feed (until
	 * it closes). Tuning is restored on it whatever `tuner.reconnectPolicy` says: a pause is the
	 * operator's, not a dropout that may have reset the receiver on purpose.
	 */
	isResumedSession(id: string): boolean {
		const state = this.sources.get(id)
		const attempt = state?.attempt
		return (
			state !== undefined &&
			attempt !== null &&
			attempt !== undefined &&
			attempt.resumed === true &&
			this.isActiveAttempt(state, attempt)
		)
	}

	/**
	 * True while the operator holds the source's feed back: paused, resuming, or after a
	 * failed resume. Consumers suspend with reason "source-paused" meanwhile.
	 */
	isPaused(id: string): boolean {
		const state = this.sources.get(id)
		return state !== undefined && state.feed.state !== "live"
	}

	private isLive(state: SourceState): boolean {
		return state.feed.state === "live"
	}

	private setFeed(id: string, state: SourceState, next: SourceFeedState): void {
		state.feed = { state: next, since: Date.now() }
		if (this.isCurrent(state)) this.emit("feed-changed", id, this.feedOf(state))
	}

	/** Runs `work` after every earlier pause or resume of `id` settled. */
	private serialFeed<T>(id: string, work: () => Promise<T>): Promise<T> {
		const previous = this.feedChains.get(id) ?? Promise.resolve()
		const run = previous.then(work, work)
		const tail = run.then(
			() => undefined,
			() => undefined,
		)
		this.feedChains.set(id, tail)
		void tail.then(() => {
			if (this.feedChains.get(id) === tail) this.feedChains.delete(id)
		})
		return run
	}

	private feedSource(id: string): SourceState {
		const state = this.sources.get(id)
		if (!state)
			throw new WaveKitError(`Source ${id} not found`, "SOURCE_NOT_FOUND")
		if (state.config.type === "recording")
			throw new WaveKitError(
				"A recording source has no receiver feed to pause",
				"SOURCE_FEED_UNSUPPORTED",
			)
		return state
	}

	/**
	 * Pauses the source's receiver feed: the connection is closed cleanly (FIN, then destroy
	 * after SOURCE_PAUSE_CLOSE_TIMEOUT_MS) and never retried, any backoff timer is cancelled,
	 * and the pause is persisted. The registration, stream, caps and decoder assignments stay,
	 * so a resume restores the same tuning through the normal reconnect path. Idempotent:
	 * resolves once the connection is closed; `changed` is false when it was already paused.
	 */
	pause(id: string): Promise<SourceFeedResult> {
		return this.serialFeed(id, async () => {
			const state = this.feedSource(id)
			const changed = state.feed.state !== "paused"
			// A repeated pause also retries a write that failed.
			const persist = !this.pausedIds.has(id) || this.feedsUnsaved
			this.pausedIds.add(id)
			if (changed) {
				this.logger.info({ sourceId: id }, "Pausing source feed")
				this.setFeed(id, state, "paused")
			}
			await this.closeForPause(id, state)
			const persisted = persist ? await this.persistFeeds() : true
			return { feed: this.feedOf(state), changed, persisted }
		})
	}

	private closeForPause(id: string, state: SourceState): Promise<void> {
		if (state.reconnectTimer) {
			clearTimeout(state.reconnectTimer)
			state.reconnectTimer = null
		}
		state.retargetPending = false
		// A commanded rate-change restart cannot complete while paused.
		this.finishRateRecovery(id, false)
		const attempt = state.attempt
		if (!attempt || !this.isActiveAttempt(state, attempt))
			return Promise.resolve()
		const socket = attempt.socket
		const connected = attempt.phase === "connected"
		// No more payload from this session; the close handler still reports "disconnected".
		attempt.phase = "closed"
		attempt.sessionId = null
		attempt.lastSampleAt = null
		attempt.headerAt = null
		this.stopStallWatchdog(state)
		return new Promise<void>(resolve => {
			const timer = setTimeout(
				() => socket.destroy(),
				SOURCE_PAUSE_CLOSE_TIMEOUT_MS,
			)
			socket.once("close", () => {
				clearTimeout(timer)
				resolve()
			})
			if (socket.destroyed) {
				clearTimeout(timer)
				resolve()
				return
			}
			if (connected) {
				// Keep reading (and dropping) until the peer's FIN, so the close is clean.
				socket.resume()
				socket.end()
			} else socket.destroy()
		})
	}

	/**
	 * Resumes a paused feed with one connection attempt (no backoff). On success the feed is
	 * live before "connected" fires, the pause is dropped from the state file, and tuning is
	 * restored by the usual reconnect path (tuner restore, scanner recovery and gain restore
	 * on the first payload). On failure the feed reads "error" with a fixed safe message and
	 * stays paused (also across a restart); resume again to retry. Idempotent: a live feed
	 * answers `changed: false`.
	 */
	resume(id: string): Promise<SourceFeedResult> {
		return this.serialFeed(id, async () => {
			const state = this.feedSource(id)
			if (state.feed.state === "live") {
				// A live feed may still be recorded as paused after a failed write: retry it.
				const persist = this.pausedIds.delete(id) || this.feedsUnsaved
				const persisted = persist ? await this.persistFeeds() : true
				return { feed: this.feedOf(state), changed: false, persisted }
			}
			this.logger.info({ sourceId: id }, "Resuming source feed")
			this.setFeed(id, state, "resuming")
			state.reconnectAttempts = 0
			try {
				await this.attemptConnection(id)
			} catch {
				// Logged by the attempt; the feed state below says what happened.
			}
			if (!this.isCurrent(state))
				throw new WaveKitError(`Source ${id} not found`, "SOURCE_NOT_FOUND")
			// The attempt's connect handler makes the feed live (TS still sees the narrowing above).
			if (this.isLive(state)) {
				this.pausedIds.delete(id)
				const persisted = await this.persistFeeds()
				if (this.isCurrent(state))
					this.emit("feed-changed", id, this.feedOf(state))
				this.logger.info({ sourceId: id }, "Source feed resumed")
				return { feed: this.feedOf(state), changed: true, persisted }
			}
			// Still resuming (a pause cannot interleave): the receiver was not reached.
			this.logger.warn(
				{ sourceId: id },
				"Resuming the source feed failed; the feed stays paused",
			)
			this.setFeed(id, state, "error")
			// The pause stays recorded; a write it still owes is retried here too.
			const persisted = this.feedsUnsaved ? await this.persistFeeds() : true
			return { feed: this.feedOf(state), changed: true, persisted }
		})
	}

	/**
	 * Gets the status of a specific source (Requirements 1.7, 15.4).
	 *
	 * @param id - Source ID
	 * @returns Source status or undefined if not found
	 */
	getStatus(id: string): SourceStatus | undefined {
		const state = this.sources.get(id)
		if (!state) return undefined

		return {
			id: state.config.id,
			type: state.config.type,
			url: formatSourceUrl(state.config),
			connected: state.connected,
			activity: this.getActivity(state),
			bytesReceived: state.bytesReceived,
			dataRate: state.dataRate,
			lastError: state.lastError,
			reconnectAttempts: state.reconnectAttempts,
			caps: state.config.caps,
			...(state.rateTruth.mismatch
				? { rateMismatch: state.rateTruth.mismatch }
				: {}),
			...(state.signalLevel.flat ? { signalFlat: state.signalLevel.flat } : {}),
			...(state.signalLevel.levelDbfs !== undefined
				? { signalLevelDbfs: state.signalLevel.levelDbfs }
				: {}),
			...(state.endpoint ? { endpoint: { ...state.endpoint } } : {}),
			...(state.config.type !== "recording"
				? { feed: this.feedOf(state) }
				: {}),
		}
	}

	private getActivity(state: SourceState): SourceActivity {
		const now = Date.now()
		const sampleAgeMs =
			state.lastSampleAt === null ? null : Math.max(0, now - state.lastSampleAt)
		let activity: SourceActivity["state"]
		if (state.recordingEnded) activity = "ended"
		else if (!state.connected) activity = "disconnected"
		else if (state.stream.writableNeedDrain || state.socket?.isPaused())
			activity = "paused"
		else if (sampleAgeMs !== null && sampleAgeMs < SAMPLE_TIMEOUT_MS)
			activity = "streaming"
		else if (
			now - Math.max(state.lastSampleAt ?? 0, state.expectedSince) >=
			SAMPLE_TIMEOUT_MS
		)
			activity = "stale"
		else activity = "waiting"
		return {
			state: activity,
			lastSampleAt:
				state.lastSampleAt === null
					? null
					: new Date(state.lastSampleAt).toISOString(),
			sampleAgeMs,
			timeoutMs: SAMPLE_TIMEOUT_MS,
		}
	}

	/**
	 * Gets the status of all sources.
	 *
	 * @returns Array of all source statuses
	 */
	getAllStatus(): SourceStatus[] {
		const statuses: SourceStatus[] = []
		for (const [id] of this.sources) {
			const status = this.getStatus(id)
			if (status) {
				statuses.push(status)
			}
		}
		return statuses
	}

	/**
	 * Checks if the SourceManager is in degraded mode (Requirement 10.3).
	 * Degraded mode means at least one source is disconnected but not all. A feed the operator
	 * holds paused (feedHeldOffline) is left out: it is meant to be disconnected.
	 *
	 * @returns true if in degraded mode, false otherwise
	 */
	isDegraded(): boolean {
		const allStatus = this.getAllStatus().filter(
			s => s.connected || !feedHeldOffline(s),
		)
		if (allStatus.length === 0) {
			return false // No sources configured is not degraded
		}

		const connectedCount = allStatus.filter(s => s.connected).length
		const totalCount = allStatus.length

		// Degraded if some but not all sources are disconnected
		return connectedCount > 0 && connectedCount < totalCount
	}

	/**
	 * Checks if all sources are unavailable (Requirement 10.2).
	 *
	 * @returns true if all sources are disconnected, false otherwise
	 */
	isAllSourcesUnavailable(): boolean {
		const allStatus = this.getAllStatus().filter(
			s => s.connected || !feedHeldOffline(s),
		)
		if (allStatus.length === 0) {
			return false // No sources configured
		}

		return allStatus.every(s => !s.connected)
	}

	/**
	 * Gets detailed information about the degraded state (Requirement 10.3).
	 * Useful for health check reporting.
	 *
	 * @returns Object with degraded state details
	 */
	getDegradedInfo(): {
		isDegraded: boolean
		isAllUnavailable: boolean
		connectedSources: string[]
		/** Disconnected sources the operator has not paused. */
		disconnectedSources: string[]
		/** Sources whose feed the operator holds paused (or is resuming). */
		pausedSources: string[]
		totalSources: number
	} {
		const allStatus = this.getAllStatus()
		const connectedSources = allStatus.filter(s => s.connected).map(s => s.id)
		const disconnectedSources = allStatus
			.filter(s => !s.connected && !feedHeldOffline(s))
			.map(s => s.id)
		const pausedSources = allStatus
			.filter(s => !s.connected && feedHeldOffline(s))
			.map(s => s.id)

		return {
			isDegraded: this.isDegraded(),
			isAllUnavailable: this.isAllSourcesUnavailable(),
			connectedSources,
			disconnectedSources,
			pausedSources,
			totalSources: allStatus.length,
		}
	}

	/**
	 * Gets the readable stream for a source.
	 *
	 * @param id - Source ID
	 * @returns Readable stream or undefined if not found
	 */
	getStream(id: string): Readable | undefined {
		const state = this.sources.get(id)
		return state?.stream
	}

	/**
	 * Gets the capabilities of a source (Requirement 15.4).
	 *
	 * @param id - Source ID
	 * @returns Source capabilities or undefined if not found
	 */
	getCaps(id: string): SourceCaps | undefined {
		const state = this.sources.get(id)
		return state?.config.caps
	}

	/**
	 * Updates the capabilities of a source dynamically (e.g., dynamic sample rate changes).
	 * Emits 'caps-changed' so consumers can react.
	 *
	 * Note: This is intended for runtime-safe updates like sampleRate/centerFreq.
	 * Changing format/kind may require additional pipeline reconfiguration.
	 *
	 * @param id - Source ID to update
	 * @param updates - Partial caps to merge with existing
	 * @returns Updated capabilities, or undefined if source not found
	 */
	updateSourceCaps(
		id: string,
		updates: Partial<SourceCaps>,
	): SourceCaps | undefined {
		updates = this.plainSourceData(updates)
		const state = this.sources.get(id)
		if (!state) {
			this.logger.warn({ sourceId: id }, "Cannot update caps: source not found")
			return undefined
		}

		const attempt = state.attempt
		const current = () => this.isCurrent(state) && state.attempt === attempt
		const oldCaps = state.config.caps
		const nextCaps: SourceCaps = {
			...oldCaps,
			...updates,
		}

		// Tuner clients commonly resend their current settings on connection.
		if (
			Object.entries(nextCaps).every(
				([key, value]) => Reflect.get(oldCaps, key) === value,
			)
		)
			return oldCaps

		state.config.caps = nextCaps
		if (oldCaps.format !== nextCaps.format || oldCaps.kind !== nextCaps.kind)
			state.iqRemainder = Buffer.alloc(0)

		if (
			updates.format &&
			updates.format !== state.activeFormat &&
			updates.format !== "auto"
		) {
			state.activeFormat = updates.format
			state.detectionBuffer = null
		}

		if (updates.format === "auto") {
			state.activeFormat = "auto"
			state.detectionBuffer = Buffer.alloc(0)
		}

		if (oldCaps.sampleRate !== nextCaps.sampleRate) {
			this.logger.info(
				{
					sourceId: id,
					oldSampleRate: oldCaps.sampleRate,
					newSampleRate: nextCaps.sampleRate,
				},
				"Source caps updated dynamically",
			)
		}

		if (!current()) return undefined
		this.onCapsChangedForSignalLevel(id, state, oldCaps)
		if (!current()) return undefined
		this.emit("caps-changed", id, nextCaps)
		return nextCaps
	}

	/**
	 * Sets the tuning metadata (sampleRate + centerFreq) exactly, dropping
	 * centerFreq when undefined. Used to reconcile caps with the tuner state core
	 * can actually back (e.g. a reset to the configured baseline after reconnect).
	 * Emits 'caps-changed' only when either value changes.
	 */
	setTuningCaps(
		id: string,
		tuning: { sampleRate: number; centerFreq?: number | undefined },
	): SourceCaps | undefined {
		tuning = this.plainSourceData(tuning)
		const state = this.sources.get(id)
		if (!state) {
			this.logger.warn({ sourceId: id }, "Cannot set tuning: source not found")
			return undefined
		}

		const attempt = state.attempt
		const current = () => this.isCurrent(state) && state.attempt === attempt
		const oldCaps = state.config.caps
		if (
			oldCaps.sampleRate === tuning.sampleRate &&
			oldCaps.centerFreq === tuning.centerFreq
		)
			return oldCaps

		const { centerFreq: _previousCenter, ...rest } = oldCaps
		const nextCaps: SourceCaps = { ...rest, sampleRate: tuning.sampleRate }
		if (tuning.centerFreq !== undefined) nextCaps.centerFreq = tuning.centerFreq
		state.config.caps = nextCaps

		this.logger.info(
			{
				sourceId: id,
				oldSampleRate: oldCaps.sampleRate,
				newSampleRate: nextCaps.sampleRate,
				oldCenterFreq: oldCaps.centerFreq,
				newCenterFreq: nextCaps.centerFreq,
			},
			"Source tuning metadata reconciled",
		)
		if (!current()) return undefined
		this.onCapsChangedForSignalLevel(id, state, oldCaps)
		if (!current()) return undefined
		this.emit("caps-changed", id, nextCaps)
		return nextCaps
	}

	/**
	 * Checks if a source supports RTL-TCP tuner control.
	 * Only rtl_tcp type sources can receive tuner commands.
	 *
	 * @param id - Source ID
	 * @returns true if source is rtl_tcp, false otherwise
	 */
	isRtlTcpSource(id: string): boolean {
		const state = this.sources.get(id)
		if (!state || !state.config.type) return false
		return state.config.type === "rtl_tcp"
	}

	/**
	 * Gets the captured RTL-TCP header for a source, if available.
	 *
	 * @param id - Source ID
	 * @returns RTL-TCP header buffer or undefined if not available
	 */
	getRtlTcpHeader(id: string): Buffer | undefined {
		const state = this.sources.get(id)
		return state?.rtlTcpHeader ?? undefined
	}

	/**
	 * Gets parsed RTL-TCP header info for a source, if available.
	 *
	 * @param id - Source ID
	 * @returns Parsed RTL-TCP header info or undefined if not available
	 */
	getRtlTcpInfo(id: string): RtlTcpHeaderInfo | undefined {
		const state = this.sources.get(id)
		return state?.rtlTcpHeaderInfo ?? undefined
	}

	override emit(event: string | symbol, ...args: unknown[]): boolean {
		return this.tunerCommandContext.exit(() => super.emit(event, ...args))
	}

	// One FIFO per source; only commanded rate changes authorize reconnect waits.
	private readonly tunerCommands = new Map<string, Promise<void>>()
	private readonly rateRecovery = new Map<
		string,
		{
			deadline: number
			socket: net.Socket
			owner: AbortSignal
		}
	>()

	private readonly tunerCommandContext = new AsyncLocalStorage<{
		id: string
		signal: AbortSignal
		active: boolean
	}>()
	private readonly tunerCommandControllers = new Map<
		string,
		Set<AbortController>
	>()

	/** Detach independently spawned background work from the caller lifetime. */
	withoutTunerCommand<T>(work: () => T): T {
		return this.tunerCommandContext.exit(work)
	}

	/** Reject late writes and state changes from a cancelled tuner command. */
	assertTunerCommandActive(): void {
		this.tunerCommandContext.getStore()?.signal.throwIfAborted()
	}

	/** Whether this source is still in its commanded rate-change recovery window. */
	isCommandedRecovery(id: string): boolean {
		const recovery = this.rateRecovery.get(id)
		return (
			recovery !== undefined &&
			!recovery.owner.aborted &&
			recovery.deadline > Date.now()
		)
	}

	/**
	 * Serialize API commands, including the receiver's rate-change restart.
	 * Same-source nested commands share the parent's signal and deadline; queueing
	 * them would deadlock an awaited hook behind its own command.
	 */
	async runTunerCommand<T>(
		id: string,
		command: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const parent = this.tunerCommandContext.getStore()
		parent?.signal.throwIfAborted()
		if (parent?.id === id && parent.active) {
			const result = await command(parent.signal)
			parent.signal.throwIfAborted()
			return result
		}
		if (!this.sources.has(id))
			throw new WaveKitError(`Source ${id} not found`, "SOURCE_NOT_FOUND")
		if (
			(this.tunerCommandControllers.get(id)?.size ?? 0) >=
			TUNER_COMMAND_QUEUE_LIMIT
		)
			throw new WaveKitError(
				"Tuner command queue is full; retry",
				"TUNER_QUEUE_FULL",
			)
		const controller = new AbortController()
		const { signal } = controller
		const controllers =
			this.tunerCommandControllers.get(id) ?? new Set<AbortController>()
		controllers.add(controller)
		this.tunerCommandControllers.set(id, controllers)
		let onAbort: () => void = () => {}
		const cancelled = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(signal.reason)
			signal.addEventListener("abort", onAbort, { once: true })
		})
		let timer: ReturnType<typeof setTimeout> | undefined
		const previous = this.tunerCommands.get(id) ?? Promise.resolve()
		const execution = previous.then(async () => {
			signal.throwIfAborted()
			await this.waitForTunerReady(id)
			signal.throwIfAborted()
			timer = setTimeout(() => {
				controller.abort(
					new WaveKitError(
						"Tuner command timed out; retry the command",
						"TUNER_COMMAND_TIMEOUT",
					),
				)
			}, TUNER_COMMAND_TIMEOUT_MS)
			let result: T
			const context = { id, signal, active: true }
			try {
				result = await this.tunerCommandContext.run(context, () =>
					command(signal),
				)
			} finally {
				context.active = false
				clearTimeout(timer)
				if (this.rateRecovery.get(id)?.owner === signal)
					await this.waitForTunerReady(id)
			}
			signal.throwIfAborted()
			return result
		})
		const pending = Promise.race([execution, cancelled])
		const tail = pending.then(
			() => {},
			() => {},
		)
		this.tunerCommands.set(id, tail)
		try {
			return await pending
		} finally {
			clearTimeout(timer)
			const recovery = this.rateRecovery.get(id)
			if (signal.aborted && recovery?.owner === signal) {
				this.finishRateRecovery(id, false)
				if (
					this.sources.get(id)?.socket === recovery.socket &&
					this.sources.get(id)?.connected
				)
					recovery.socket.destroySoon()
			}
			signal.removeEventListener("abort", onAbort)
			controllers.delete(controller)
			if (
				controllers.size === 0 &&
				this.tunerCommandControllers.get(id) === controllers
			)
				this.tunerCommandControllers.delete(id)
			if (this.tunerCommands.get(id) === tail) this.tunerCommands.delete(id)
		}
	}

	private async waitForTunerReady(id: string): Promise<void> {
		const recovery = this.rateRecovery.get(id)
		if (recovery === undefined) return
		// An expired unchanged connection still supplying IQ needs no late restart.
		const state = this.sources.get(id)
		if (
			recovery.deadline <= Date.now() &&
			state?.socket === recovery.socket &&
			state.connected &&
			state.socket.writable &&
			state.lastSampleAt !== null &&
			state.lastSampleAt >= recovery.deadline
		) {
			this.finishRateRecovery(id, false)
			return
		}
		// Drain the complete API command (including bulk writes), then reopen.
		// Keeping the registration preserves the source stream and assignments.
		if (
			this.sources.get(id)?.socket === recovery.socket &&
			this.sources.get(id)?.connected
		)
			recovery.socket.destroySoon()
		if (
			this.sources.get(id)?.socket !== recovery.socket &&
			this.sources.get(id)?.connected &&
			this.sources.get(id)?.socket?.writable &&
			this.sources.get(id)?.lastSampleAt !== null
		) {
			this.finishRateRecovery(
				id,
				recovery.deadline > Date.now() && !recovery.owner.aborted,
			)
			return
		}
		const remaining = recovery.deadline - Date.now()
		if (remaining <= 0) {
			this.finishRateRecovery(id, false)
			throw this.sourceReconnecting()
		}
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer)
				this.off("payload-started", connected)
				this.off("source-removed", removed)
			}
			const connected = (sourceId: string) => {
				if (
					sourceId !== id ||
					this.sources.get(id)?.socket === recovery.socket ||
					!this.sources.get(id)?.connected ||
					!this.sources.get(id)?.socket?.writable
				)
					return
				cleanup()
				this.finishRateRecovery(
					id,
					recovery.deadline > Date.now() && !recovery.owner.aborted,
				)
				resolve()
			}
			const removed = (sourceId: string) => {
				if (sourceId !== id) return
				cleanup()
				this.finishRateRecovery(id, false)
				reject(new WaveKitError("Source was removed", "SOURCE_NOT_FOUND"))
			}
			const timer = setTimeout(() => {
				cleanup()
				this.finishRateRecovery(id, false)
				reject(this.sourceReconnecting())
			}, remaining)
			this.on("payload-started", connected)
			this.on("source-removed", removed)
		})
	}

	/** End each recovery once, before notifying consumers that preservation ended. */
	private finishRateRecovery(id: string, succeeded: boolean): void {
		const recovery = this.rateRecovery.get(id)
		if (!recovery) return
		this.rateRecovery.delete(id)
		if (!succeeded) this.emit("commanded-recovery-failed", id)
	}

	private sourceReconnecting(): WaveKitError {
		return new WaveKitError(
			"Source is reconnecting after a sample-rate change; retry the command",
			"SOURCE_RECONNECTING",
		)
	}

	/**
	 * Sends control data upstream to a network source (e.g., RTL-TCP commands).
	 *
	 * @param id - Source ID
	 * @param payload - Raw control bytes to send
	 * @returns true if write buffer accepted the data
	 */
	writeToSource(id: string, payload: Buffer): boolean {
		// Async context follows controller awaits, so cancelled callbacks cannot
		// write later, even after a replacement source registers the same id.
		this.assertTunerCommandActive()
		const state = this.sources.get(id)
		if (!state) {
			throw new WaveKitError(`Source ${id} not found`, "SOURCE_NOT_FOUND")
		}
		if (state.config.type === "recording") {
			throw new WaveKitError(
				"Source does not accept control commands",
				"SOURCE_CONTROL_UNSUPPORTED",
			)
		}
		if (!state.socket || !state.connected) {
			throw new WaveKitError(
				`Source ${id} is not connected`,
				"SOURCE_DISCONNECTED",
			)
		}
		if (!state.socket.writable) {
			throw new WaveKitError(
				"Source socket is not writable",
				"SOURCE_DISCONNECTED",
			)
		}

		const socket = state.socket
		// Only a live REST command for this source owns a restart; a timer it left behind does not.
		const command = this.tunerCommandContext.getStore()
		const rateChange =
			command !== undefined &&
			command.active &&
			command.id === id &&
			payload.length === 5 &&
			payload[0] === 0x02 &&
			payload.readUInt32BE(1) !== state.config.caps.sampleRate
		const accepted = socket.write(payload)
		if (rateChange) {
			// First retry: <= 4 s equal-jitter backoff (2^1 × 2 s) + 5 s
			// connect timeout = 9 s. A later retry needs a new caller request.
			this.rateRecovery.set(id, {
				deadline:
					Date.now() + calculateBackoffDelay(1) + SOURCE_CONNECT_TIMEOUT_MS,
				socket,
				owner: command.signal,
			})
		}
		return accepted
	}

	/**
	 * Checks if a source is compatible with a decoder's capabilities (Requirements 16.2, 16.3).
	 *
	 * Compatibility rules:
	 * - audio_pcm decoder input matches audio_pcm source kind
	 * - iq decoder input matches iq source kind
	 * - external decoder input is always compatible (decoder manages its own source)
	 *
	 * @param sourceId - Source ID to check
	 * @param decoderCaps - Decoder capabilities to check against
	 * @returns true if compatible, false otherwise
	 */
	isCompatible(sourceId: string, decoderCaps: DecoderCaps): boolean {
		const sourceCaps = this.getCaps(sourceId)
		if (!sourceCaps) return false

		// External decoders manage their own sources, always compatible
		if (decoderCaps.input === "external") {
			return true
		}

		// Check input type matches source kind
		return decoderCaps.input === sourceCaps.kind
	}

	/**
	 * Gets all sources that are compatible with a decoder's capabilities.
	 *
	 * @param decoderCaps - Decoder capabilities to match against
	 * @returns Array of compatible source statuses
	 */
	getAvailableSources(decoderCaps: DecoderCaps): SourceStatus[] {
		const available: SourceStatus[] = []

		for (const [id] of this.sources) {
			if (this.isCompatible(id, decoderCaps)) {
				const status = this.getStatus(id)
				if (status) {
					available.push(status)
				}
			}
		}

		return available
	}

	/**
	 * Assigns a decoder to a source (Requirement 15.2).
	 *
	 * @param decoderId - Decoder ID to assign
	 * @param sourceId - Source ID to assign to
	 * @param decoderCaps - Decoder capabilities for compatibility checking
	 * @throws SourceCompatibilityError if source and decoder are not compatible
	 * @throws ExclusiveSourceError if source is exclusive and already assigned
	 */
	assignDecoder(
		decoderId: string,
		sourceId: string,
		decoderCaps: DecoderCaps,
	): void {
		const state = this.sources.get(sourceId)
		if (!state) {
			throw new Error(`Source ${sourceId} not found`)
		}

		// Check compatibility (Requirement 16.2, 16.3)
		if (!this.isCompatible(sourceId, decoderCaps)) {
			throw new SourceCompatibilityError(
				sourceId,
				decoderId,
				`Decoder input type '${decoderCaps.input}' does not match source kind '${state.config.caps.kind}'`,
			)
		}

		// Enforce exclusivity for both incoming and existing assignments (Requirement 15.3).
		const conflictingAssignment = this.getSourceAssignments(sourceId).find(
			assignment =>
				assignment.decoderId !== decoderId &&
				(state.config.caps.exclusive ||
					decoderCaps.wantsExclusiveSource ||
					assignment.wantsExclusiveSource),
		)
		if (conflictingAssignment) {
			throw new ExclusiveSourceError(
				sourceId,
				conflictingAssignment.decoderId,
				decoderId,
			)
		}

		// Remove any existing assignment for this decoder
		this.decoderAssignments.delete(decoderId)

		// Create new assignment
		this.decoderAssignments.set(decoderId, {
			wantsExclusiveSource: decoderCaps.wantsExclusiveSource ?? false,
			decoderId,
			sourceId,
			assignedAt: new Date(),
		})

		this.logger.info({ decoderId, sourceId }, "Decoder assigned to source")
	}

	/**
	 * Unassigns a decoder from its source.
	 *
	 * @param decoderId - Decoder ID to unassign
	 */
	unassignDecoder(decoderId: string): void {
		const assignment = this.decoderAssignments.get(decoderId)
		if (assignment) {
			this.decoderAssignments.delete(decoderId)
			this.logger.info(
				{ decoderId, sourceId: assignment.sourceId },
				"Decoder unassigned from source",
			)
		}
	}

	/**
	 * Gets the source ID assigned to a decoder (Requirement 15.2).
	 *
	 * @param decoderId - Decoder ID to look up
	 * @returns Source ID or undefined if not assigned
	 */
	getAssignedSource(decoderId: string): string | undefined {
		return this.decoderAssignments.get(decoderId)?.sourceId
	}

	/**
	 * Gets all decoder assignments for a source.
	 *
	 * @param sourceId - Source ID to look up
	 * @returns Array of decoder assignments
	 */
	getSourceAssignments(sourceId: string): DecoderAssignment[] {
		const assignments: DecoderAssignment[] = []
		for (const assignment of this.decoderAssignments.values()) {
			if (assignment.sourceId === sourceId) {
				assignments.push(assignment)
			}
		}
		return assignments
	}

	/**
	 * Gets all decoder assignments.
	 *
	 * @returns Map of decoder ID to assignment
	 */
	getAllAssignments(): Map<string, DecoderAssignment> {
		return new Map(this.decoderAssignments)
	}

	/**
	 * Checks if a source is available for a new decoder assignment.
	 * A source is available if:
	 * - It exists
	 * - Neither the source nor an assigned decoder requires exclusive access, OR
	 * - It has no current assignments
	 *
	 * @param sourceId - Source ID to check
	 * @returns true if available, false otherwise
	 */
	isSourceAvailable(sourceId: string): boolean {
		const state = this.sources.get(sourceId)
		if (!state) return false

		const assignments = this.getSourceAssignments(sourceId)
		return (
			assignments.length === 0 ||
			(!state.config.caps.exclusive &&
				!assignments.some(assignment => assignment.wantsExclusiveSource))
		)
	}

	/**
	 * Disconnects all sources and cleans up resources.
	 */
	async disconnectAll(): Promise<void> {
		const ids = Array.from(this.sources.keys())
		for (const id of ids) this.teardown(id)
	}
}

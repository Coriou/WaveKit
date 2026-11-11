/**
 * SDR Host Poller - Polls wavekit-sdr-host API endpoints for status
 *
 * Periodically fetches status from configured SDR host endpoints,
 * tracking rtl_tcp/rtlmux process state, dongle info, and client stats.
 *
 * Features:
 * - Exponential backoff on failure (2s -> 4s -> 8s -> max 30s)
 * - Request timeout to avoid blocking
 * - Maintains last-known-good state with staleness tracking
 * - Graceful degradation when endpoint unavailable
 */

import { EventEmitter } from "node:events"
import { z } from "zod"
import { isDialableEndpoint } from "./endpoint-probe.js"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import type { SdrHostLinkFacts } from "./link-burst/contract.js"
import type { SdrHostStatus } from "@wavekit/api-types"
import {
	parseSdrHostIdentity,
	type SdrHostIdentityFacts,
} from "./receiver-identity.js"

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_POLL_INTERVAL_MS = 3000
const DEFAULT_TIMEOUT_MS = 2000
const BASE_BACKOFF_MS = 2000
const MAX_BACKOFF_MS = 30000
/**
 * An auto-detected sdr-host that never answered is still awaited (a weak receiver key does not
 * adopt the learned state from before namespacing) until this many polls failed: with the backoff
 * above, about 2 + 4 s after the first failure (pollNow at a connection can shorten it).
 */
export const SDR_HOST_FIRST_ANSWER_ATTEMPTS = 3

/** Pass a version string through only when it is short printable ASCII. */
export function sanitizeHostVersion(value: unknown): string | null {
	return typeof value === "string" && /^[\x20-\x7e]{1,64}$/.test(value)
		? value
		: null
}

/**
 * The receiver's own address list (sdr-host `GET /api/status` `receiverId` and
 * `endpoints`; docs/specs/receiver-endpoints 1.1-1.4). Only literal IP addresses
 * survive; anything malformed drops the whole report, so selection fails closed.
 */
const ReceiverEndpointsSchema = z.object({
	receiverId: z.string().regex(/^[0-9a-f]{32}$/),
	endpoints: z.object({
		iqPort: z.number().int().min(1).max(65535),
		apiPort: z.number().int().min(1).max(65535),
		addresses: z
			.array(
				z.object({
					address: z
						.string()
						.max(64)
						.refine(isDialableEndpoint, "not a dialable literal IP"),
					kind: z.enum(["ethernet", "wireless", "other"]),
				}),
			)
			.max(32),
	}),
})

export type ReceiverEndpointsReport = z.infer<typeof ReceiverEndpointsSchema>

/** Parses a status body's endpoint fields; null when absent or invalid. */
export function parseReceiverEndpoints(
	body: unknown,
): ReceiverEndpointsReport | null {
	const result = ReceiverEndpointsSchema.safeParse(body)
	return result.success ? result.data : null
}

const DongleFactSchema = z.object({
	present: z.boolean().optional(),
	found: z.boolean().optional(),
	probeFailed: z.boolean().optional(),
})
const RtlTcpFactSchema = z.object({ running: z.boolean() })

/**
 * The status body's device and rtl_tcp facts, each null unless stated as a boolean: a claim about
 * the receiver reads these, never a default. `present` wins over the legacy `found`. A failed USB
 * probe states no device fact, whatever `present` says; a body without `probeFailed` is an older
 * host and reads as it always did. A non-boolean `probeFailed` fails the parse: no claim.
 */
export function parseReceiverFacts(
	body: Record<string, unknown>,
): NonNullable<SdrHostStatus["receiverFacts"]> {
	const dongle = DongleFactSchema.safeParse(body["dongle"])
	const rtlTcp = RtlTcpFactSchema.safeParse(body["rtlTcp"])
	const probeFailed = dongle.success ? dongle.data.probeFailed : undefined
	return {
		deviceFound:
			dongle.success && probeFailed !== true
				? (dongle.data.present ?? dongle.data.found ?? null)
				: null,
		rtlTcpRunning: rtlTcp.success ? rtlTcp.data.running : null,
		...(probeFailed === undefined
			? {}
			: { deviceProbe: probeFailed ? "failed" : "observed" }),
	}
}

const ReadingStateSchema = z.enum(["ok", "stale", "unavailable"])
const HostLinkSchema = z.object({
	network: z.object({
		state: ReadingStateSchema,
		value: z
			.array(
				z.object({
					kind: z.enum(["ethernet", "wireless", "other"]),
					defaultRouteMetric: z.number().finite().nonnegative().nullable(),
					wireless: z.object({ signalDbm: z.number().finite() }).nullable(),
				}),
			)
			.nullable(),
	}),
	power: z.object({
		undervoltageNow: z.object({
			state: ReadingStateSchema,
			value: z.boolean().nullable(),
		}),
		throttling: z.object({
			state: ReadingStateSchema,
			value: z.object({ throttled: z.boolean() }).nullable(),
		}),
	}),
})
const IqDeliverySchema = z.object({
	modes: z.array(z.enum(["raw", "channels"])).max(2),
})

// ============================================================================
// Types
// ============================================================================

export interface SdrHostConfig {
	sourceId: string
	apiUrl: string
	rtlmuxStatsUrl?: string
}

export interface SdrHostPollerEvents {
	status: (status: SdrHostStatus) => void
	/** After each successful poll: the receiver's own endpoints, or null. */
	"receiver-endpoints": (
		sourceId: string,
		report: ReceiverEndpointsReport | null,
	) => void
	error: (sourceId: string, error: Error) => void
	recovered: (sourceId: string) => void
	/**
	 * Every poll's result, right after its `/api/status` request (before `/api/host`): the
	 * validated identity fields of an unredirected answer, or null (a failed or redirected one).
	 */
	"identity-result": (sourceId: string, result: SdrHostIdentityResult) => void
}

/** One poll's identity outcome (SdrHostPoller "identity-result"). */
export interface SdrHostIdentityResult {
	/**
	 * performance.now() (monotonic) when the poll's request started: the tracker's connection
	 * epoch rule compares it with its own performance.now() at the connection, so a wall-clock
	 * step never puts a result in the wrong connection.
	 */
	startedAt: number
	/** The sdr-host answered `/api/status` (redirected or not). */
	ok: boolean
	/** The answer's identity fields; null for a failed or redirected answer. */
	facts: SdrHostIdentityFacts | null
}

export interface SdrHostPollerOptions {
	/** Poll interval in milliseconds (default: 3000) */
	pollIntervalMs?: number

	/** HTTP request timeout in milliseconds (default: 2000) */
	timeoutMs?: number

	/** Custom fetch function for testing */
	fetchFn?: typeof fetch
}

interface PollerState {
	config: SdrHostConfig
	lastStatus: SdrHostStatus | null
	linkFacts: SdrHostLinkFacts | null
	consecutiveFailures: number
	nextPollAt: number
	timer: ReturnType<typeof setTimeout> | null
	/** A poll is running now. */
	inFlight: boolean
	/** pollNow came while one ran: another starts right after it. */
	rerun: boolean
	/** Any poll of this process got an answer. */
	answered: boolean
}

// ============================================================================
// SdrHostPoller
// ============================================================================

export class SdrHostPoller extends EventEmitter {
	private readonly log: Logger
	private readonly pollIntervalMs: number
	private readonly timeoutMs: number
	private readonly fetchFn: typeof fetch

	private readonly pollers: Map<string, PollerState> = new Map()
	private isRunning: boolean = false

	constructor(
		logger: Logger,
		hosts: SdrHostConfig[],
		options: SdrHostPollerOptions = {},
	) {
		super()
		this.log = createComponentLogger(logger, "SdrHostPoller")
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
		this.fetchFn = options.fetchFn ?? fetch

		// Initialize poller state for each host
		for (const config of hosts) {
			this.pollers.set(config.sourceId, {
				config,
				lastStatus: null,
				linkFacts: null,
				consecutiveFailures: 0,
				nextPollAt: 0,
				timer: null,
				inFlight: false,
				rerun: false,
				answered: false,
			})
		}
	}

	// ============================================================================
	// Public API
	// ============================================================================

	/**
	 * Starts polling all configured SDR hosts.
	 */
	start(): void {
		if (this.isRunning) {
			this.log.warn("SdrHostPoller already started")
			return
		}

		this.isRunning = true
		this.log.info({ hostCount: this.pollers.size }, "Starting SDR host polling")

		// Start polling each host
		for (const [sourceId, state] of this.pollers) {
			this.scheduleNextPoll(sourceId, 0) // Poll immediately
		}
	}

	/**
	 * Stops polling all SDR hosts.
	 */
	stop(): void {
		if (!this.isRunning) {
			return
		}

		this.isRunning = false

		// Clear all timers
		for (const state of this.pollers.values()) {
			if (state.timer) {
				clearTimeout(state.timer)
				state.timer = null
			}
		}

		this.log.info("Stopped SDR host polling")
	}

	/**
	 * Gets the latest status for a specific source.
	 */
	getStatus(sourceId: string): SdrHostStatus | undefined {
		const state = this.pollers.get(sourceId)
		if (!state) {
			return undefined
		}

		// Return cached status or create unavailable status
		return state.lastStatus ?? this.createUnavailableStatus(state.config, null)
	}

	/** Latest validated receiver facts, without host names or addresses. */
	getLinkFacts(sourceId: string): SdrHostLinkFacts | null {
		const facts = this.pollers.get(sourceId)?.linkFacts
		return facts ? { ...facts } : null
	}

	/** True once any poll of this process got an answer from the source's sdr-host. */
	hasAnswered(sourceId: string): boolean {
		return this.pollers.get(sourceId)?.answered === true
	}

	/**
	 * True while the source's sdr-host may still give its first answer: it never answered and
	 * fewer than SDR_HOST_FIRST_ANSWER_ATTEMPTS polls failed (false for an unknown source).
	 */
	awaitingFirstAnswer(sourceId: string): boolean {
		const state = this.pollers.get(sourceId)
		return (
			state !== undefined &&
			!state.answered &&
			state.consecutiveFailures < SDR_HOST_FIRST_ANSWER_ATTEMPTS
		)
	}

	/**
	 * Polls the source's sdr-host now (a new connection wants an answer from after it opened):
	 * a poll running now is followed by another right after it; a scheduled one (also a failure
	 * backoff) is brought forward. The failure count is kept, so backoff after it still grows.
	 */
	pollNow(sourceId: string): void {
		const state = this.pollers.get(sourceId)
		if (!state || !this.isRunning) return
		if (state.inFlight) {
			state.rerun = true
			return
		}
		this.scheduleNextPoll(sourceId, 0)
	}

	/**
	 * Gets all SDR host statuses.
	 */
	getAllStatuses(): SdrHostStatus[] {
		return Array.from(this.pollers.values()).map(
			state =>
				state.lastStatus ?? this.createUnavailableStatus(state.config, null),
		)
	}

	/**
	 * Adds a new SDR host to poll.
	 */
	addHost(config: SdrHostConfig): void {
		if (this.pollers.has(config.sourceId)) {
			this.log.warn({ sourceId: config.sourceId }, "Host already exists")
			return
		}

		const state: PollerState = {
			config,
			lastStatus: null,
			linkFacts: null,
			consecutiveFailures: 0,
			nextPollAt: 0,
			timer: null,
			inFlight: false,
			rerun: false,
			answered: false,
		}

		this.pollers.set(config.sourceId, state)

		if (this.isRunning) {
			this.scheduleNextPoll(config.sourceId, 0)
		}
	}

	/**
	 * Removes an SDR host from polling.
	 */
	removeHost(sourceId: string): void {
		const state = this.pollers.get(sourceId)
		if (!state) {
			return
		}

		if (state.timer) {
			clearTimeout(state.timer)
		}

		this.pollers.delete(sourceId)
	}

	// ============================================================================
	// Polling Logic
	// ============================================================================

	private scheduleNextPoll(sourceId: string, delayMs: number): void {
		const state = this.pollers.get(sourceId)
		if (!state || !this.isRunning) {
			return
		}

		if (state.timer) {
			clearTimeout(state.timer)
		}

		state.nextPollAt = Date.now() + delayMs
		state.timer = setTimeout(() => {
			void this.pollHost(sourceId)
		}, delayMs)
	}

	private async pollHost(sourceId: string): Promise<void> {
		const state = this.pollers.get(sourceId)
		if (!state || !this.isRunning || state.inFlight) {
			return
		}
		state.inFlight = true
		state.rerun = false
		const startedAt = performance.now()
		let next: number
		try {
			next = await this.pollOnce(sourceId, state, startedAt)
		} finally {
			state.inFlight = false
		}
		if (this.pollers.get(sourceId) !== state) return
		if (state.rerun) {
			state.rerun = false
			next = 0
		}
		this.scheduleNextPoll(sourceId, next)
	}

	/** One poll; resolves the delay before the next. */
	private async pollOnce(
		sourceId: string,
		state: PollerState,
		startedAt: number,
	): Promise<number> {
		try {
			const { status, endpoints, identity } = await this.fetchStatus(
				state.config,
			)
			state.answered = true
			// The identity first: the receiver tracker waits on it, not on /api/host.
			if (this.pollers.get(sourceId) === state)
				this.emitIdentityResult(sourceId, {
					startedAt,
					ok: true,
					facts: identity,
				})
			state.linkFacts = await this.fetchLinkFacts(state.config)

			// Track recovery
			if (state.consecutiveFailures > 0) {
				this.log.info({ sourceId }, "SDR host connection recovered")
				this.emit("recovered", sourceId)
			}

			state.lastStatus = status
			state.consecutiveFailures = 0

			this.emit("status", status)
			if (this.pollers.get(sourceId) === state)
				this.emit("receiver-endpoints", sourceId, endpoints)

			// Next poll at the normal interval
			return this.pollIntervalMs
		} catch (error) {
			state.linkFacts = null
			state.consecutiveFailures++

			const backoffDelay = Math.min(
				BASE_BACKOFF_MS * Math.pow(2, state.consecutiveFailures - 1),
				MAX_BACKOFF_MS,
			)

			this.log.debug(
				{
					sourceId,
					failures: state.consecutiveFailures,
					backoffMs: backoffDelay,
				},
				"SDR host poll failed, backing off",
			)

			// Update status to show fetch error
			state.lastStatus = this.createUnavailableStatus(
				state.config,
				error instanceof Error ? error.message : String(error),
			)

			if (this.pollers.get(sourceId) === state)
				this.emitIdentityResult(sourceId, {
					startedAt,
					ok: false,
					facts: null,
				})
			this.emit("error", sourceId, error as Error)

			// Retry with backoff
			return backoffDelay
		}
	}

	/** A throwing listener never breaks the poll loop. */
	private emitIdentityResult(
		sourceId: string,
		result: SdrHostIdentityResult,
	): void {
		try {
			this.emit("identity-result", sourceId, result)
		} catch (err) {
			this.log.warn({ err, sourceId }, "Identity result listener failed")
		}
	}

	private async fetchLinkFacts(
		config: SdrHostConfig,
	): Promise<SdrHostLinkFacts | null> {
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
		try {
			const response = await this.fetchFn(`${config.apiUrl}/api/host`, {
				signal: controller.signal,
				headers: { Accept: "application/json" },
			})
			if (!response.ok) return null
			const body: unknown = await response.json()
			const parsed = HostLinkSchema.safeParse(body)
			if (!parsed.success) return null
			const { network, power } = parsed.data
			let preferred: NonNullable<typeof network.value>[number] | null = null
			let preferredMetric = Infinity
			if (network.state === "ok") {
				for (const iface of network.value ?? []) {
					const metric = iface.defaultRouteMetric
					if (metric !== null && metric < preferredMetric) {
						preferred = iface
						preferredMetric = metric
					}
				}
			}
			return {
				interfaceKind: preferred?.kind ?? null,
				signalDbm: preferred?.wireless?.signalDbm ?? null,
				undervoltageNow:
					power.undervoltageNow.state === "ok"
						? power.undervoltageNow.value
						: null,
				throttled:
					power.throttling.state === "ok"
						? (power.throttling.value?.throttled ?? null)
						: null,
			}
		} catch {
			return null
		} finally {
			clearTimeout(timeoutId)
		}
	}

	private async fetchStatus(config: SdrHostConfig): Promise<{
		status: SdrHostStatus
		endpoints: ReceiverEndpointsReport | null
		identity: SdrHostIdentityFacts | null
	}> {
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

		try {
			const response = await this.fetchFn(`${config.apiUrl}/api/status`, {
				signal: controller.signal,
				headers: {
					Accept: "application/json",
				},
			})

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`)
			}

			const body: unknown = await response.json()
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				throw new Error("Malformed SDR host status body")
			}
			const data = body as {
				version?: unknown
				uptime?: number
				rtlTcp?: {
					running: boolean
					pid?: number
					restartCount?: number
					lastRestartAt?: string
					config?: {
						sampleRate?: number
						frequency?: number
						gain?: number
						agc?: boolean
					}
				}
				rtlmux?: {
					running: boolean
					pid?: number
					restartCount?: number
					lastRestartAt?: string
					// Stats can be in two formats:
					// 1. SDR Host API format: { clients: [], bytesPerSec, totalBytesSent, clientDetails: [] }
					// 2. Raw rtlmux format: { server: { dataIn, dataOut }, clients: [ { client, dropped, ... } ] }
					stats?: {
						// SDR Host API format (preferred)
						clients?: number | Array<unknown>
						bytesPerSec?: number
						totalBytesSent?: number
						clientDetails?: Array<{
							id: number
							address: string
							bytesDropped: number
						}>
						// Raw rtlmux format (fallback)
						server?: { dataIn?: number; dataOut?: number }
					}
				}
				dongle?: {
					present?: boolean
					found?: boolean
					probeFailed?: boolean
					vendor?: string
					product?: string
					serial?: string
				}
				warnings?: string[]
				errors?: string[]
			}

			// Extract rtlmux info - handle both SDR Host API and raw rtlmux formats
			const rtlmuxStats = data.rtlmux?.stats
			let clientCount = 0
			let bytesPerSec = 0
			let totalBytesSent = 0
			let clientDetails: Array<{
				id: number
				address: string
				bytesDropped: number
			}> = []

			if (rtlmuxStats) {
				// Check for SDR Host API format first (has bytesPerSec as number)
				if (typeof rtlmuxStats.bytesPerSec === "number") {
					// SDR Host API format
					clientCount =
						typeof rtlmuxStats.clients === "number"
							? rtlmuxStats.clients
							: Array.isArray(rtlmuxStats.clients)
								? rtlmuxStats.clients.length
								: 0
					bytesPerSec = rtlmuxStats.bytesPerSec
					totalBytesSent = rtlmuxStats.totalBytesSent ?? 0
					clientDetails = rtlmuxStats.clientDetails ?? []
				} else if (Array.isArray(rtlmuxStats.clients)) {
					// Raw rtlmux stats.json format
					const rawClients = rtlmuxStats.clients as Array<{
						client?: { host?: string; port?: number }
						dataIn?: number
						dataOut?: number
						dropped?: { size?: number; count?: number }
						connected?: number
					}>
					clientCount = rawClients.length
					// server.dataOut counts upstream tuner commands; IQ is sent to clients.
					totalBytesSent = rawClients.reduce(
						(total, client) => total + (client.dataOut ?? 0),
						0,
					)
					// bytesPerSec not available in raw format
					clientDetails = rawClients.map((c, i) => ({
						id: i,
						address: c.client?.host ?? "unknown",
						bytesDropped: c.dropped?.size ?? 0,
					}))
				}
			}

			const iqDelivery = IqDeliverySchema.safeParse(
				(body as Record<string, unknown>)["iqDelivery"],
			)
			const status: SdrHostStatus = {
				iqDelivery: iqDelivery.success ? iqDelivery.data : null,
				available: true,
				sourceId: config.sourceId,
				apiUrl: config.apiUrl,
				version: sanitizeHostVersion(data.version),
				uptime: data.uptime ?? null,
				rtlTcp: data.rtlTcp
					? {
							running: data.rtlTcp.running,
							pid: data.rtlTcp.pid ?? null,
							restartCount: data.rtlTcp.restartCount ?? 0,
							lastRestartAt: data.rtlTcp.lastRestartAt ?? null,
							config: data.rtlTcp.config
								? {
										sampleRate: data.rtlTcp.config.sampleRate ?? 0,
										frequency: data.rtlTcp.config.frequency ?? 0,
										gain: data.rtlTcp.config.gain ?? 0,
										agc: data.rtlTcp.config.agc ?? false,
									}
								: null,
						}
					: null,
				rtlmux: data.rtlmux
					? {
							running: data.rtlmux.running,
							pid: data.rtlmux.pid ?? null,
							restartCount: data.rtlmux.restartCount ?? 0,
							lastRestartAt: data.rtlmux.lastRestartAt ?? null,
							clients: clientCount,
							bytesPerSec,
							totalBytesSent,
							clientDetails,
						}
					: null,
				receiverFacts: parseReceiverFacts(body as Record<string, unknown>),
				dongle: data.dongle
					? {
							found: data.dongle.present ?? data.dongle.found ?? false,
							vendor: data.dongle.vendor ?? null,
							product: data.dongle.product ?? null,
							serial: data.dongle.serial ?? null,
							...(data.dongle.probeFailed === true
								? { probeFailed: true }
								: {}),
						}
					: null,
				warnings: data.warnings ?? [],
				errors: data.errors ?? [],
				lastFetchedAt: new Date().toISOString(),
				fetchError: null,
			}
			// A redirected answer is not the configured API's own list (3.6).
			return {
				status,
				endpoints: response.redirected ? null : parseReceiverEndpoints(body),
				// Another server's answer never names this receiver.
				identity: response.redirected ? null : parseSdrHostIdentity(body),
			}
		} finally {
			clearTimeout(timeoutId)
		}
	}

	private createUnavailableStatus(
		config: SdrHostConfig,
		error: string | null,
	): SdrHostStatus {
		return {
			available: false,
			sourceId: config.sourceId,
			apiUrl: config.apiUrl,
			version: null,
			uptime: null,
			rtlTcp: null,
			rtlmux: null,
			dongle: null,
			warnings: [],
			errors: [],
			lastFetchedAt: null,
			fetchError: error,
		}
	}
}

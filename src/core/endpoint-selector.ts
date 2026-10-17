/**
 * Receiver endpoint selection (docs/specs/receiver-endpoints, user story 3).
 *
 * For each rtl_tcp source with `sdrHost.endpointSelection: auto`, moves the IQ
 * connection to a better address of the same receiver and back. Fail closed:
 * a candidate is only ever a literal IP that the configured sdr-host listed
 * itself (fetched by SdrHostPoller from the configured API), it must answer
 * with the same `receiverId` and serve an `RTL0` header, and any failure leaves
 * the active host as it is. The receiverId is not an authenticator; it only
 * shows that two addresses lead to the same running receiver. Never consumes
 * mDNS answers.
 */

import { createComponentLogger, type Logger } from "../utils/logger.js"
import type { EndpointProbe } from "./endpoint-probe.js"
import type { ReceiverEndpointsReport } from "./sdr-host-poller.js"

/** Minimum time between two switches to a better endpoint (anti-flap). */
export const ENDPOINT_SWITCH_HOLD_DOWN_MS = 5 * 60_000
/** First wait before a failed candidate is probed again; doubles per failure. */
export const ENDPOINT_CANDIDATE_BACKOFF_MS = 60_000
export const ENDPOINT_CANDIDATE_BACKOFF_MAX_MS = 30 * 60_000
/** Reconnect failures on a selected endpoint that send the source back home. */
export const ENDPOINT_FALLBACK_FAILURES = 2

export interface EndpointSelectorSources {
	getStatus(
		id: string,
	): { connected: boolean; reconnectAttempts: number } | undefined
	getActiveHost(id: string): string | undefined
	trackEndpoint(id: string): boolean
	retarget(id: string, host: string, reason: string): boolean
}

export interface EndpointSelectionTarget {
	sourceId: string
	/** `host` from the source config: the anchor. */
	configuredHost: string
	/** `port` from the source config; must equal the receiver's IQ port. */
	port: number
}

interface TargetState extends EndpointSelectionTarget {
	/** receiverId that the current non-configured host was verified against. */
	verifiedReceiverId: string | null
	lastSwitchAt: number
	backoff: Map<string, { until: number; delayMs: number }>
	busy: boolean
	portMismatchLogged: boolean
}

export class EndpointSelector {
	private readonly log: Logger
	private readonly targets = new Map<string, TargetState>()
	private readonly now: () => number
	private readonly holdDownMs: number
	private stopped = false

	constructor(
		logger: Logger,
		private readonly sources: EndpointSelectorSources,
		private readonly probe: EndpointProbe,
		targets: readonly EndpointSelectionTarget[],
		options: { now?: () => number; holdDownMs?: number } = {},
	) {
		this.log = createComponentLogger(logger, "EndpointSelector")
		this.now = options.now ?? (() => Date.now())
		this.holdDownMs = options.holdDownMs ?? ENDPOINT_SWITCH_HOLD_DOWN_MS
		for (const target of targets)
			this.targets.set(target.sourceId, {
				...target,
				verifiedReceiverId: null,
				lastSwitchAt: -Infinity,
				backoff: new Map(),
				busy: false,
				portMismatchLogged: false,
			})
	}

	stop(): void {
		this.stopped = true
	}

	/**
	 * One poll result from the configured sdr-host API. Serialised per source:
	 * a report that arrives while the previous one is still probing is dropped.
	 */
	async onReport(
		sourceId: string,
		report: ReceiverEndpointsReport | null,
	): Promise<void> {
		const target = this.targets.get(sourceId)
		if (!target || target.busy || this.stopped) return
		target.busy = true
		try {
			await this.evaluate(target, report)
		} finally {
			target.busy = false
		}
	}

	private async evaluate(
		target: TargetState,
		report: ReceiverEndpointsReport | null,
	): Promise<void> {
		const { sourceId, configuredHost } = target
		if (!this.sources.trackEndpoint(sourceId)) return
		const status = this.sources.getStatus(sourceId)
		const active = this.sources.getActiveHost(sourceId)
		if (!status || active === undefined) return
		// No usable report says nothing about the active connection: do nothing.
		if (!report) return
		const { receiverId, endpoints } = report

		if (active !== configuredHost) {
			const fallback = (reason: string): void => {
				this.markFailed(target, active)
				target.verifiedReceiverId = null
				this.sources.retarget(sourceId, configuredHost, reason)
			}
			if (status.reconnectAttempts >= ENDPOINT_FALLBACK_FAILURES)
				return fallback("fallback: selected endpoint stopped answering")
			if (
				endpoints.iqPort !== target.port ||
				!endpoints.addresses.some(a => a.address === active)
			)
				return fallback("fallback: receiver no longer lists the endpoint")
			if (receiverId !== target.verifiedReceiverId) {
				// sdr-host restarted: keep the endpoint only if it is still the same receiver.
				const seen = await this.probe.receiverId(active, endpoints.apiPort)
				if (!this.stillActive(target, active)) return
				if (seen !== receiverId)
					return fallback("fallback: receiver identity changed")
				target.verifiedReceiverId = receiverId
			}
		}

		if (endpoints.iqPort !== target.port) {
			if (!target.portMismatchLogged) {
				target.portMismatchLogged = true
				this.log.warn(
					{ sourceId, port: target.port, iqPort: endpoints.iqPort },
					"Endpoint selection idle: the source port is not the receiver's IQ port",
				)
			}
			return
		}
		if (!status.connected) return
		if (this.now() - target.lastSwitchAt < this.holdDownMs) return

		const rank = endpoints.addresses.findIndex(a => a.address === active)
		const limit = rank === -1 ? endpoints.addresses.length : rank
		const now = this.now()
		const candidate = endpoints.addresses
			.slice(0, limit)
			.find(
				a =>
					a.address !== active &&
					(target.backoff.get(a.address)?.until ?? -Infinity) <= now,
			)
		if (!candidate) return

		const seen = await this.probe.receiverId(
			candidate.address,
			endpoints.apiPort,
		)
		if (!this.stillActive(target, active)) return
		const ok =
			seen === receiverId &&
			(await this.probe.rtlTcpHeader(candidate.address, target.port))
		if (!this.stillActive(target, active)) return
		if (!ok) {
			this.markFailed(target, candidate.address)
			this.log.info(
				{ sourceId, candidate: candidate.address, kind: candidate.kind },
				"Endpoint candidate not verified; keeping the active host",
			)
			return
		}
		target.backoff.delete(candidate.address)
		target.verifiedReceiverId = receiverId
		target.lastSwitchAt = this.now()
		this.sources.retarget(
			sourceId,
			candidate.address,
			`verified ${candidate.kind} endpoint`,
		)
	}

	/** Nothing else moved the source while a probe was in flight. */
	private stillActive(target: TargetState, active: string): boolean {
		return (
			!this.stopped &&
			this.sources.getActiveHost(target.sourceId) === active &&
			this.sources.getStatus(target.sourceId) !== undefined
		)
	}

	private markFailed(target: TargetState, address: string): void {
		const previous = target.backoff.get(address)?.delayMs ?? 0
		const delayMs = Math.min(
			previous === 0 ? ENDPOINT_CANDIDATE_BACKOFF_MS : previous * 2,
			ENDPOINT_CANDIDATE_BACKOFF_MAX_MS,
		)
		target.backoff.set(address, { until: this.now() + delayMs, delayMs })
	}
}

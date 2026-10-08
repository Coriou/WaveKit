/**
 * Source status publisher - pushes `source:status` on the `sources` channel
 * (CLI-COORDINATION request 1).
 *
 * Cadence (bounded; the CLI audit already saw ~35 idle WS msgs/s):
 * - Immediately on source lifecycle events (connected, disconnected, error,
 *   ended, caps-changed), but only when the published state actually changed.
 * - Activity transitions (streaming/stale/waiting/paused) are time-based, not
 *   evented, so a 1 s poll compares a cheap state key and emits on change.
 *   Comparing does not serialize; nothing is sent while the key is unchanged.
 * - A 10 s per-source heartbeat refreshes counters (bytes, sample age) and
 *   resyncs clients. Cost: 0.1 msg/s per source, versus 1 msg/s per source on
 *   `metrics`; and it beats the CLI's former 5 s REST poll on freshness.
 * - No work at all while nobody subscribes to `sources`; the first tick after
 *   a subscriber appears sends a full snapshot (one message per source).
 */

import type { EventEmitter } from "node:events"
import type { SourceManager, SourceStatus } from "../../core/source-manager.js"
import type { FanoutTelemetryProvider } from "../../core/source-fanout-router.js"
import type { WebSocketEventBroadcaster } from "./events.js"
import {
	countConsumersBySource,
	toApiExtendedSourceStatus,
} from "../serializers/source-status.js"

/** How often activity is compared for time-based transitions. */
export const SOURCE_STATUS_POLL_MS = 1000
/** Maximum interval between two `source:status` messages for one source. */
export const SOURCE_STATUS_HEARTBEAT_MS = 10_000

const LIFECYCLE_EVENTS = [
	"connected",
	"disconnected",
	"error",
	"ended",
	"caps-changed",
] as const

export interface SourceStatusPublisherOptions {
	sourceManager: Pick<
		SourceManager,
		"getAllStatus" | "getStatus" | "getSourceAssignments" | "isSourceAvailable"
	> &
		Pick<EventEmitter, "on" | "off">
	fanoutTelemetry?:
		| Pick<FanoutTelemetryProvider, "getTelemetrySnapshot">
		| undefined
	broadcaster: Pick<
		WebSocketEventBroadcaster,
		"broadcastSourceStatus" | "getSubscribersCount"
	>
}

interface Published {
	key: string
	at: number
}

export class SourceStatusPublisher {
	private readonly options: SourceStatusPublisherOptions
	private readonly published = new Map<string, Published>()
	private timer: ReturnType<typeof setInterval> | undefined
	private readonly onLifecycle = (sourceId: unknown): void => {
		if (typeof sourceId === "string") this.publish([sourceId])
	}
	private readonly onRemoved = (sourceId: unknown): void => {
		if (typeof sourceId === "string") this.published.delete(sourceId)
	}

	constructor(options: SourceStatusPublisherOptions) {
		this.options = options
	}

	start(): void {
		if (this.timer) return
		for (const event of LIFECYCLE_EVENTS)
			this.options.sourceManager.on(event, this.onLifecycle)
		this.options.sourceManager.on("removed", this.onRemoved)
		this.timer = setInterval(() => this.publish(), SOURCE_STATUS_POLL_MS)
		this.timer.unref()
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
		for (const event of LIFECYCLE_EVENTS)
			this.options.sourceManager.off(event, this.onLifecycle)
		this.options.sourceManager.off("removed", this.onRemoved)
		this.published.clear()
	}

	/** Publishes changed or heartbeat-due sources; all sources when ids is omitted. */
	private publish(ids?: string[]): void {
		const { sourceManager, broadcaster, fanoutTelemetry } = this.options
		if (broadcaster.getSubscribersCount("sources") === 0) {
			// Forget what was sent so a new subscriber gets a full snapshot.
			this.published.clear()
			return
		}
		const statuses = ids
			? ids.flatMap(id => sourceManager.getStatus(id) ?? [])
			: sourceManager.getAllStatus()
		const now = Date.now()
		const due = statuses.filter(status => {
			const key = this.stateKey(status)
			const previous = this.published.get(status.id)
			if (
				previous?.key === key &&
				now - previous.at < SOURCE_STATUS_HEARTBEAT_MS
			)
				return false
			this.published.set(status.id, { key, at: now })
			return true
		})
		if (due.length === 0) return
		const consumers = countConsumersBySource(fanoutTelemetry)
		for (const status of due)
			broadcaster.broadcastSourceStatus(
				toApiExtendedSourceStatus(status, sourceManager, consumers),
			)
	}

	/** Fields whose change is a state change; counters and ages are excluded. */
	private stateKey(status: SourceStatus): string {
		const { sourceManager } = this.options
		const id = status.id
		return JSON.stringify([
			status.connected,
			status.activity.state,
			status.lastError ?? null,
			status.reconnectAttempts,
			status.caps,
			sourceManager.isSourceAvailable(id),
			sourceManager.getSourceAssignments(id).map(a => a.decoderId),
		])
	}
}

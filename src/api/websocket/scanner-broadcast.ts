/**
 * Scanner events → WS (spec § 12.2) through one WsLimiter (P12). The
 * waterfall feed is the separate `spectrum` channel (Task 37a).
 */
import type { EventEmitter } from "node:events"
import { DISCOVERY_MERGED_IDS_MAX } from "@wavekit/api-types"
import type {
	ScanJob,
	ScannerActivityEventData,
	ScannerDiscoveriesResyncEventData,
	ScannerDiscoveryEventData,
	ScannerIdentifyEventData,
	ScannerProgressEventData,
	ScannerStatus,
} from "@wavekit/api-types"
import type { ScannerSettings } from "../../core/scanner/types.js"
import { WsLimiter } from "../../core/scanner/ws-limiter.js"
import type { ServerMessage, WebSocketEventBroadcaster } from "./events.js"

// `off` comes from EventEmitter: a `(...args: never[])` listener type is rejected by its strict
// callback check, and typed `off` overloads would have to mirror every `on` overload.
export interface ScannerBroadcastSource extends Pick<EventEmitter, "off"> {
	on(event: "job", listener: (job: ScanJob) => void): unknown
	on(
		event: "progress",
		listener: (p: ScannerProgressEventData) => void,
	): unknown
	on(
		event: "discovery",
		listener: (d: ScannerDiscoveryEventData) => void,
	): unknown
	on(
		event: "activity",
		listener: (a: ScannerActivityEventData) => void,
	): unknown
	on(event: "status", listener: (s: ScannerStatus) => void): unknown
	/** Band inspection UX req 3.2: startup consolidation past 256 groups. */
	on(
		event: "discoveries-resync",
		listener: (d: ScannerDiscoveriesResyncEventData) => void,
	): unknown
	on(
		event: "identify",
		listener: (d: ScannerIdentifyEventData) => void,
	): unknown
	settings(): ScannerSettings
}

/**
 * Band inspection UX req 3.2: a pending `merged` discovery message replaced before delivery
 * (merge A<-B, then an update of A) keeps its absorbed ids: the replacement is sent as `merged`
 * with the union of both `mergedIds` (sorted, at most DISCOVERY_MERGED_IDS_MAX, `mergedTruncated`
 * past that or when either side was truncated). A `deleted` replacement wins as is (the survivor
 * is gone; clients refetch). Every other message: the replacement wins.
 */
export function coalesceDiscoveryMessages(
	pending: ServerMessage,
	next: ServerMessage,
): ServerMessage {
	if (pending.type !== "scanner:discovery" || next.type !== "scanner:discovery")
		return next
	const a = pending.data as ScannerDiscoveryEventData
	const b = next.data as ScannerDiscoveryEventData
	if (a.change !== "merged" || b.change === "deleted") return next
	const ids = [...new Set([...(a.mergedIds ?? []), ...(b.mergedIds ?? [])])]
		.filter(id => id !== b.discovery.id)
		.sort()
	const truncated =
		ids.length > DISCOVERY_MERGED_IDS_MAX ||
		a.mergedTruncated === true ||
		b.mergedTruncated === true
	if (ids.length > DISCOVERY_MERGED_IDS_MAX)
		ids.length = DISCOVERY_MERGED_IDS_MAX
	const data: ScannerDiscoveryEventData = {
		...b,
		change: "merged",
		mergedIds: ids,
		...(truncated ? { mergedTruncated: true as const } : {}),
	}
	return { ...next, data } as ServerMessage
}

export function wireScannerBroadcasts(
	scanner: ScannerBroadcastSource,
	broadcaster: WebSocketEventBroadcaster,
	opts: { now?: () => number } = {},
): { limiter: WsLimiter<ServerMessage>; dispose(): void } {
	const limiter = new WsLimiter<ServerMessage>({
		maxPerSecond: scanner.settings().ws.maxMessagesPerSecond,
		perKeyMinIntervalMs: 1000,
		// WG1 req 8.1: progress per job at up to 2 Hz; every other key keeps 1 s.
		perPriorityMinIntervalMs: { progress: 500 },
		// Monotonic: a wall-clock step must not stall or burst the limiter.
		now: opts.now ?? (() => performance.now()),
		emit: message => broadcaster.broadcast("scanner", message),
		coalesce: coalesceDiscoveryMessages,
		schedule: (fn, ms) => {
			const timer = setTimeout(fn, ms)
			timer.unref()
			return { cancel: () => clearTimeout(timer) }
		},
	})
	const onJob = (job: ScanJob) =>
		limiter.offer(`job:${job.id}`, { type: "scanner:job", data: job }, "state")
	const onProgress = (p: ScannerProgressEventData) =>
		limiter.offer(
			`progress:${p.jobId}`,
			{ type: "scanner:progress", data: p },
			"progress",
		)
	const onDiscovery = (d: ScannerDiscoveryEventData) =>
		limiter.offer(
			`discovery:${d.discovery.id}`,
			{ type: "scanner:discovery", data: d },
			"state",
		)
	const onResync = (d: ScannerDiscoveriesResyncEventData) =>
		limiter.offer(
			"discoveries-resync",
			{ type: "scanner:discoveries-resync", data: d },
			"state",
		)
	const onActivity = (a: ScannerActivityEventData) =>
		limiter.offer(
			`activity:${a.observationId}`,
			{ type: "scanner:activity", data: a },
			"activity",
		)
	// patchSettings force-emits `status` (Task 35), so a PATCHed ws.maxMessagesPerSecond applies here at once.
	const onStatus = (s: ScannerStatus) => {
		limiter.setMaxPerSecond(scanner.settings().ws.maxMessagesPerSecond)
		limiter.offer("status", { type: "scanner:status", data: s }, "state")
	}
	// § 12.2 "on change": per target, coalesced to ≤ 1/s with the latest state delivered (P12).
	const onIdentify = (d: ScannerIdentifyEventData) =>
		limiter.offer(
			`identify:${d.jobId}:${d.targetHz}`,
			{ type: "scanner:identify", data: d },
			"state",
		)
	scanner.on("job", onJob)
	scanner.on("progress", onProgress)
	scanner.on("discovery", onDiscovery)
	scanner.on("discoveries-resync", onResync)
	scanner.on("activity", onActivity)
	scanner.on("status", onStatus)
	scanner.on("identify", onIdentify)
	return {
		limiter,
		dispose: () => {
			scanner.off("job", onJob)
			scanner.off("progress", onProgress)
			scanner.off("discovery", onDiscovery)
			scanner.off("discoveries-resync", onResync)
			scanner.off("activity", onActivity)
			scanner.off("status", onStatus)
			scanner.off("identify", onIdentify)
			limiter.destroy()
		},
	}
}

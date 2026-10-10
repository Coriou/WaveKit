/**
 * Scanner events → WS (spec § 12.2) through one WsLimiter (P12). The
 * waterfall feed is the separate `spectrum` channel (Task 37a).
 */
import type { EventEmitter } from "node:events"
import type {
	ScanJob,
	ScannerActivityEventData,
	ScannerDiscoveryEventData,
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
	settings(): ScannerSettings
}

export function wireScannerBroadcasts(
	scanner: ScannerBroadcastSource,
	broadcaster: WebSocketEventBroadcaster,
	opts: { now?: () => number } = {},
): { limiter: WsLimiter<ServerMessage>; dispose(): void } {
	const limiter = new WsLimiter<ServerMessage>({
		maxPerSecond: scanner.settings().ws.maxMessagesPerSecond,
		perKeyMinIntervalMs: 1000,
		// Monotonic: a wall-clock step must not stall or burst the limiter.
		now: opts.now ?? (() => performance.now()),
		emit: message => broadcaster.broadcast("scanner", message),
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
	scanner.on("job", onJob)
	scanner.on("progress", onProgress)
	scanner.on("discovery", onDiscovery)
	scanner.on("activity", onActivity)
	scanner.on("status", onStatus)
	return {
		limiter,
		dispose: () => {
			scanner.off("job", onJob)
			scanner.off("progress", onProgress)
			scanner.off("discovery", onDiscovery)
			scanner.off("activity", onActivity)
			scanner.off("status", onStatus)
			limiter.destroy()
		},
	}
}

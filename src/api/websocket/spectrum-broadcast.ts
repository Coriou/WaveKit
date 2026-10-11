/**
 * `spectrum` channel (Spectrum-profile amendment): subscribe options go to SpectrumService, which
 * answers each client with `spectrum:profile` (plus snapshots) and routes each profile's frames to
 * its clients only. Spectrum messages bypass the scanner WsLimiter.
 */
import type { EventEmitter } from "node:events"
import type {
	SpectrumFrameEventData,
	SpectrumProfileEventData,
} from "@wavekit/api-types"
import type { WebSocketEventBroadcaster } from "./events.js"

type FrameListener = (
	frame: SpectrumFrameEventData,
	clientIds: readonly string[],
) => void
type ProfileListener = (
	clientId: string,
	ack: SpectrumProfileEventData,
	snapshots: readonly SpectrumFrameEventData[],
) => void

// `off` comes from EventEmitter (see ScannerBroadcastSource): typed overloads would have to mirror every `on`.
export interface SpectrumBroadcastSource extends Pick<EventEmitter, "off"> {
	on(event: "frame", listener: FrameListener): unknown
	on(event: "profile", listener: ProfileListener): unknown
	subscribe(clientId: string, options: unknown): Promise<void>
	unsubscribe(clientId: string): Promise<void>
}

export function wireSpectrumBroadcasts(
	spectrum: SpectrumBroadcastSource,
	broadcaster: WebSocketEventBroadcaster,
): { dispose(): void } {
	const seen = new Set<string>()
	const onFrame: FrameListener = (frame, clientIds) => {
		broadcaster.sendToClients("spectrum", clientIds, {
			type: "spectrum:frame",
			data: frame,
		})
	}
	// Ack first, then its snapshots, synchronously: live frames can only follow.
	const onProfile: ProfileListener = (clientId, ack, snapshots) => {
		broadcaster.sendToClients("spectrum", [clientId], {
			type: "spectrum:profile",
			data: ack,
		})
		for (const frame of snapshots)
			broadcaster.sendToClients("spectrum", [clientId], {
				type: "spectrum:frame",
				data: frame,
			})
	}
	spectrum.on("frame", onFrame)
	spectrum.on("profile", onProfile)
	const unobserve = broadcaster.observeChannel("spectrum", {
		subscribed: (clientId, options) => {
			seen.add(clientId)
			void spectrum.subscribe(clientId, options)
		},
		unsubscribed: clientId => {
			seen.delete(clientId)
			void spectrum.unsubscribe(clientId)
		},
	})
	return {
		dispose: () => {
			unobserve()
			spectrum.off("frame", onFrame)
			spectrum.off("profile", onProfile)
			for (const clientId of seen) void spectrum.unsubscribe(clientId)
			seen.clear()
		},
	}
}

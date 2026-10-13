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
import {
	limitBackfillFrames,
	spectrumFrameJsonLength,
} from "../../core/spectrum/spectrum-backfill.js"
import { BACKFILL_LIMITS } from "../../core/spectrum/subscribe-options.js"

/** Kept free after the backfill for live frames and envelope overhead. */
const BACKFILL_HEADROOM_MARGIN_BYTES = 128 * 1024
const BACKFILL_HEADROOM_MARGIN_MESSAGES = 16
/** `,"channel":"spectrum"` the broadcaster adds to each message. */
const CHANNEL_FIELD_BYTES = 24

/**
 * WG1 req 1.8: trims backfill to the client's outbound headroom (newest kept),
 * after reserving the ack, the snapshots and a margin; empty when the headroom
 * is below that reserve. Backfill so never causes a disconnect that the ack and
 * snapshots alone would not; those are still sent, so a client already at the
 * outbound caps can be disconnected by them.
 */
export function fitBackfill(
	headroom: { bytes: number; messages: number } | null,
	ack: SpectrumProfileEventData,
	snapshots: readonly SpectrumFrameEventData[],
	backfill: readonly SpectrumFrameEventData[],
): SpectrumFrameEventData[] {
	if (!headroom || backfill.length === 0) return []
	const reserved =
		JSON.stringify({ type: "spectrum:profile", data: ack }).length +
		snapshots.reduce(
			(sum, f) => sum + spectrumFrameJsonLength(f) + CHANNEL_FIELD_BYTES,
			CHANNEL_FIELD_BYTES,
		)
	const bytes = Math.min(
		BACKFILL_LIMITS.maxBytes,
		headroom.bytes - reserved - BACKFILL_HEADROOM_MARGIN_BYTES,
	)
	const messages = Math.min(
		BACKFILL_LIMITS.maxFrames,
		headroom.messages -
			1 -
			snapshots.length -
			BACKFILL_HEADROOM_MARGIN_MESSAGES,
	)
	if (bytes <= 0 || messages <= 0) return []
	// Each frame also carries the channel field on the wire.
	return limitBackfillFrames(
		backfill,
		messages,
		bytes - messages * CHANNEL_FIELD_BYTES,
	)
}

type FrameListener = (
	frame: SpectrumFrameEventData,
	clientIds: readonly string[],
) => void
type ProfileListener = (
	clientId: string,
	ack: SpectrumProfileEventData,
	snapshots: readonly SpectrumFrameEventData[],
	/** Omitted only by callers that predate backfill; treated as none. */
	backfill?: readonly SpectrumFrameEventData[],
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
	// Ack, then backfill frames, then snapshots, synchronously: live frames can only follow.
	const onProfile: ProfileListener = (clientId, ack, snapshots, backfill) => {
		const fitted = fitBackfill(
			broadcaster.outboundHeadroom(clientId),
			ack,
			snapshots,
			backfill ?? [],
		)
		// backfillFrames says how many follow, so it reports the trimmed count.
		const sent =
			ack.backfillFrames === undefined
				? ack
				: { ...ack, backfillFrames: fitted.length }
		broadcaster.sendToClients("spectrum", [clientId], {
			type: "spectrum:profile",
			data: sent,
		})
		for (const frame of fitted)
			broadcaster.sendToClients("spectrum", [clientId], {
				type: "spectrum:frame",
				data: frame,
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

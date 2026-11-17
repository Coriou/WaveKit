import type { Readable } from "node:stream"
import type { SourceCaps } from "../../config.js"

export type ChannelFormat = "cu8" | "cf32"

/** Addendum §2: what a channelised decoder asks the channelizer for. */
export interface DecoderChannelRequest {
	/** Absolute RF centre (addendum §1). */
	centerHz: number
	/** Two-sided occupied passband, unity gain. */
	bandwidthHz: number
	/** Passband edge → stopband edge, one side. */
	transitionHz: number
	/** Exact; the channelizer never approximates it. */
	outputRateHz: number
	format: ChannelFormat
	/** cu8 only, default 1.0 (addendum §3). */
	gain?: number
	/**
	 * Carrier frequency correction on the channel output, up to this many Hz either way, while a
	 * carrier is present (native/wavekit-chan/src/afc.rs); within (0, bandwidthHz / 2]. Absent: none.
	 */
	afcMaxHz?: number
}
export type DecoderChannelRequestResult =
	| DecoderChannelRequest
	| { invalid: string }

/** Addendum §5. Core-internal until api-types widens `DecoderSuspensionReasonCode`. */
export type ChannelAdmissionReason =
	| "channel-outside-capture"
	| "channel-request-invalid"
	| "channelizer-unavailable"
export const CHANNEL_ADMISSION_REASONS: readonly ChannelAdmissionReason[] = [
	"channel-outside-capture",
	"channel-request-invalid",
	"channelizer-unavailable",
]
export function isChannelAdmissionReason(
	code: string,
): code is ChannelAdmissionReason {
	return (CHANNEL_ADMISSION_REASONS as readonly string[]).includes(code)
}

export type DiscontinuityCause = "queue-overflow" | "input-gap"

/** What the process actually opened (its `opened` event), never the request (addendum §2). */
export interface RealisedChannel {
	outputRateHz: number
	format: ChannelFormat
	groupDelaySamples: number
}

interface ChannelGranted {
	ok: true
	stream: Readable
	channelId: string
	generation: number
	realised: RealisedChannel
}
interface ChannelRefused {
	ok: false
	reasonCode: ChannelAdmissionReason
	detail: string
	/** The capture centre moved during the request: recompute it against the current caps; not an outage. */
	race?: true
}
export type ChannelRequestResult = ChannelGranted | ChannelRefused

/**
 * How a granted channel reaches its consumer. `relay` (the default): the socket is piped into a Node stream the
 * consumer reads. `direct`: the connected socket itself, paused before it could read a byte, for a decoder child to
 * take as its stdin; Node never reads from it.
 */
export type ChannelInputMode = "relay" | "direct"
export interface ChannelRequestOptions {
	input?: ChannelInputMode
}
/**
 * A connected, paused channel socket. `bytesRead` stays 0 until something reads it: the hand-over to a child
 * refuses a socket that has read anything, since those bytes would be lost to the child.
 */
export type DirectChannelSocket = Readable & { readonly bytesRead: number }
/** A `direct` grant: the socket and no stream. */
export interface DirectChannelGranted {
	ok: true
	input: "direct"
	socket: DirectChannelSocket
	channelId: string
	generation: number
	realised: RealisedChannel
}
/** A direct request may still be answered with a relay grant, by a provider that has no direct mode. */
export type DirectChannelRequestResult =
	| ChannelRequestResult
	| DirectChannelGranted

/**
 * One open channel of one `stats` line (every 5 s, open channels only), both counters cumulative: `outputSamples` the
 * DSP produced for the channel, `droppedSamples` of those its full queue refused, so the difference is what was queued
 * for the reader. `bytesPerSample` is the size of one output sample of its format (cu8 2, cf32 8).
 */
export interface ChannelStats {
	sourceId: string
	generation: number
	channelId: string
	outputSamples: number
	droppedSamples: number
	bytesPerSample: number
}

/** The counters of a provider that serves `direct` input; optional, found structurally. */
export interface DirectChannelPort {
	on(event: "channel-stats", listener: (stats: ChannelStats) => void): unknown
	off(event: "channel-stats", listener: (stats: ChannelStats) => void): unknown
}

export interface ChannelProvider {
	requestChannel(
		sourceId: string,
		decoderId: string,
		req: DecoderChannelRequest,
		inputCaps: SourceCaps | undefined,
		/** Acquisition only: abort prevents a late grant; after grant, release its opaque ID. */
		signal?: AbortSignal,
	): Promise<ChannelRequestResult>
	/**
	 * With `options.input === "direct"` a provider with a direct mode grants the paused socket and no stream
	 * (DirectChannelGranted); one without answers as it does a relay request. A relay-only implementation of the
	 * call above satisfies this signature too.
	 */
	requestChannel(
		sourceId: string,
		decoderId: string,
		req: DecoderChannelRequest,
		inputCaps: SourceCaps | undefined,
		signal: AbortSignal | undefined,
		options: ChannelRequestOptions,
	): Promise<DirectChannelRequestResult>
	/**
	 * Stops delivery synchronously; resolves after terminal closure, disruptive generation retirement, or the
	 * close budget while a live process still owes the reply (the id stays fenced until it arrives).
	 */
	releaseChannel(channelId: string): Promise<void>
	currentGeneration(sourceId: string): number
	on(
		event: "channel-invalidated",
		listener: (
			sourceId: string,
			generation: number,
			channelIds: string[],
			/** Present for manager-owned invalidation; retirement can affect all grants. */
			cause?: string,
		) => void,
	): this
	on(
		event: "channel-discontinuity",
		listener: (
			channelId: string,
			generation: number,
			sampleIndex: number,
			droppedSamples: number,
			cause: DiscontinuityCause,
		) => void,
	): this
	off(
		event: "channel-invalidated" | "channel-discontinuity",
		listener: (...args: never[]) => void,
	): this
}

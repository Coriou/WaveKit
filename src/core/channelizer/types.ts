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
export type ChannelRequestResult =
	| ChannelGranted
	| { ok: false; reasonCode: ChannelAdmissionReason; detail: string }

export interface ChannelProvider {
	requestChannel(
		sourceId: string,
		decoderId: string,
		req: DecoderChannelRequest,
		inputCaps: SourceCaps | undefined,
	): Promise<ChannelRequestResult>
	releaseChannel(channelId: string): Promise<void>
	currentGeneration(sourceId: string): number
	on(
		event: "channel-invalidated",
		listener: (
			sourceId: string,
			generation: number,
			channelIds: string[],
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

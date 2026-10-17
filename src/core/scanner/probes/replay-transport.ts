import type { Readable } from "node:stream"
import type { DecoderConfig } from "../../../decoders/types.js"
import {
	IQ_CAPTURE_RATE_HZ,
	IQ_REPLAY_MAX_PROBES,
	IQ_REPLAY_PROBE_CORES,
	type IqCapturePort,
} from "../iq-capture-contract.js"
import { createChannelTransport } from "./channel-transport.js"
import type {
	ProbeMode,
	ProbeRequest,
	TransportContext,
	TransportStrategy,
} from "./probe-pool.js"

/** `ProbeRequest.replay` (WG11 req 6.5), typed structurally so this module needs no pool change. */
export type ReplayProbeRequest = ProbeRequest & {
	replay?: { captureId: string }
}

/** The replay transport: a strategy that also supplies the decoder's input stream. */
export interface ReplayTransportStrategy extends TransportStrategy {
	readonly kind: "replay"
	/** A fresh replay stream for the request's capture; null when the capture is gone (the probe is not started). */
	openInput(mode: ProbeMode, ctx: TransportContext): Readable | null
}

/** The capture a request replays, or null for a live request. */
export function replayCaptureOf(req: ProbeRequest): string | null {
	const replay = (req as ReplayProbeRequest).replay
	return replay !== undefined && typeof replay.captureId === "string"
		? replay.captureId
		: null
}

/**
 * WG11 req 6.5: a probe decoder fed from a narrowband IQ capture (cf32 at 48 kHz, already filtered to the
 * decoder's probe channel shape by the capture tool). Options equal the channel transport's, plus the
 * cf32 input format and the capture rate, so the audio pipeline starts at the FM demodulator.
 */
export function createReplayTransport(
	port: Pick<IqCapturePort, "openReplay">,
): ReplayTransportStrategy {
	// Reuse the channel transport's configure: one owner of the probe channel options.
	const channel = createChannelTransport({
		available: () => true,
		usableFraction: 1,
	})
	return {
		kind: "replay",
		preRoll: false,
		maxProbes: () => IQ_REPLAY_MAX_PROBES,
		cores: () => IQ_REPLAY_PROBE_CORES,
		supports: (mode, ctx) =>
			replayCaptureOf(ctx.req) !== null && mode.decoderType !== "rtl433",
		configure: (base, ctx): DecoderConfig => {
			const configured = channel.configure(base, ctx)
			return {
				...configured,
				options: {
					...configured.options,
					inputIqFormat: "cf32",
					inputSampleRate: IQ_CAPTURE_RATE_HZ,
				},
			}
		},
		openInput: (mode, ctx) => {
			const captureId = replayCaptureOf(ctx.req)
			if (captureId === null || mode.decoderType === "rtl433") return null
			return port.openReplay(captureId, mode.decoderType)
		},
	}
}

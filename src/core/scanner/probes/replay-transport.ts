import type { Readable } from "node:stream"
import type { DecoderConfig } from "../../../decoders/types.js"
import {
	IQ_CAPTURE_RATE_HZ,
	IQ_REPLAY_MAX_PROBES,
	IQ_REPLAY_PROBE_CORES,
	REPLAY_INPUT_DECODERS,
	type IqCapturePort,
} from "../iq-capture-contract.js"
import { createChannelTransport } from "./channel-transport.js"
import type {
	ProbeDecoderType,
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
 * cf32 input format and the capture rate, so the audio pipeline starts at the FM demodulator and
 * rtl_433 reads the capture as it is (`-r cf32:-`, `-f` the channel centre).
 */
export function createReplayTransport(
	port: Pick<IqCapturePort, "openReplay"> &
		Partial<Pick<IqCapturePort, "replayRateOf">>,
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
			replayCaptureOf(ctx.req) !== null &&
			REPLAY_INPUT_DECODERS.has(mode.decoderType),
		configure: (base, ctx): DecoderConfig => {
			const configured = channel.configure(base, ctx)
			// The rate openReplay delivers: a faster capture's own rate for rtl433, else 48 kHz.
			const captureId = replayCaptureOf(ctx.req)
			let rate: number = IQ_CAPTURE_RATE_HZ
			if (
				captureId !== null &&
				port.replayRateOf &&
				REPLAY_INPUT_DECODERS.has(base.type)
			) {
				try {
					rate =
						port.replayRateOf(captureId, base.type as ProbeDecoderType) ?? rate
				} catch {
					// the safe answer: 48 kHz (a 48 kHz replay is what every older port gives)
				}
			}
			return {
				...configured,
				options: {
					...configured.options,
					inputIqFormat: "cf32",
					inputSampleRate: rate,
				},
			}
		},
		openInput: (mode, ctx) => {
			const captureId = replayCaptureOf(ctx.req)
			if (captureId === null || !REPLAY_INPUT_DECODERS.has(mode.decoderType))
				return null
			return port.openReplay(captureId, mode.decoderType)
		},
	}
}

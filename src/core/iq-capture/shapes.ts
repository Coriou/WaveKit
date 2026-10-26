/**
 * Replay shapes from the probe channel requests (WG11 req 6.7). Kept apart from the service:
 * `channel-transport.ts` pulls in the decoder adapters, so only the scanner service (which already bundles it) imports this.
 */
import { IQ_CAPTURE_RATE_HZ } from "../scanner/iq-capture-contract.js"
import { PROBE_CHANNEL_REQUESTS } from "../scanner/probes/channel-transport.js"
import {
	captureBandwidthHz,
	type IqReplayShape,
	type IqReplayShapes,
} from "./service.js"

/** The replay tool's narrowest transition (`wavekit-iqcap replay` refuses less). */
export const IQ_REPLAY_MIN_TRANSITION_HZ = 100

/**
 * The shape that keeps the whole capture passband: `bandwidthHz` and a transition up to the
 * capture's Nyquist edge, (48 000 − bandwidth) / 2 (288 Hz for the 47 424 Hz capture), so
 * bandwidth / 2 + transition = 24 000 Hz exactly, the replay tool's bound. A bandwidth that leaves
 * less than the 100 Hz minimum transition is narrowed to 48 000 − 200 = 47 800 Hz; a non-finite or
 * non-positive one gives null (no rtl433 replay).
 */
export function wholeCaptureShape(bandwidthHz: number): IqReplayShape | null {
	if (!Number.isFinite(bandwidthHz) || bandwidthHz <= 0) return null
	const maxBandwidth = IQ_CAPTURE_RATE_HZ - 2 * IQ_REPLAY_MIN_TRANSITION_HZ
	const bw = Math.min(bandwidthHz, maxBandwidth)
	return { bandwidthHz: bw, transitionHz: (IQ_CAPTURE_RATE_HZ - bw) / 2 }
}

export function probeReplayShapes(): IqReplayShapes {
	const shape = (t: "dsd-fme" | "multimon-ng" | "direwolf") => ({
		bandwidthHz: PROBE_CHANNEL_REQUESTS[t].bandwidthHz,
		transitionHz: PROBE_CHANNEL_REQUESTS[t].transitionHz,
	})
	const audio = {
		"dsd-fme": shape("dsd-fme"),
		"multimon-ng": shape("multimon-ng"),
		direwolf: shape("direwolf"),
	}
	// rtl_433 reads the capture as captured: its live channel (250 kHz) is wider than any capture.
	const rtl433 = wholeCaptureShape(captureBandwidthHz(audio))
	return Object.freeze(rtl433 ? { ...audio, rtl433 } : audio)
}

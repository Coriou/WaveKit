/**
 * Replay shapes from the probe channel requests (WG11 req 6.7). Kept apart from the service:
 * `channel-transport.ts` pulls in the decoder adapters, so only the scanner service (which already bundles it) imports this.
 */
import { IQ_CAPTURE_RATE_HZ } from "../scanner/iq-capture-contract.js"
import { PROBE_CHANNEL_REQUESTS } from "../scanner/probes/channel-transport.js"
import { wholeCaptureShapeAt } from "./rates.js"
import {
	captureBandwidthHz,
	type IqReplayShape,
	type IqReplayShapes,
} from "./service.js"

export { IQ_REPLAY_MIN_TRANSITION_HZ } from "./rates.js"

/** The whole-capture shape of a 48 kHz capture (`wholeCaptureShapeAt`). */
export function wholeCaptureShape(bandwidthHz: number): IqReplayShape | null {
	return wholeCaptureShapeAt(bandwidthHz, IQ_CAPTURE_RATE_HZ)
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
	// The ACARS channel: inside the capture passband (25 kHz of 47.4 kHz).
	const acarsdec = {
		bandwidthHz: PROBE_CHANNEL_REQUESTS.acarsdec.bandwidthHz,
		transitionHz: PROBE_CHANNEL_REQUESTS.acarsdec.transitionHz,
	}
	return Object.freeze({
		...audio,
		...(rtl433 ? { rtl433 } : {}),
		acarsdec,
		dumpvdl2: { bandwidthHz: 25_000, transitionHz: 5_000 },
		// 62.5 kHz pass edge + 12.5 kHz transition = 75 kHz < 96 kHz Nyquist.
		["lora-meshtastic"]: { bandwidthHz: 125_000, transitionHz: 12_500 },
	})
}

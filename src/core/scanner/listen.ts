/**
 * `POST /api/scanner/discoveries/:id/listen` strategies (spec § 12.1).
 * Pre-channelizer: retarget live audio's offsetHz inside the current window.
 * Task 46 adds the post-channelizer monitor strategy.
 */
import type { SourceCaps } from "../../config.js"
import type { LiveDemodulator } from "../live-demodulator.js"
import { WaveKitError } from "../../utils/errors.js"
import { ScannerApiError } from "./errors.js"
import type { Discovery } from "./types.js"

export interface ListenResult {
	mode: "live-audio" | "monitor"
	sourceId: string
	frequencyHz: number
	offsetHz?: number
	jobId?: string
	httpUrl: string
	wavUrl: string
}

export interface ListenContext {
	caps: SourceCaps | undefined
	usableHalfSpanHz: number
	liveDemod: Pick<LiveDemodulator, "getStatus" | "reconfigure" | "start"> | null
}

export type ListenStrategy = (
	discovery: Discovery,
	ctx: ListenContext,
) => Promise<ListenResult>

function outOfWindow(
	message: string,
	details: Record<string, unknown>,
): ScannerApiError {
	return new ScannerApiError(message, "OUT_OF_WINDOW", 409, details)
}

export const liveAudioListen: ListenStrategy = async (discovery, ctx) => {
	const demod = ctx.liveDemod
	if (!demod)
		throw new ScannerApiError(
			"Live audio is not configured",
			"LIVE_AUDIO_UNAVAILABLE",
			409,
		)
	const sourceId = discovery.sourceIds[0]
	const status = demod.getStatus()
	if (!sourceId || (status.sourceId !== "" && status.sourceId !== sourceId)) {
		throw outOfWindow("Live audio runs on another source", {
			liveSourceId: status.sourceId,
			sourceId,
		})
	}
	const centre = ctx.caps?.centerFreq
	if (centre === undefined)
		throw outOfWindow("The source centre is unknown", { sourceId })
	const offsetHz = Math.round(
		discovery.frequencyHz + discovery.measuredOffsetHz - centre,
	)
	if (Math.abs(offsetHz) > ctx.usableHalfSpanHz) {
		throw outOfWindow("The discovery is outside the current window", {
			offsetHz,
			usableHalfSpanHz: ctx.usableHalfSpanHz,
		})
	}
	// Active: reconfigure validates and restarts. Idle: reconfigure only stores the
	// config and start() validates the plan, so both sit in one try (live-demodulator.ts :262-270).
	const previousOffsetHz = status.config.offsetHz
	let stored = false
	try {
		await demod.reconfigure(
			status.sourceId === "" ? { offsetHz, sourceId } : { offsetHz },
		)
		stored = true
		if (!demod.getStatus().running) await demod.start()
	} catch (err) {
		if (
			err instanceof WaveKitError &&
			err.code === "CHANNEL_OFFSET_OUT_OF_RANGE"
		) {
			// An idle start rejected the stored offset: put the previous one back.
			if (stored) await demod.reconfigure({ offsetHz: previousOffsetHz })
			throw outOfWindow(err.message, { offsetHz })
		}
		throw err
	}
	const after = demod.getStatus()
	return {
		mode: "live-audio",
		sourceId,
		frequencyHz: discovery.frequencyHz,
		offsetHz,
		httpUrl: after.httpUrl,
		wavUrl: after.wavUrl,
	}
}

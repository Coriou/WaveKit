// Listen island logic (docs/web/canvas/Listen.dc.html; DESIGN.md "Audio follows tuning", "Squelch UX"). Pure.
import {
	LIVE_AUDIO_NOISE_QUIETING_DB,
	LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS,
	LIVE_AUDIO_TONE_SQUELCH_MODULATIONS,
} from "@wavekit/api-types"
import type { LiveAudioConfig, LiveAudioStatus } from "@wavekit/api-types"

import type { PcmFormat } from "./pcm.ts"

/** The squelch bar's scale, as the Listen board. */
export const LEVEL_MIN_DBFS = -120
export const LEVEL_MAX_DBFS = -20

/** A dBFS level on the bar, 0–1 (null and out-of-range values clamp). */
export function levelFraction(dbfs: number | null | undefined): number {
	if (dbfs === null || dbfs === undefined || !Number.isFinite(dbfs)) return 0
	const f = (dbfs - LEVEL_MIN_DBFS) / (LEVEL_MAX_DBFS - LEVEL_MIN_DBFS)
	return Math.min(1, Math.max(0, f))
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * A stream URL from the core made absolute and reachable from this page; null when missing or invalid.
 * The core sends a path or an absolute URL. A legacy core without `liveDemod.publicOrigin` advertises
 * `http://localhost:<port>`: right when the browser runs on the core's machine, wrong elsewhere. When
 * the page itself is not on a loopback host, a loopback stream host becomes the page's host (same
 * port and scheme): the page is served by, or next to, the core. Core audio answers CORS with `*`
 * (legacy) or the allowed origin (protected), so the page fetches it cross-origin directly.
 */
export function reachableAudioUrl(
	raw: string | undefined,
	base: string,
): string | null {
	if (!raw) return null
	let url: URL
	let page: URL
	try {
		url = new URL(raw, base)
		page = new URL(base)
	} catch {
		return null
	}
	if (
		(url.protocol === "http:" || url.protocol === "https:") &&
		LOOPBACK.has(url.hostname) &&
		!LOOPBACK.has(page.hostname)
	)
		url.hostname = page.hostname
	return url.toString()
}

/** The live stream as this page plays it: raw PCM (`httpUrl`) and the WAV fallback (`wavUrl`). */
export interface AudioStreamSource {
	httpUrl: string | null
	wavUrl: string | null
	format: PcmFormat
	rate: number
}

/** The stream to play; null while live audio is stopped or has no URL. `base`: the page's URL. */
export function audioSource(
	status: LiveAudioStatus | null,
	base: string,
): AudioStreamSource | null {
	if (!status?.running) return null
	const httpUrl = reachableAudioUrl(status.httpUrl, base)
	const wavUrl = reachableAudioUrl(status.wavUrl, base)
	if (!httpUrl && !wavUrl) return null
	return {
		httpUrl,
		wavUrl,
		format: status.config.audioFormat === "f32le" ? "f32le" : "s16le",
		rate: status.effectiveSampleRate,
	}
}

/**
 * When this key changes the player reattaches: a new stream URL, format or sample rate (the core ends
 * the stream on a rate change), or the pipeline coming up. Tuning is not part of it: the core's
 * stream already follows tuning (audio follows tuning), and a reattach costs the start-up latency.
 * Null means nothing to play.
 */
export function audioAttachKey(
	source: AudioStreamSource | null,
): string | null {
	if (!source) return null
	return `${source.httpUrl ?? ""}|${source.wavUrl ?? ""}|${source.format}|${source.rate}`
}

/**
 * Squelch the board's way: "Off" (0 opens it), "Auto", a manual threshold, or (WG7 cores, NFM and WFM)
 * "Noise": the FM quieting squelch, which needs no power threshold and opens on a carrier that was
 * already up when tuned (where Auto's floor starts on the carrier).
 */
export type SquelchSetting =
	| { kind: "off" }
	| { kind: "auto"; marginDb: number }
	| { kind: "manual"; thresholdDbfs: number }
	| { kind: "noise"; quietingDb: number }

export function squelchSetting(status: LiveAudioStatus | null): SquelchSetting {
	const c = status?.config
	if (!c) return { kind: "off" }
	if (c.squelchMode === "noise")
		return {
			kind: "noise",
			quietingDb: c.noiseQuietingDb ?? LIVE_AUDIO_NOISE_QUIETING_DB.default,
		}
	if (c.squelchMode === "auto")
		return { kind: "auto", marginDb: c.autoMarginDb ?? 6 }
	if (c.squelch === 0) return { kind: "off" }
	return { kind: "manual", thresholdDbfs: c.squelch }
}

/** The threshold to draw on the bar: the live one from level events, else the configured one. */
export function squelchThreshold(
	setting: SquelchSetting,
	liveThresholdDbfs: number | null,
): number | null {
	// noise mode gates on FM quieting; the core's thresholdDbfs is then only the stored `squelch`
	if (setting.kind === "off" || setting.kind === "noise") return null
	if (liveThresholdDbfs !== null) return liveThresholdDbfs
	return setting.kind === "manual" ? setting.thresholdDbfs : null
}

/** The noise squelch applies to this modulation (NFM and WFM). */
export function noiseSquelchFits(
	modulation: LiveAudioConfig["modulation"],
): boolean {
	return LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS.includes(modulation)
}

/**
 * What a modulation change must also send so the core accepts it: a WG7 core answers 400 when the
 * new modulation does not fit the noise squelch (NFM, WFM) or a tone squelch (NFM). Noise falls back
 * to Auto and the tone gate is cleared.
 */
export function squelchForModulation(
	config: LiveAudioConfig | undefined,
	modulation: LiveAudioConfig["modulation"],
): Partial<LiveAudioConfig> {
	const patch: Partial<LiveAudioConfig> = {}
	if (!config) return patch
	if (config.squelchMode === "noise" && !noiseSquelchFits(modulation)) {
		patch.squelchMode = "auto"
		patch.autoMarginDb = config.autoMarginDb ?? 6
	}
	if (
		config.toneSquelch !== undefined &&
		config.toneSquelch.kind !== "none" &&
		!LIVE_AUDIO_TONE_SQUELCH_MODULATIONS.includes(modulation)
	)
		patch.toneSquelch = { kind: "none" }
	return patch
}

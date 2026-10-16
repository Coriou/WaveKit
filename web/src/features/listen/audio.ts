// Listen island logic (docs/web/canvas/Listen.dc.html; DESIGN.md "Audio follows tuning", "Squelch UX"). Pure.
import type { LiveAudioStatus } from "@wavekit/api-types"

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

/** A URL from the core (it may send a path) made absolute; null when missing or invalid. */
function absolute(raw: string | undefined, base: string): string | null {
	if (!raw) return null
	try {
		return new URL(raw, base).toString()
	} catch {
		return null
	}
}

/** The live stream as this page plays it: raw PCM (`httpUrl`) and the WAV fallback (`wavUrl`). */
export interface AudioStreamSource {
	httpUrl: string | null
	wavUrl: string | null
	format: PcmFormat
	rate: number
}

/** The stream to play; null while live audio is stopped or has no URL. */
export function audioSource(
	status: LiveAudioStatus | null,
	base: string,
): AudioStreamSource | null {
	if (!status?.running) return null
	const httpUrl = absolute(status.httpUrl, base)
	const wavUrl = absolute(status.wavUrl, base)
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
export function audioAttachKey(source: AudioStreamSource | null): string | null {
	if (!source) return null
	return `${source.httpUrl ?? ""}|${source.wavUrl ?? ""}|${source.format}|${source.rate}`
}

/** Squelch the board's way: "Off" (0 opens it), "Auto", or a manual threshold. */
export type SquelchSetting =
	| { kind: "off" }
	| { kind: "auto"; marginDb: number }
	| { kind: "manual"; thresholdDbfs: number }

export function squelchSetting(status: LiveAudioStatus | null): SquelchSetting {
	const c = status?.config
	if (!c) return { kind: "off" }
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
	if (setting.kind === "off") return null
	if (liveThresholdDbfs !== null) return liveThresholdDbfs
	return setting.kind === "manual" ? setting.thresholdDbfs : null
}

// Listen island logic (docs/web/canvas/Listen.dc.html; DESIGN.md "Audio follows tuning", "Squelch UX"). Pure.
import type { LiveAudioStatus } from "@wavekit/api-types"

/** The squelch bar's scale, as the Listen board. */
export const LEVEL_MIN_DBFS = -120
export const LEVEL_MAX_DBFS = -20

/** A dBFS level on the bar, 0–1 (null and out-of-range values clamp). */
export function levelFraction(dbfs: number | null | undefined): number {
	if (dbfs === null || dbfs === undefined || !Number.isFinite(dbfs)) return 0
	const f = (dbfs - LEVEL_MIN_DBFS) / (LEVEL_MAX_DBFS - LEVEL_MIN_DBFS)
	return Math.min(1, Math.max(0, f))
}

/** Absolute stream URL (the core may send a path); null when live audio has none. */
export function streamUrl(
	status: LiveAudioStatus | null,
	base: string,
): string | null {
	const raw = status?.wavUrl
	if (!raw) return null
	try {
		return new URL(raw, base).toString()
	} catch {
		return null
	}
}

/**
 * When this key changes, the <audio> element reattaches to the stream: a new stream URL, a new
 * sample rate (the core ends the stream on a rate change), the pipeline coming up, or a new tuned
 * frequency (drops the audio the browser buffered for the old one: audio follows tuning).
 * Null means nothing to play.
 */
export function audioAttachKey(
	status: LiveAudioStatus | null,
	tunedHz: number | null,
	base: string,
): string | null {
	const url = streamUrl(status, base)
	if (!url || !status?.running) return null
	return `${url}|${status.effectiveSampleRate}|${tunedHz ?? ""}`
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

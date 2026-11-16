// Listen island logic (docs/web/canvas/Listen.dc.html; DESIGN.md "Audio follows tuning", "Squelch UX"). Pure.
import {
	LIVE_AUDIO_AUTO_ROUTE_RATE,
	LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS,
	LIVE_AUDIO_NOISE_SQUELCH_MODULATIONS,
	LIVE_AUDIO_TONE_SQUELCH_MODULATIONS,
	LIVE_AUDIO_VOICE_ONLY_DEFAULT,
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
	/** The core route it plays: `/auto` (auto-listen-route) or the live `/stream`; absent counts as `/stream`. */
	route?: "auto" | "stream"
	httpUrl: string | null
	wavUrl: string | null
	format: PcmFormat
	rate: number
	/**
	 * Send the session cookie to the audio port (a protected core: the stream is cross-origin and
	 * answers 401 without it). False on a legacy core, whose wildcard CORS refuses credentials.
	 */
	credentials: boolean
}

/**
 * The stream to play; null while live audio is stopped or has no URL. `base`: the page's URL;
 * `credentials`: the core is protected (see AudioStreamSource.credentials).
 */
export function audioSource(
	status: LiveAudioStatus | null,
	base: string,
	credentials = false,
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
		credentials,
	}
}

/** A decoded-voice stream (dsd-fme, s16le mono at the digital voice rate) as this page plays it. */
export function voiceSource(
	route: { httpUrl: string; wavUrl: string; rate: number },
	base: string,
	credentials = false,
): AudioStreamSource | null {
	const httpUrl = reachableAudioUrl(route.httpUrl, base)
	const wavUrl = reachableAudioUrl(route.wavUrl, base)
	if (!httpUrl && !wavUrl) return null
	return { httpUrl, wavUrl, format: "s16le", rate: route.rate, credentials }
}

/**
 * The core's auto listen route (`/auto`, auto-listen-route): one stream that plays the analog channel
 * or a decoded call, always 48 kHz s16le mono. Null while live audio is stopped or on cores without it.
 */
export function autoRouteSource(
	status: LiveAudioStatus | null,
	base: string,
	credentials = false,
): AudioStreamSource | null {
	const route = status?.running ? status.autoRoute : undefined
	if (!route) return null
	const httpUrl = reachableAudioUrl(route.httpUrl, base)
	const wavUrl = reachableAudioUrl(route.wavUrl, base)
	if (!httpUrl && !wavUrl) return null
	return {
		route: "auto",
		httpUrl,
		wavUrl,
		format: "s16le",
		rate: LIVE_AUDIO_AUTO_ROUTE_RATE,
		credentials,
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
	return `${source.httpUrl ?? ""}|${source.wavUrl ?? ""}|${source.format}|${source.rate}|${source.credentials ? "cred" : ""}`
}

/**
 * Squelch the Listen way (docs/web/DESIGN.md "Squelch UX"): `Auto` (carrier squelch at the floor plus
 * the margin and, on NFM with `voiceOnly`, the voice check), `Manual` (the threshold line) or `Open`
 * (everything plays). A core before the Listen contract (no `voiceOnly` in its config) has no `open`:
 * there `manual` at 0 reads as Open, and the deprecated `noise` reads as Auto without the voice check.
 */
export type SquelchSetting =
	| { kind: "auto"; marginDb: number; voiceOnly: boolean }
	| { kind: "manual"; thresholdDbfs: number }
	| { kind: "open" }

export type SquelchKind = SquelchSetting["kind"]

/** The core speaks the Listen contract: `open`, `voiceOnly` and `listenMode` (2026-11-15). */
export function listenContract(
	config: LiveAudioConfig | null | undefined,
): boolean {
	return (
		typeof config?.voiceOnly === "boolean" ||
		config?.listenMode !== undefined ||
		config?.squelchMode === "open"
	)
}

/** A tone squelch is set (a manual squelch at 0 with one is a tone-only squelch, not Open). */
function toneSet(config: LiveAudioConfig): boolean {
	return config.toneSquelch !== undefined && config.toneSquelch.kind !== "none"
}

export function squelchSetting(status: LiveAudioStatus | null): SquelchSetting {
	return squelchOf(status?.config)
}

/** squelchSetting() from a config alone; no config reads as Open (nothing is known to gate). */
export function squelchOf(
	c: LiveAudioConfig | null | undefined,
): SquelchSetting {
	if (!c) return { kind: "open" }
	if (c.squelchMode === "open") return { kind: "open" }
	if (c.squelchMode === "noise")
		return { kind: "auto", marginDb: c.autoMarginDb ?? 6, voiceOnly: false }
	if (c.squelchMode === "auto")
		return {
			kind: "auto",
			marginDb: c.autoMarginDb ?? 6,
			voiceOnly: c.voiceOnly ?? LIVE_AUDIO_VOICE_ONLY_DEFAULT,
		}
	// manual (or absent, as cores before WG7): 0 or above opens the power squelch
	if (!(c.squelch < 0))
		return toneSet(c)
			? { kind: "manual", thresholdDbfs: LEVEL_MIN_DBFS }
			: { kind: "open" }
	return { kind: "manual", thresholdDbfs: c.squelch }
}

/**
 * The squelch line the spectrum draws (plot/handles.ts): Manual only, the live threshold while running,
 * else the configured one. Auto moves by itself and Open has no threshold, so neither shows a line.
 */
export function squelchThreshold(
	setting: SquelchSetting,
	liveThresholdDbfs: number | null,
): number | null {
	if (setting.kind !== "manual") return null
	return liveThresholdDbfs ?? setting.thresholdDbfs
}

/** The threshold the Listen bar marks: Manual's, or Auto's live one (dragging it selects Manual); none when Open. */
export function meterThreshold(
	setting: SquelchSetting,
	liveThresholdDbfs: number | null,
): number | null {
	if (setting.kind === "open") return null
	if (setting.kind === "manual")
		return liveThresholdDbfs ?? setting.thresholdDbfs
	return liveThresholdDbfs
}

/** The Voice only switch applies: Auto on NFM (the voice check exists on NFM only), on a Listen core. */
export function voiceOnlyFits(
	config: LiveAudioConfig | null | undefined,
): boolean {
	return (
		!!config &&
		listenContract(config) &&
		LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS.includes(config.modulation)
	)
}

/**
 * Manual threshold bounds: the bar's −120 dBFS up to −1 dBFS. A manual squelch is always sent below 0:
 * 0 means Open (the core stores `manual` at 0 as `open`), so −1 is the highest level Manual sends.
 */
export const MANUAL_MIN_DBFS = LEVEL_MIN_DBFS
export const MANUAL_MAX_DBFS = -1
/** Manual with nothing better to start from (no level set, no live threshold). */
export const MANUAL_DEFAULT_DBFS = -60

/** A manual level the core takes as a threshold: whole dB in −120…−1; anything else is the default. */
export function manualLevel(dbfs: number | null | undefined): number {
	if (dbfs === null || dbfs === undefined || !Number.isFinite(dbfs))
		return MANUAL_DEFAULT_DBFS
	return Math.min(MANUAL_MAX_DBFS, Math.max(MANUAL_MIN_DBFS, Math.round(dbfs)))
}

/** Where Manual starts: the configured level when one is set, else the live threshold, else −60. */
export function manualStart(
	config: LiveAudioConfig | null | undefined,
	liveThresholdDbfs: number | null,
): number {
	if (config && config.squelch < 0) return manualLevel(config.squelch)
	return manualLevel(liveThresholdDbfs)
}

/**
 * The PATCH for a squelch choice. Send rules (the Listen contract): Auto always carries `voiceOnly`
 * (a core turns the voice check back on when it is missing), Manual a non-zero level, Open is
 * `squelchMode: "open"`. A core before the contract gets neither `voiceOnly` nor `open`: Open is
 * `manual` at 0 there, as before. Never touches `autoMarginDb` (Settings › More owns it).
 */
export function squelchPatch(
	config: LiveAudioConfig | null | undefined,
	choice:
		| { kind: "auto"; voiceOnly?: boolean }
		| { kind: "manual"; dbfs: number }
		| { kind: "open" },
): Partial<LiveAudioConfig> {
	const listen = listenContract(config)
	if (choice.kind === "manual")
		return { squelchMode: "manual", squelch: manualLevel(choice.dbfs) }
	if (choice.kind === "open")
		return listen
			? { squelchMode: "open" }
			: { squelchMode: "manual", squelch: 0 }
	if (!listen) return { squelchMode: "auto" }
	const keep =
		config?.squelchMode === "auto"
			? (config.voiceOnly ?? LIVE_AUDIO_VOICE_ONLY_DEFAULT)
			: LIVE_AUDIO_VOICE_ONLY_DEFAULT
	return { squelchMode: "auto", voiceOnly: choice.voiceOnly ?? keep }
}

/** A closed squelch to go back to from Open (`Q`): what was on before it. */
export type ClosedSquelch =
	| { kind: "auto"; voiceOnly: boolean }
	| { kind: "manual"; dbfs: number }

/** The closed squelch now, or null while Open. */
export function closedSquelch(setting: SquelchSetting): ClosedSquelch | null {
	if (setting.kind === "auto")
		return { kind: "auto", voiceOnly: setting.voiceOnly }
	if (setting.kind === "manual")
		return { kind: "manual", dbfs: setting.thresholdDbfs }
	return null
}

/**
 * The closed squelch to remember from a config, as `closedSquelch()`, except that a tone-only squelch
 * (manual at 0 or above with a tone gate, which reads as Manual at −120) keeps its stored level so going
 * back restores it exactly. Null while Open.
 */
export function closedSquelchOf(
	config: LiveAudioConfig | null | undefined,
): ClosedSquelch | null {
	const closed = closedSquelch(squelchOf(config))
	if (closed?.kind === "manual" && config && !(config.squelch < 0))
		return { kind: "manual", dbfs: config.squelch }
	return closed
}

/**
 * The PATCH back to a remembered closed squelch. A tone-only squelch goes back as it was stored (manual
 * at its level, 0 or above) while the tone gate is still set; without the gate that level would be Open,
 * so it goes back as the highest Manual level instead.
 */
export function closedPatch(
	config: LiveAudioConfig | null | undefined,
	back: ClosedSquelch,
): Partial<LiveAudioConfig> {
	if (back.kind === "auto")
		return squelchPatch(config, { kind: "auto", voiceOnly: back.voiceOnly })
	if (!(back.dbfs < 0) && config && toneSet(config))
		return { squelchMode: "manual", squelch: back.dbfs }
	return squelchPatch(config, { kind: "manual", dbfs: back.dbfs })
}

/**
 * `Q`: Open, or back from Open to `previous` (Auto with the voice check when nothing is known). Returns
 * the PATCH and the closed squelch to remember for the way back (null when going back).
 */
export function toggleOpenPatch(
	status: LiveAudioStatus | null,
	previous: ClosedSquelch | null,
): { patch: Partial<LiveAudioConfig>; remember: ClosedSquelch | null } {
	const config = status?.config
	const closed = closedSquelchOf(config)
	if (closed !== null)
		return { patch: squelchPatch(config, { kind: "open" }), remember: closed }
	const back = previous ?? {
		kind: "auto",
		voiceOnly: LIVE_AUDIO_VOICE_ONLY_DEFAULT,
	}
	return { patch: closedPatch(config, back), remember: null }
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

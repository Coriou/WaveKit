// The Listen panel's lower half (docs/web/canvas/Listen.dc.html): tone squelch, "What you hear", Sound
// (level control, de-emphasis, low-cut, noise reduction). Pure: the island reads and writes through these.
import { LIVE_AUDIO_TONE_SQUELCH_MODULATIONS } from "@wavekit/api-types"
import type {
	ActivitySummary,
	DecoderInfo,
	DigitalVoiceStatus,
	LiveAudioAutoRouteLevel,
	LiveAudioAutoSquelch,
	LiveAudioConfig,
	LiveAudioLevel,
	LiveAudioListenMode,
	LiveAudioStatus,
	LiveAudioToneSquelch,
} from "@wavekit/api-types"

import type { LiveAudioConfigPatch } from "../../data/live-audio-store.ts"
import { decodersAt } from "../tuned/decoders.ts"

// ---- Sound

export type AgcChoice = "off" | "slow" | "fast"
export type DeemphChoice = "off" | "50" | "75"

/** The modulation's own level control when none is set: fast for AM and SSB, off for FM. */
export function agcDefault(
	modulation: LiveAudioConfig["modulation"],
): AgcChoice {
	return ["am", "cw", "dsb", "usb", "lsb"].includes(modulation) ? "fast" : "off"
}

/** The level control in effect: the running chain's, else the configured one, else the default. */
export function agcOf(status: LiveAudioStatus): AgcChoice {
	return status.agc ?? status.config.agc ?? agcDefault(status.config.modulation)
}

export function deemphOf(config: LiveAudioConfig): DeemphChoice {
	return config.deEmphasis ? (config.deEmphasisTau === 50 ? "50" : "75") : "off"
}

export function deemphPatch(v: DeemphChoice): LiveAudioConfigPatch {
	return v === "off"
		? { deEmphasis: false }
		: { deEmphasis: true, deEmphasisTau: v === "50" ? 50 : 75 }
}

/** "Cut low rumble" switches the high-pass between off and 300 Hz (other cut-offs live in Settings). */
export const LOW_CUT_HZ = 300

export function lowCutSub(config: LiveAudioConfig): string {
	return config.highPass > 0
		? `High-pass at ${config.highPass} Hz`
		: `High-pass at ${LOW_CUT_HZ} Hz`
}

const NR_TEXT: Readonly<Record<LiveAudioConfig["noiseReduction"], string>> = {
	off: "Softens hiss between words",
	voice: "Softens hiss between words",
	"narrow-band": "Narrow band filter on",
	"noaa-apt": "NOAA APT filter on",
}

export function noiseReductionSub(config: LiveAudioConfig): string {
	return NR_TEXT[config.noiseReduction]
}

// ---- Tone squelch

/** A tone heard on the channel or set on the gate: CTCSS in tenths of a hertz, or a DCS code. */
export type HeardTone =
	| { kind: "ctcss"; frequencyTenthsHz: number }
	| { kind: "dcs"; code: string; polarity: "normal" | "inverted" }

/** "88.5 Hz", "DCS 023N". */
export function toneText(tone: HeardTone): string {
	return tone.kind === "ctcss"
		? `${(tone.frequencyTenthsHz / 10).toFixed(1)} Hz`
		: `DCS ${tone.code}${tone.polarity === "normal" ? "N" : "I"}`
}

export function sameTone(a: HeardTone | null, b: HeardTone | null): boolean {
	if (a === null || b === null) return a === b
	if (a.kind === "ctcss" && b.kind === "ctcss")
		return a.frequencyTenthsHz === b.frequencyTenthsHz
	if (a.kind === "dcs" && b.kind === "dcs")
		return a.code === b.code && a.polarity === b.polarity
	return false
}

/** The tone the core hears on the channel now (WG12 `LiveAudioStatus.tone`), or null when none was reported. */
export function liveTone(
	tone: LiveAudioStatus["tone"],
): HeardTone | null | undefined {
	if (tone === undefined) return undefined
	if (tone.ctcssHz !== null && tone.ctcssHz > 0)
		return { kind: "ctcss", frequencyTenthsHz: Math.round(tone.ctcssHz * 10) }
	if (tone.dcs) return { kind: "dcs", ...tone.dcs }
	return null
}

/** The tone of one analog transmission summary (fields `ctcssHz` 88.5, `dcs` "023N"), or null. */
export function toneOfSummary(s: ActivitySummary): HeardTone | null {
	if (s.kind !== "analog-transmission") return null
	for (const f of s.fields) {
		if (f.key === "ctcssHz" && typeof f.value === "number" && f.value > 0)
			return { kind: "ctcss", frequencyTenthsHz: Math.round(f.value * 10) }
		if (f.key === "dcs" && typeof f.value === "string") {
			const m = /^([0-7]{3})([NI])$/.exec(f.value.trim())
			if (m?.[1] && m[2])
				return {
					kind: "dcs",
					code: m[1],
					polarity: m[2] === "N" ? "normal" : "inverted",
				}
		}
	}
	return null
}

/**
 * The tone the panel offers: the one already on the gate, else the tone the core reports live (the
 * current or last transmission, WG12), else the tone of the latest transmission heard on the channel
 * (`items` newest first, already limited to the channel; cores before WG12).
 */
export function offeredTone(
	gate: LiveAudioToneSquelch | undefined,
	items: readonly ActivitySummary[],
	live?: LiveAudioStatus["tone"],
): HeardTone | null {
	if (gate && gate.kind !== "none") return gate
	const now = liveTone(live)
	if (now !== undefined) return now
	for (const s of items) {
		if (s.kind !== "analog-transmission") continue
		// the latest transmission decides: a toneless one means no tone to offer
		return toneOfSummary(s)
	}
	return null
}

/** Tone squelch applies to this modulation (NFM). */
export function toneSquelchFits(
	modulation: LiveAudioConfig["modulation"],
): boolean {
	return LIVE_AUDIO_TONE_SQUELCH_MODULATIONS.includes(modulation)
}

export function toneGateOn(config: LiveAudioConfig): boolean {
	return config.toneSquelch !== undefined && config.toneSquelch.kind !== "none"
}

export function toneSquelchPatch(
	on: boolean,
	tone: HeardTone,
): LiveAudioConfigPatch {
	return { toneSquelch: on ? tone : { kind: "none" } }
}

// ---- Source (the core's listenMode)

/** Where decoded voice for the tuned channel comes from: a dsd-fme decoder on it and its stream. */
export interface VoiceRoute {
	decoderId: string
	/** "DMR", "P25", or null while the decoder has not said. */
	protocol: string | null
	httpUrl: string
	wavUrl: string
	rate: number
	/** A call is on the air right now. */
	active: boolean
	/** "TG 2081 · radio 2081045" for the current or last call. */
	call: string | null
	/** The current call is encrypted; false while its encryption is not known yet. */
	encrypted: boolean
	/**
	 * False while the core has not learned whether the current call is encrypted
	 * (`encryptionKnown: false` on the call): show it as unknown, never as clear.
	 */
	encryptionKnown: boolean
}

const VOICE_TYPES = new Set(["dsd-fme"])

/**
 * The decoded-voice stream for the tuned channel: a running dsd-fme decoder with a target within
 * `toleranceHz` of `hz` and its stream in the digital voice status. Null when none.
 */
export function voiceRoute(
	decoders: readonly DecoderInfo[],
	voice: DigitalVoiceStatus | null,
	hz: number | null,
	toleranceHz: number,
): VoiceRoute | null {
	if (!voice?.enabled || hz === null) return null
	const on = decodersAt(
		decoders.filter(d => VOICE_TYPES.has(d.type) && d.running),
		hz,
		toleranceHz,
	)
	for (const d of on) {
		const stream = voice.decoders.find(s => s.decoderId === d.id)
		if (!stream) continue
		const call = stream.call ?? stream.lastCall ?? null
		const known = !encryptionUnknown(stream.call)
		return {
			decoderId: d.id,
			protocol: call?.protocol ? call.protocol.toUpperCase() : null,
			httpUrl: stream.httpUrl,
			wavUrl: stream.wavUrl,
			rate: voice.sampleRate,
			active: stream.call?.active === true,
			call: call ? callText(call) : null,
			encrypted: known && stream.call?.encrypted === true,
			encryptionKnown: known,
		}
	}
	return null
}

/**
 * Only a literal `encryptionKnown: false` means unknown: an absent, true or malformed field keeps
 * the call's `encrypted` as it is (cores before the field always knew it). Read locally so this
 * compiles with or without the field on the DTO.
 */
function encryptionUnknown(call: object | null | undefined): boolean {
	if (!call) return false
	return (call as { encryptionKnown?: unknown }).encryptionKnown === false
}

/**
 * The Listen head's line under a decoded call: "DMR voice · TG 2081 · radio 2081045", or
 * "DMR voice · checking…" while the call's encryption is not known yet (never shown as clear).
 */
export function voiceCallLine(
	protocol: string | null,
	route: VoiceRoute | null,
	fallback: string | null,
): string {
	const detail =
		route && !route.encryptionKnown ? "checking…" : (route?.call ?? fallback)
	return [`${protocol ?? "Digital"} voice`, detail].filter(Boolean).join(" · ")
}

/** Why a decoded call on the air does not play (see `heldCall`). */
export type HeldCall = "checking" | "encrypted"

/**
 * A decoded call on the air that the core's `/auto` holds: `checking` while its encryption is not known
 * yet, `encrypted` once known encrypted. The core never routes either (its `active` is never `digital`
 * then), so the head and Source read it from the call itself. Only where a call could play: Source not
 * Analog and the squelch not Open. Null otherwise.
 */
export function heldCall(input: {
	route: VoiceRoute | null
	source: ListenSource
	squelch?: "auto" | "manual" | "open"
}): HeldCall | null {
	const { route, source, squelch } = input
	if (!route?.active || source === "analog" || squelch === "open") return null
	if (!route.encryptionKnown) return "checking"
	return route.encrypted ? "encrypted" : null
}

/**
 * The line for an encrypted call: "DMR call is encrypted: nothing to play.", or, while the analog
 * channel plays anyway (`analogPlays`: the squelch passes it), "…: decoded voice is not played."
 */
export function encryptedCallLine(
	protocol: string | null,
	analogPlays: boolean,
): string {
	return `${protocol ?? "Digital voice"} call is encrypted: ${analogPlays ? "decoded voice is not played." : "nothing to play."}`
}

/**
 * The head's line for a held call: "DMR voice · checking…", "DMR call is encrypted: nothing to play.";
 * `analogPlays` (the head says Listening) for an encrypted call says decoded voice is not played instead.
 */
export function heldCallLine(
	held: HeldCall,
	protocol: string | null,
	route: VoiceRoute | null,
	analogPlays = false,
): string {
	return held === "checking"
		? voiceCallLine(protocol, route, null)
		: encryptedCallLine(protocol, analogPlays)
}

function callText(
	call: NonNullable<DigitalVoiceStatus["call"]>,
): string | null {
	const parts = [
		call.talkgroup !== null ? `TG ${call.talkgroup}` : null,
		call.source !== null ? `radio ${call.source}` : null,
	].filter((p): p is string => p !== null)
	return parts.length > 0 ? parts.join(" · ") : null
}

// ---- Auto listen route (the core's /auto)

/** What `/auto` plays now: the level event's selection (live), else the status's (fallback). */
export function autoRouteNow(
	status: LiveAudioStatus | null,
	level: LiveAudioLevel | null,
): LiveAudioAutoRouteLevel | null {
	const route = status?.running ? status.autoRoute : undefined
	if (!route) return null
	if (level?.autoRoute) return level.autoRoute
	return {
		active: route.active,
		...(route.protocol === undefined ? {} : { protocol: route.protocol }),
		...(route.reason === undefined ? {} : { reason: route.reason }),
	}
}

/** "DMR" from the route's protocol ("dmr"), else the decoder's, else null. */
export function routeProtocol(
	now: LiveAudioAutoRouteLevel | null,
	route: VoiceRoute | null,
): string | null {
	return now?.protocol ? now.protocol.toUpperCase() : (route?.protocol ?? null)
}

// ---- Evidence squelch (NFM auto squelch waits for voice or a tone)

/** The evidence gate's state: the level event's, else the status's; null on older cores or while stopped. */
export function autoSquelchNow(
	status: LiveAudioStatus | null,
	level: LiveAudioLevel | null,
): LiveAudioAutoSquelch | null {
	if (!status?.running) return null
	return level?.autoSquelch ?? status.autoSquelch ?? null
}

const EVIDENCE_TEXT: Readonly<
	Record<NonNullable<LiveAudioAutoSquelch["evidence"]>, string>
> = { voice: "Voice heard", ctcss: "CTCSS heard", dcs: "DCS heard" }

/** "Voice heard", "CTCSS heard": what let the voice check pass; null when it is off or holds the audio. */
export function evidenceText(gate: LiveAudioAutoSquelch | null): string | null {
	if (gate?.state !== "open") return null
	return gate.evidence ? EVIDENCE_TEXT[gate.evidence] : "Passing"
}

// ---- Source: what `/auto` plays (the core's `listenMode`, shared by every client)

export type ListenSource = LiveAudioListenMode

/** The Source in force on the core; `auto` on a core before the Listen contract or on a value it does not know. */
export function listenModeOf(
	config: LiveAudioConfig | null | undefined,
): ListenSource {
	const v = config?.listenMode
	return v === "analog" || v === "digital" ? v : "auto"
}

/** The line under Source, from what the core says `/auto` plays now. */
export function sourceHint(input: {
	mode: ListenSource
	now: LiveAudioAutoRouteLevel | null
	route: VoiceRoute | null
	modeLabel: string
}): string {
	const { mode, now, route, modeLabel } = input
	const what = routeProtocol(now, route)
	if (now?.reason === "squelch-open")
		return `Open plays the ${modeLabel} audio as it is.`
	if (now?.reason === "no-decoder")
		return "No digital voice decoder on this channel: nothing plays."
	if (now?.active === "digital")
		return `${what ?? "Digital voice"} call. Playing decoded voice.`
	const held = heldCall({ route, source: mode })
	if (held === "encrypted")
		return encryptedCallLine(what, now?.active === "analog")
	if (held === "checking")
		return `${what ?? "Digital voice"} call: checking it is not encrypted before it plays.`
	if (mode === "analog") return `Playing demodulated ${modeLabel} audio only.`
	if (mode === "digital")
		return `Decoded ${what ?? "digital"} voice only, silence between calls.`
	if (route)
		return `Playing ${modeLabel} audio, decoded ${what ?? "digital"} voice when a call comes.`
	return `Playing ${modeLabel} audio. Decoded voice when a decoder covers the channel.`
}

// ---- The Listen head: one line says what is heard

export type ListenHeadline =
	| { kind: "quiet"; title: "Quiet" }
	| { kind: "waiting"; title: "Waiting for voice" }
	| { kind: "open"; title: "Open" }
	| { kind: "listening"; title: "Listening" }

/**
 * The head's title while playing. `Open` for an open squelch (it stays on across retunes), `Waiting for
 * voice` while a carrier is up and the voice check holds it, `Listening` while audio passes (a decoded call
 * says `DMR voice · TG …` under it), else `Quiet`: nothing on the channel, a tone gate waiting, or Source
 * Digital between calls or with no decoder (a carrier plays nothing then).
 */
export function listenHeadline(input: {
	squelch: "auto" | "manual" | "open"
	carrier: boolean
	gate: LiveAudioAutoSquelch | null
	toneWaiting: boolean
	now: LiveAudioAutoRouteLevel | null
	/** The core's Source; Digital plays nothing but a decoded call. */
	source?: ListenSource
}): ListenHeadline {
	if (input.squelch === "open") return { kind: "open", title: "Open" }
	if (input.now?.active === "digital")
		return { kind: "listening", title: "Listening" }
	if (input.now?.reason === "no-decoder")
		return { kind: "quiet", title: "Quiet" }
	// Digital with no call: `/auto` plays silence whatever the carrier does
	if (input.source === "digital" && input.now?.active !== "analog")
		return { kind: "quiet", title: "Quiet" }
	if (input.toneWaiting) return { kind: "quiet", title: "Quiet" }
	if (input.carrier && input.gate?.state === "waiting")
		return { kind: "waiting", title: "Waiting for voice" }
	if (input.carrier) return { kind: "listening", title: "Listening" }
	return { kind: "quiet", title: "Quiet" }
}

// ---- The browser-side choice before the Listen contract

/** The per-browser "What you hear" key this web app used before Source became a core setting. */
export const LEGACY_HEAR_KEY = "wavekit.web.listen.hear"

/**
 * Drops the old per-browser choice: the key is read and removed, never sent. Source is shared by every
 * client now, so one stale browser must not change what everyone hears; the old "Decoded voice" also fell
 * back to analog, which Digital does not. A blocked storage is left alone.
 */
export function dropHearKey(
	storage: Pick<Storage, "getItem" | "removeItem"> | undefined,
): void {
	try {
		if (storage?.getItem(LEGACY_HEAR_KEY) !== null)
			storage?.removeItem(LEGACY_HEAR_KEY)
	} catch {
		// blocked storage: nothing to drop
	}
}

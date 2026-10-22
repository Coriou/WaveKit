// The Listen panel's lower half (docs/web/canvas/Listen.dc.html): tone squelch, "What you hear", Sound
// (level control, de-emphasis, low-cut, noise reduction). Pure: the island reads and writes through these.
import { LIVE_AUDIO_TONE_SQUELCH_MODULATIONS } from "@wavekit/api-types"
import type {
	ActivitySummary,
	DecoderInfo,
	DigitalVoiceStatus,
	LiveAudioConfig,
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

// ---- What you hear

export type HearChoice = "auto" | "analog" | "digital"

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
	encrypted: boolean
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
		return {
			decoderId: d.id,
			protocol: call?.protocol ? call.protocol.toUpperCase() : null,
			httpUrl: stream.httpUrl,
			wavUrl: stream.wavUrl,
			rate: voice.sampleRate,
			active: stream.call?.active === true,
			call: call ? callText(call) : null,
			encrypted: stream.call?.encrypted === true,
		}
	}
	return null
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

export type TransmissionKind = "analog" | "digital"

/** A live tone this recent, with the squelch open, belongs to the transmission on the air. */
export const LIVE_TONE_MS = 10_000

/**
 * Analog or digital, for the transmission on the air (Auto follows it): a decoded call now is digital; a
 * tone heard now is analog; otherwise the last transmission's proof (`last`, from the channel's latest
 * observation), or null when nothing says.
 */
export function transmissionKind(input: {
	route: VoiceRoute | null
	open: boolean
	tone: LiveAudioStatus["tone"]
	last: TransmissionKind | null
	now: number
}): TransmissionKind | null {
	if (input.route?.active) return "digital"
	const tone = input.tone
	if (input.open && tone && liveTone(tone)) {
		const at = Date.parse(tone.at)
		if (Number.isFinite(at) && input.now - at <= LIVE_TONE_MS) return "analog"
	}
	return input.last
}

/**
 * What plays: decoded voice when a voice decoder covers the channel and the choice allows it, else the
 * analog audio. Auto plays the analog audio when the transmission is analog (a shared channel). Decoded
 * voice with no decoder on the channel plays the analog audio rather than silence, and the hint says why.
 */
export function playsDigital(
	choice: HearChoice,
	route: VoiceRoute | null,
	kind: TransmissionKind | null = null,
): boolean {
	if (route === null || choice === "analog") return false
	return choice === "digital" || kind !== "analog"
}

/** The line under the choice, as the board words it. */
export function hearHint(
	choice: HearChoice,
	route: VoiceRoute | null,
	modeLabel: string,
	kind: TransmissionKind | null = null,
): string {
	if (playsDigital(choice, route, kind) && route) {
		const what = route.protocol ?? "Digital voice"
		return route.encrypted
			? `${what} call is encrypted: nothing to play.`
			: `${what} decoder on this channel. Playing decoded voice.`
	}
	if (choice === "analog") return `Playing demodulated ${modeLabel} audio.`
	if (route)
		return `This transmission is analog. Playing ${modeLabel} audio, back to ${route.protocol ?? "decoded voice"} when a call comes.`
	return `No digital voice decoder on this channel. Playing ${modeLabel} audio.`
}

const HEAR_KEY = "wavekit.web.listen.hear"

export function readHearChoice(): HearChoice {
	try {
		const v = globalThis.localStorage?.getItem(HEAR_KEY)
		return v === "analog" || v === "digital" ? v : "auto"
	} catch {
		return "auto"
	}
}

export function writeHearChoice(v: HearChoice): void {
	try {
		globalThis.localStorage?.setItem(HEAR_KEY, v)
	} catch {
		// storage blocked: the choice stays for this page only
	}
}

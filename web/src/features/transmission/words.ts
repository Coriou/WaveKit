// The one table that turns a transmission's codes into sentences, and the formatting every surface that leads to
// the Transmission view uses: the channel on its raster in MHz, local times (the date only when not today),
// durations in seconds, one rounded number per row with what it is relative to. A code the table lacks shows
// nothing in "What we know" and its raw value in Details.
import type {
	ActivitySummary,
	DecodeField,
	RecordingChangePayload,
	RecordingCut,
	RecordingSpeech,
} from "@wavekit/api-types"

import { clockText, dateText, sameDay } from "../display.ts"
import { channelMHz } from "../naming.ts"
import type { TransmissionTone } from "./contract.ts"
import { readTone } from "./contract.ts"

// ---- codes as sentences

/** Why the recorder kept a file (its finish reason code). */
export const KEPT_BY_WORDS: Readonly<Record<string, string>> = {
	"own-tone": "Speech heard over a tone",
	final: "Classed as FM voice when it ended",
	"prior-none": "Kept at once: nothing was known about this channel yet",
	"joined-decode": "A decode of this signal was heard with it",
	content: "Its sound measured as speech",
	held: "Held, then kept",
}

/** Why the store ended the file (facts `finish.cut`). */
export const FINISH_CUT_WORDS: Readonly<Record<string, string>> = {
	completed: "The transmission ended",
	"duration-limit":
		"Split: longer than the file limit, continues in the next part",
	"track-ended": "The transmission ended",
	"epoch-changed": "Cut: the receiver was retuned",
	"stream-changed": "Cut: the receiver's stream changed",
	"channel-invalidated": "Cut: the channel was no longer valid",
	"source-lost": "Cut: the receiver was lost",
	shutdown: "Cut: WaveKit stopped",
	"engine-failed": "Cut: the recorder failed",
	"discovery-deleted": "Cut: its discovery was deleted",
	cancelled: "Cut: the recording was cancelled",
}

/** Why the file ended early, as the catalogue item says it (RecordingCut). */
export const ITEM_CUT_WORDS: Readonly<Record<RecordingCut, string>> = {
	"scanner-moved": "Cut: the scanner moved on",
	"duration-rollover":
		"Split: longer than the file limit, continues in the next part",
	"source-lost": "Cut: the receiver was lost",
	shutdown: "Cut: WaveKit stopped",
}

/** Whether speech was heard (RecordingSpeech). */
export const SPEECH_WORDS: Readonly<Record<RecordingSpeech, string>> = {
	heard: "Speech heard",
	"not-heard": "No speech found",
	unchecked: "Speech not checked",
}

/** Why a live transmission closed (the live demodulator's closeReason). */
export const CLOSE_WORDS: Readonly<Record<string, string>> = {
	squelch: "The transmission ended",
	retune: "Cut: the receiver was retuned",
	config: "Cut: the listening settings changed",
	stopped: "Cut: listening stopped",
	"max-duration": "Split: longer than the longest transmission kept",
}

/** The sentence of `code` in `table`, or null when the table lacks it (Details shows the raw code). */
export function wordsFor(
	table: Readonly<Record<string, string>>,
	code: string | null | undefined,
): string | null {
	if (typeof code !== "string" || !Object.hasOwn(table, code)) return null
	return table[code] ?? null
}

// ---- tone

/** "CTCSS 88.5 Hz". */
export function ctcssText(hz: number): string {
	return `CTCSS ${hz.toFixed(1)} Hz`
}

/** "DCS 023": three digits, zero padded. */
export function dcsText(code: string): string {
	return `DCS ${code.padStart(3, "0")}`
}

/**
 * A raw facts tone as one value: "CTCSS 88.5 Hz", "DCS 023", "No tone heard" only when the tone is null (measured,
 * none), "Not measured" for an absent or unreadable one.
 */
export function toneText(raw: unknown): string {
	const tone = readTone(raw)
	if (tone === null) return "No tone heard"
	if (tone === undefined || tone === "malformed") return "Not measured"
	return tone.kind === "ctcss" ? ctcssText(tone.hz) : dcsText(tone.code)
}

/** Why a tone is not measured, one hint per reason (TransmissionTone["why"]). */
export const NOT_MEASURED_WORDS: Readonly<
	Record<NonNullable<TransmissionTone["why"]>, string>
> = {
	"no-facts": "This recording did not store its tone",
	malformed: "The stored tone could not be read",
	undetermined: "Too little audio, or the tone was not steady enough to tell",
	"no-record":
		"Its Activity record could not be read, so its tone reading is not known",
	"no-recording":
		"Its recording is not listed here, so its stored tone could not be read",
	"live-none": "Listening stored no tone reading for this live transmission",
}

/** A heard tone's value as one text; null when what it holds cannot be shown (not a finite Hz, not a DCS code). */
function heardText(t: TransmissionTone): string | null {
	const hz: unknown = t.ctcssHz
	if (typeof hz === "number" && Number.isFinite(hz)) return ctcssText(hz)
	const code: unknown = (t.dcs as { code?: unknown } | null)?.code
	if (typeof code === "string" && /^[0-7]{1,3}$/.test(code))
		return dcsText(code)
	return null
}

/**
 * The Tone row of a transmission: its value and, when it is not a plain value, a hint saying why. Anything it
 * cannot read is "Not measured" (the stored tone could not be read), never "No tone heard".
 */
export function toneRow(t: TransmissionTone): {
	value: string
	hint: string | null
} {
	const malformed = {
		value: "Not measured",
		hint: NOT_MEASURED_WORDS.malformed,
	}
	const raw: unknown = t
	if (raw === null || typeof raw !== "object") return malformed
	if (t.state === "heard") {
		const text = heardText(t)
		return text === null ? malformed : { value: text, hint: null }
	}
	if (t.state === "none")
		return {
			value: "No tone heard",
			hint:
				t.dcsChecked === true ? null : "This recorder does not check DCS codes",
		}
	if (t.state !== "not-measured") return malformed
	const why: unknown = t.why
	return {
		value: "Not measured",
		hint:
			typeof why === "string" && Object.hasOwn(NOT_MEASURED_WORDS, why)
				? NOT_MEASURED_WORDS[why as keyof typeof NOT_MEASURED_WORDS]
				: NOT_MEASURED_WORDS.undetermined,
	}
}

// ---- numbers, times, frequencies

/** "8 s", "1 min 12 s", "1 h 2 min": never milliseconds. */
export function durationWords(ms: number | null | undefined): string | null {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null
	const s = Math.round(ms / 1000)
	if (s < 60) return `${s} s`
	if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
	return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

/** "145.6125 MHz": the raster channel, four decimals, with its unit. */
export function channelText(hz: number | null | undefined): string | null {
	if (typeof hz !== "number" || !Number.isFinite(hz)) return null
	return `${channelMHz(hz)} MHz`
}

/** "17:30:21", or "12 Nov, 17:30:21" when it is not today, on the chosen clock; "" with no valid time. */
export function startText(
	iso: string | null | undefined,
	now: Date = new Date(),
): string {
	if (typeof iso !== "string" || !Number.isFinite(Date.parse(iso))) return ""
	const time = clockText(iso, { seconds: true })
	if (time === "") return ""
	return sameDay(iso, now) ? time : `${dateText(iso)}, ${time}`
}

/** "Strong, 24 dB over the noise": one rounded number, what it is relative to. */
export function signalText(snrDb: number | null | undefined): string | null {
	if (typeof snrDb !== "number" || !Number.isFinite(snrDb)) return null
	const db = Math.round(snrDb)
	const word = db >= 20 ? "Strong" : db >= 10 ? "Clear" : "Weak"
	return `${word}, ${db} dB over the noise`
}

/** "measured 145 612 753 Hz (+253 Hz)": the measured centre in whole Hz and its offset from the channel. */
export function measuredText(
	measuredHz: number,
	channelHz: number | null,
): string {
	const whole = Math.round(measuredHz)
	const spaced = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, " ")
	if (channelHz === null) return `measured ${spaced} Hz`
	const off = whole - Math.round(channelHz)
	const sign = off > 0 ? "+" : off < 0 ? "−" : "±"
	return `measured ${spaced} Hz (${sign}${Math.abs(off)} Hz)`
}

/** Why there is no audio, in one plain sentence (the Listen section's place). */
export const NO_AUDIO_WORDS: Readonly<Record<string, string>> = {
	deleted: "The recording was deleted",
	"not-listed": "Its recording is not listed on the receiver",
	"not-recorded": "Not recorded",
	encrypted: "Encrypted: not recorded",
	"refused:slots": "Not recorded: every recording slot was busy",
	"refused:cpu": "Not recorded: WaveKit was too busy",
}

// ---- Activity rows that are transmissions (the event detail's fields)

/** A field of a row's detail, in words (no unit: the value says it). */
function wordField(
	key: string,
	label: string,
	value: string | null,
): DecodeField[] {
	return value === null || value === "" ? [] : [{ key, label, value }]
}

/**
 * A kept recording's Activity record as the detail shows it: the channel on its raster, when its audio started
 * and how long it is. Ids, the measured Hz and the ISO times are expert data (recordingChangeDetails).
 */
export function recordingChangeFields(
	p: RecordingChangePayload,
): DecodeField[] {
	return [
		...wordField(
			"channel",
			"Channel",
			channelText(p.channel?.frequencyHz ?? p.frequencyHz),
		),
		...wordField("started", "Started", startText(p.observationStartedAt)),
		...wordField("duration", "Duration", durationWords(p.durationMs)),
		...wordField("kept", "Kept at", startText(p.finalizedAt)),
	]
}

/** The same from the list's row alone (before or without its stored record). */
export function recordingRowFields(s: ActivitySummary): DecodeField[] {
	const ms =
		s.recording?.durationMs ?? s.fields.find(f => f.key === "durationMs")?.value
	return [
		...wordField(
			"channel",
			"Channel",
			channelText(s.channel?.frequencyHz ?? s.frequencyHz),
		),
		...wordField(
			"duration",
			"Duration",
			durationWords(typeof ms === "number" ? ms : null),
		),
	]
}

/** The expert Details of a kept recording's record: every id and raw number, labelled, in a fixed order. */
export function recordingChangeDetails(
	p: RecordingChangePayload,
): { term: string; value: string }[] {
	const channelHz = p.channel?.frequencyHz ?? null
	const rows: [string, string | null][] = [
		["Recording", p.recordingId],
		["Discovery", p.discoveryId],
		["Owner discovery", p.channel?.discoveryId ?? null],
		["Observation", p.observationId],
		["Receiver", p.sourceId],
		[
			"Measured",
			p.frequencyHz !== null ? measuredText(p.frequencyHz, channelHz) : null,
		],
		["Channel Hz", channelHz !== null ? String(Math.round(channelHz)) : null],
		["Observation start (UTC)", p.observationStartedAt],
		["Kept (UTC)", p.finalizedAt],
		["Duration ms", String(p.durationMs)],
		["Change", p.change],
	]
	return rows
		.filter((r): r is [string, string] => r[1] !== null && r[1] !== "")
		.map(([term, value]) => ({ term, value }))
}

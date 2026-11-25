// The one table that turns a transmission's codes into sentences, and the formatting every surface that leads to
// the Transmission view uses: the channel on its raster in MHz, local times (the date only when not today),
// durations in seconds, one rounded number per row with what it is relative to. A code the table lacks shows
// nothing in "What we know" and its readable form in Details (humanCode: never the raw code).
import type {
	ActivitySummary,
	DecodeField,
	RecordingChangePayload,
	RecordingCut,
	RecordingSpeech,
} from "@wavekit/api-types"

import { clockText, dateText, sameDay } from "../display.ts"
import { formatDb, formatMHz } from "../format.ts"
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

/** "DCS 023": three digits, zero padded; "DCS 023 inverted" for an inverted reading (normal and unknown say none). */
export function dcsText(code: string, polarity?: unknown): string {
	const text = `DCS ${code.padStart(3, "0")}`
	return polarity === "inverted" ? `${text} inverted` : text
}

/**
 * A raw facts tone as one value: "CTCSS 88.5 Hz", "DCS 023", "No tone heard" only when the tone is null (measured,
 * none), "Not measured" for an absent or unreadable one.
 */
export function toneText(raw: unknown): string {
	const tone = readTone(raw)
	if (tone === null) return "No tone heard"
	if (tone === undefined || tone === "malformed") return "Not measured"
	return tone.kind === "ctcss"
		? ctcssText(tone.hz)
		: dcsText(tone.code, tone.polarity)
}

/** Why a tone is not measured, one hint per reason (TransmissionTone["why"]). */
export const NOT_MEASURED_WORDS: Readonly<
	Record<Exclude<NonNullable<TransmissionTone["why"]>, "not-stored">, string>
> = {
	"no-facts": "This recording did not store its tone",
	malformed: "The stored tone could not be read",
	undetermined: "Not determined for this recording",
	"no-record":
		"Its Activity record could not be read, so its tone reading is not known",
	"no-recording":
		"Its recording is not listed here, so its stored tone could not be read",
	"live-none":
		"The live demodulator stores no tone when the audio was too short, the detector failed, or the core predates the check",
}

/** A tone the recorder kept the file for (`keptBy` "own-tone") without storing which. */
export const TONE_NOT_STORED = "A tone was heard (not stored)"

/** A heard tone's value as one text; null when what it holds cannot be shown (not a finite Hz, not a DCS code). */
function heardText(t: TransmissionTone): string | null {
	const hz: unknown = t.ctcssHz
	if (typeof hz === "number" && Number.isFinite(hz)) return ctcssText(hz)
	const dcs = t.dcs as { code?: unknown; polarity?: unknown } | null
	const code: unknown = dcs?.code
	if (typeof code === "string" && /^[0-7]{1,3}$/.test(code))
		return dcsText(code, dcs?.polarity)
	return null
}

/**
 * The Tone row of a transmission: its value and, when it is not a plain value, a hint saying why. Anything it
 * cannot read is "Not measured" (the stored tone could not be read), never "No tone heard": that comes only from
 * the recorder's stored null (a `none` from any other source reads as not measured).
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
		if (t.why === "not-stored" && t.ctcssHz === null && t.dcs === null)
			return { value: TONE_NOT_STORED, hint: null }
		const text = heardText(t)
		return text === null ? malformed : { value: text, hint: null }
	}
	if (t.state === "none" && t.from !== "recorder")
		return { value: "Not measured", hint: NOT_MEASURED_WORDS["live-none"] }
	// The recorder's stored null rules DCS out too: it checks every valid DCS code (a non-standard one reads absent),
	// and an older core stored null only for an empty sub-audible band, which a DCS code fills. It rules out the
	// standard CTCSS tones (67.0-254.1 Hz), not a non-standard tone under 67 Hz (docs/API.md).
	if (t.state === "none") return { value: "No tone heard", hint: null }
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

/**
 * "145.612753 MHz (+253 Hz)": the measured centre in MHz as the app writes frequencies (formatMHz), and its offset
 * from the channel in whole Hz (kHz past 10 kHz). The row's label says it is measured: the value never repeats it.
 */
export function measuredText(
	measuredHz: number,
	channelHz: number | null,
): string {
	const whole = Math.round(measuredHz)
	const mhz = `${formatMHz(whole)} MHz`
	if (channelHz === null) return mhz
	const off = whole - Math.round(channelHz)
	const sign = off > 0 ? "+" : off < 0 ? "−" : "±"
	const size = Math.abs(off)
	const amount =
		size >= 10_000
			? `${(size / 1000).toFixed(1)} kHz`
			: `${String(size).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} Hz`
	return `${mhz} (${sign}${amount})`
}

/** "−12.3 dB": one decimal, a true minus; null when not a finite number. */
export function dbText(db: number | null | undefined): string | null {
	if (typeof db !== "number" || !Number.isFinite(db)) return null
	return `${formatDb(db, 1)} dB`
}

/** "−41.2 dBFS": one decimal, a true minus; null when not a finite number. */
export function dbfsText(db: number | null | undefined): string | null {
	if (typeof db !== "number" || !Number.isFinite(db)) return null
	return `${formatDb(db, 1)} dBFS`
}

/** "12 %": a 0..1 share as a whole percentage; null when not a finite number. */
export function shareText(share: number | null | undefined): string | null {
	if (typeof share !== "number" || !Number.isFinite(share)) return null
	return `${Math.round(share * 100)} %`
}

/** "25 Nov 2026, 17:30:21" on the chosen clock (Settings › Display); "" with no valid time. */
export function dateTimeText(iso: string | null | undefined): string {
	if (typeof iso !== "string" || !Number.isFinite(Date.parse(iso))) return ""
	const date = dateText(iso, {
		day: "numeric",
		month: "short",
		year: "numeric",
	})
	const time = clockText(iso, { seconds: true })
	return date === "" || time === "" ? "" : `${date}, ${time}`
}

/** "2026-11-25 16:30:21 UTC": the same instant in UTC, for the tooltip and the secondary line. */
export function utcText(iso: string | null | undefined): string {
	if (typeof iso !== "string") return ""
	const ms = Date.parse(iso)
	if (!Number.isFinite(ms)) return ""
	return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`
}

/**
 * A code nobody wrote a sentence for, in a safe readable form: "offRaster" → "Off raster", "prior-none" →
 * "Prior none", "duration_limit" → "Duration limit". Only letters, digits and spaces survive, at most 60
 * characters; "Unknown" when nothing does.
 */
export function humanCode(code: string | null | undefined): string {
	if (typeof code !== "string") return "Unknown"
	const words = code
		.slice(0, 120)
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[^A-Za-z0-9]+/g, " ")
		.trim()
		.toLowerCase()
		.slice(0, 60)
		.trim()
	if (words === "") return "Unknown"
	return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The sentence of `code` in the first table that has it, else its readable form; null with no code. */
export function codeText(
	code: string | null | undefined,
	...tables: readonly Readonly<Record<string, string>>[]
): string | null {
	if (typeof code !== "string" || code === "") return null
	for (const table of tables) {
		const words = wordsFor(table, code)
		if (words !== null) return words
	}
	return humanCode(code)
}

/** What an observation's signal flag says (the scanner's measurement flags). */
export const FLAG_WORDS: Readonly<Record<string, string>> = {
	overload: "Receiver overloaded",
	gap: "Gap in the stream",
	offRaster: "Off the channel raster",
	obwBiased: "Bandwidth estimate biased",
	adjacentLeak: "Leak from an adjacent channel",
	suspectedIntermod: "Suspected intermodulation",
	edge: "At the edge of the band",
}

/** What the view could not read any more (TransmissionDto.gone). */
export const GONE_WORDS: Readonly<Record<string, string>> = {
	activity: "Activity record",
	observation: "Observation",
	discovery: "Discovery",
	audio: "Audio file",
}

/** Who measured the tone (TransmissionTone.from). */
export const TONE_FROM_WORDS: Readonly<Record<string, string>> = {
	recorder: "measured by the recorder",
	"live-demod": "measured live while listening",
}

/** The recording admission's numbers and codes, labelled and rounded (Details only). */
export function admissionRows(
	a: Readonly<Record<string, unknown>> | null,
): { term: string; value: string }[] {
	if (a === null) return []
	const num = (k: string): number | null => {
		const v = a[k]
		return typeof v === "number" && Number.isFinite(v) ? v : null
	}
	const str = (k: string): string | null => {
		const v = a[k]
		return typeof v === "string" && v !== "" ? v : null
	}
	const count = (k: string): string | null => {
		const v = num(k)
		return v === null ? null : String(Math.round(v))
	}
	const hz = num("frequencyHz")
	const rows: [string, string | null][] = [
		["Decision", codeText(str("reason"))],
		["Strength", codeText(str("strength"))],
		["Branch", codeText(str("branch"))],
		["Frequency", hz === null ? null : `${formatMHz(hz)} MHz`],
		["Level spread", dbText(num("spreadDb"))],
		["Top spread", dbText(num("topSpreadDb"))],
		["Quiet level (10th percentile)", dbfsText(num("p10Dbfs"))],
		["Loud level", dbfsText(num("loudLevelDbfs"))],
		["Periodic share", shareText(num("periodicShare"))],
		["Loud pitch share", shareText(num("loudPitchShare"))],
		["Level frames", count("levelFrames")],
		["Burst frames", count("burstFrames")],
	]
	return rows
		.filter((r): r is [string, string] => r[1] !== null)
		.map(([term, value]) => ({ term, value }))
}

/**
 * An id cut into the pieces it may wrap between: after each separator (`~ : _ - . /`), so a long key breaks at
 * its token boundaries, never mid-token (a token longer than the line still breaks, as a last resort).
 */
export function idSegments(id: string): string[] {
	return id.split(/(?<=[~:_\-./])/).filter(x => x !== "")
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

/** The label of a kept file's observation start: its transmission's, never the file's own. */
export const TRANSMISSION_STARTED = "Transmission started"

/** A field of a row's detail, in words (no unit: the value says it). */
function wordField(
	key: string,
	label: string,
	value: string | null,
): DecodeField[] {
	return value === null || value === "" ? [] : [{ key, label, value }]
}

/**
 * A kept recording's Activity record as the detail shows it: the channel on its raster, when its transmission
 * started, how long the file is and when it was kept. The record holds no start of the file itself: its
 * observationStartedAt is the transmission's (a second over or a later part of the same session shares it), so it
 * is labelled as such and never passed off as the file's. Ids, the measured Hz and the ISO times are expert data
 * (recordingChangeDetails).
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
		...wordField(
			"transmissionStarted",
			TRANSMISSION_STARTED,
			startText(p.observationStartedAt),
		),
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

// ---- copies (the same audio heard again on another frequency)

/** A copy's exact frequency ("156.9137 MHz"): a ghost sits off its raster, so it is never snapped to a channel. */
export function copyHzText(hz: number | null | undefined): string | null {
	if (typeof hz !== "number" || !Number.isFinite(hz)) return null
	return `${formatMHz(hz)} MHz`
}

/** An original's row for one copy: "Also heard on 156.9137 MHz (copy)". */
export function alsoHeardText(hz: number | null | undefined): string {
	const f = copyHzText(hz)
	return f === null
		? "Also heard on another frequency (copy)"
		: `Also heard on ${f} (copy)`
}

/** A copy's link to its original: "Copy of 156.8 MHz", "Copy of the original recording". */
export function copyOfText(hz: number | null | undefined): string {
	const f = copyHzText(hz)
	return f === null ? "Copy of the original recording" : `Copy of ${f}`
}

/** "and 3 more copies" past the listed ones; null when every copy is listed. */
export function moreCopiesText(total: number, listed: number): string | null {
	const more = total - listed
	if (!(more > 0)) return null
	return `and ${more} more ${more === 1 ? "copy" : "copies"}`
}

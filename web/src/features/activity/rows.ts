// Activity row anatomy (Activity board): type tile, title and time, a subtitle (protocol and who), then
// the message in full (up to three lines) or the readings. Pure functions over ActivitySummary.
import type {
	ActivityCategory,
	ActivitySummary,
	DecodeField,
} from "@wavekit/api-types"
import type { CategoryName } from "@wavekit/brand/react"

import { formatMHz } from "../format.ts"

export interface RowView {
	icon: CategoryName | null
	title: string
	subtitle: string
	/** The message or transcript; null when the event carries none. */
	message: string | null
	/** Readings line ("36 000 ft · 452 kn · 284°"); null when none. */
	readings: string | null
	/** An ingestion gap or another notice row, drawn as a quiet divider. */
	notice: boolean
}

const MESSAGE_KEYS = new Set([
	"message",
	"text",
	"msg",
	"transcript",
	"body",
	"comment",
])
const WORD = /[\p{L}\p{N}]+/gu
const TONE_KEYS = new Set(["ctcss", "ctcssHz", "dcs"])
/** Fields the subtitle names (who), in preference order. */
const WHO_KEYS = [
	"talkgroup",
	"tg",
	"source",
	"radio",
	"capcode",
	"address",
	"mmsi",
	"icao",
	"callsign",
	"flight",
	"model",
	"id",
	"channel",
	"function",
	"type",
]

const KIND_TEXT: Partial<Record<ActivitySummary["kind"], string>> = {
	"analog-transmission": "Analog voice",
	"call-lifecycle": "Call",
	"scanner-result": "Scanner",
	"recording-change": "Recording",
}

const CATEGORY_ICON: Record<ActivityCategory, CategoryName | null> = {
	aircraft: "aircraft",
	marine: "marine",
	"aviation-data": "aviation-data",
	voice: "voice",
	paging: "paging",
	aprs: "aprs",
	sensors: "sensors",
	mesh: "mesh",
	other: null,
}

const GAP_REASON: Record<string, string> = {
	"rate-limited": "too many at once",
	"queue-full": "the store was busy",
	"write-failed": "a write failed",
	"store-paused": "the store was paused",
}

const groupNumber = (n: number): string =>
	Math.abs(n) >= 10_000
		? n.toLocaleString("en-GB").replace(/,/g, " ")
		: String(n)

/** "18.4 °C", "36 000 ft", "Yes". Only measurements (with a unit) get digit groups: identifiers stay as sent. */
export function fieldText(f: DecodeField): string {
	const v =
		typeof f.value === "number"
			? f.unit
				? groupNumber(Math.round(f.value * 100) / 100)
				: String(f.value)
			: typeof f.value === "boolean"
				? f.value
					? "Yes"
					: "No"
				: (f.value ?? "—")
	if (!f.unit) return String(v)
	return f.unit === "°" || f.unit === "%"
		? `${v}${f.unit === "%" ? " %" : "°"}`
		: `${v} ${f.unit}`
}

/** A reading in the row: measurements as "452 kn", bare numbers with their label ("Slot 1"), flags by name. */
function readingText(f: DecodeField): string | null {
	if (typeof f.value === "boolean") return f.value ? f.label : null
	return !f.unit && typeof f.value === "number"
		? `${f.label} ${fieldText(f)}`
		: fieldText(f)
}

export function protocolText(s: ActivitySummary): string | null {
	if (s.protocol && s.protocol !== "analog")
		return s.protocol.toUpperCase().replace(/_/g, " ")
	return KIND_TEXT[s.kind] ?? null
}

export function rowView(s: ActivitySummary): RowView {
	if (s.kind === "ingestion-gap") {
		const dropped = s.fields.find(f => f.key === "dropped")?.value
		// The core titles gaps "Ingestion gap (<reason>)".
		const reason =
			s.fields.find(f => f.key === "reason")?.value ??
			/\(([a-z-]+)\)/.exec(s.title ?? "")?.[1]
		return {
			icon: null,
			title:
				typeof dropped === "number"
					? `${dropped} event${dropped === 1 ? "" : "s"} not kept`
					: "Some events were not kept",
			subtitle:
				typeof reason === "string"
					? `Activity skipped them: ${GAP_REASON[reason] ?? reason}`
					: "Activity skipped some decodes",
			message: null,
			readings: null,
			notice: true,
		}
	}
	if (s.kind === "analog-transmission") return analogView(s)
	const message = s.fields.find(
		f =>
			MESSAGE_KEYS.has(f.key) &&
			typeof f.value === "string" &&
			f.value.length > 0,
	)
	// Who sent it, unless the title already names it (DMR titles carry the talkgroup).
	const titleWords = new Set((s.title ?? "").toLowerCase().match(WORD) ?? [])
	const inTitle = (f: DecodeField) => {
		const words = String(f.value).toLowerCase().match(WORD) ?? []
		return words.length > 0 && words.every(w => titleWords.has(w))
	}
	const named = s.fields.filter(
		f => WHO_KEYS.includes(f.key) && f.value !== null && inTitle(f),
	)
	const who = WHO_KEYS.map(k => s.fields.find(f => f.key === k)).find(
		f => f !== undefined && f.value !== null && !inTitle(f),
	)
	const used = new Set([message?.key, who?.key, ...named.map(f => f.key)])
	const tone = s.fields.find(f => TONE_KEYS.has(f.key))
	if (tone) used.add(tone.key)
	const sub = [
		protocolText(s),
		who ? `${who.label} ${fieldText(who)}` : null,
		tone ? `${tone.label} ${fieldText(tone)}` : null,
	].filter((p): p is string => p !== null && p.length > 0)
	if (sub.length < 2 && s.frequencyHz !== null)
		sub.push(`${formatMHz(s.frequencyHz)} MHz`)
	const readings = s.fields
		.filter(f => !used.has(f.key) && !MESSAGE_KEYS.has(f.key))
		.map(readingText)
		.filter((r): r is string => r !== null)
		.slice(0, 4)
	return {
		icon: CATEGORY_ICON[s.category],
		title: s.title ?? s.entityKey ?? protocolText(s) ?? "Event",
		subtitle: sub.join(" · "),
		message: message ? String(message.value) : null,
		readings: readings.length > 0 ? readings.join(" · ") : null,
		notice: false,
	}
}

/** "9 s", "1 min 12 s". */
export function durationText(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000))
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

/** An analog transmission (core summary: durationMs, modulation, ctcssHz, dcs, dtmf). */
function analogView(s: ActivitySummary): RowView {
	const field = (key: string) => s.fields.find(f => f.key === key)
	const mod = field("modulation")?.value
	const tone = s.fields.find(f => TONE_KEYS.has(f.key))
	const ms = field("durationMs")?.value
	const secs = field("duration")?.value
	const dtmf = field("dtmf")?.value
	const duration =
		typeof ms === "number"
			? durationText(ms)
			: typeof secs === "number"
				? durationText(secs * 1000)
				: null
	return {
		icon: "voice",
		title:
			s.title ??
			(s.frequencyHz !== null
				? `${formatMHz(s.frequencyHz)} MHz`
				: "Transmission"),
		subtitle: [
			typeof mod === "string" ? mod.toUpperCase() : null,
			"Analog voice",
			tone ? `${tone.label} ${fieldText(tone)}` : null,
		]
			.filter((p): p is string => p !== null)
			.join(" · "),
		message: null,
		readings:
			[duration, typeof dtmf === "string" ? `DTMF ${dtmf}` : null]
				.filter((p): p is string => p !== null)
				.join(" · ") || null,
		notice: false,
	}
}

/** "14:02" in local time. */
export function timeText(iso: string): string {
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return ""
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** The group a row sits under: "Just now" for the last minute, else its minute, else its day. */
export function groupLabel(iso: string, now: number): string {
	const t = Date.parse(iso)
	if (!Number.isFinite(t)) return ""
	if (now - t < 60_000) return "Just now"
	const d = new Date(t)
	const today = new Date(now)
	if (d.toDateString() === today.toDateString()) return timeText(iso)
	return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${timeText(iso)}`
}

export type ListEntry =
	| { type: "group"; key: string; label: string }
	| { type: "row"; key: string; item: ActivitySummary }

/** Flattens a newest-first list into group headers and rows. */
export function listEntries(
	items: readonly ActivitySummary[],
	now: number,
): ListEntry[] {
	const out: ListEntry[] = []
	let last = ""
	for (const item of items) {
		const label = groupLabel(item.producedAt, now)
		if (label !== last) {
			out.push({ type: "group", key: `g:${item.eventId}`, label })
			last = label
		}
		out.push({ type: "row", key: item.eventId, item })
	}
	return out
}

/** A first height guess per entry, refined by measurement. */
export function estimateHeight(entry: ListEntry): number {
	if (entry.type === "group") return 28
	const v = rowView(entry.item)
	let h = 62
	if (v.message !== null)
		h += Math.min(3, Math.ceil(v.message.length / 44)) * 19
	if (v.readings !== null) h += 19
	return h
}

/** A first height guess for an event shown as its message card (Cards layout), refined by measurement. */
export function estimateCardHeight(entry: ListEntry): number {
	if (entry.type === "group") return 28
	const v = rowView(entry.item)
	let h = 150
	if (v.message !== null) h += Math.ceil(v.message.length / 40) * 22
	if (entry.item.fields.length > 0)
		h += Math.ceil(entry.item.fields.length / 3) * 44
	return h + 8
}

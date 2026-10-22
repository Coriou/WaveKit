// One card anatomy for every decoded message (Decode board): protocol and time, a title and who sent it, the message
// in full, readings as a grid, a position, the frequency and the stored JSON. Pure functions over the Activity summary
// and, when loaded, its stored record.
import type {
	ActivityRecord,
	ActivitySummary,
	DecodeField,
	DecodePosition,
	JsonValue,
} from "@wavekit/api-types"
import type { CategoryName } from "@wavekit/brand/react"

import { clockText } from "../display.ts"
import { formatWidth } from "../format.ts"
import { fieldText, protocolText, rowView } from "../activity/rows.ts"
import { bearing, distanceKm, relativeText } from "../map/geo.ts"
import { mergeFields } from "./humanize.ts"

export interface MessageBadge {
	label: string
	variant: "accent" | "amber" | "neutral"
}

export interface MessageView {
	icon: CategoryName | null
	/** Header label: "POCSAG 1200", "VDL2 · CPDLC", "NFM voice". */
	protocol: string
	badges: MessageBadge[]
	/** "14:02:39" local. */
	time: string
	title: string
	/** Talkgroups read large, in the heading face. */
	large: boolean
	sub: string
	text: string | null
	/** Machine text (ACARS, CPDLC, numeric pages, DTMF) in the mono face. */
	mono: boolean
	/** A page with no body. */
	toneOnly: boolean
	fields: DecodeField[]
	position: DecodePosition | null
	frequencyHz: number | null
	/** The Map item this message belongs to (`a:<ICAO>`, `v:<MMSI>`, `p:<APRS key>`, `m:<node>`), or null. */
	mapId: string | null
	/** What the JSON toggle shows: the decoded data, else the stored payload. */
	raw: JsonValue | null
	notice: boolean
}

const MESSAGE_KEYS = new Set([
	"message",
	"text",
	"msg",
	"transcript",
	"body",
	"comment",
	"payload",
])
const PROTOCOL_NAMES: Readonly<Record<string, string>> = {
	dmr: "DMR",
	p25: "P25",
	p25p1: "P25",
	p25p2: "P25 phase 2",
	ysf: "YSF",
	nxdn: "NXDN",
	dstar: "D-STAR",
	pocsag: "POCSAG",
	flex: "FLEX",
	ais: "AIS",
	aprs: "APRS",
	ism: "rtl_433",
	rtl_433: "rtl_433",
	rtl433: "rtl_433",
	wmbus: "wM-Bus",
	acars: "ACARS",
	vdl2: "VDL2",
	meshtastic: "Meshtastic",
	adsb: "ADS-B",
	"adsb-1090": "ADS-B",
	uat: "UAT",
	dtmf: "DTMF",
	lora: "LoRa",
}
/** Decoders the core presents in full: their raw JSON is long and adds noise to the grid. */
const FULLY_PRESENTED = new Set([
	"aircraft",
	"marine",
	"voice",
	"aviation-data",
	"mesh",
])

/** Fields the card never repeats in the grid (they are badges or the message). */
const BADGE_KEYS = new Set(["encrypted"])

function isRecord(
	v: JsonValue | undefined,
): v is { readonly [k: string]: JsonValue } {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Every field of the stored record (the summary keeps only the first few). */
export function recordFields(record: ActivityRecord): DecodeField[] {
	switch (record.kind) {
		case "decoder-reception":
			return [...record.payload.fields]
		case "analog-transmission": {
			const p = record.payload
			const out: DecodeField[] = [
				{
					key: "duration",
					label: "Duration",
					value: Math.round(p.durationMs / 100) / 10,
					unit: "s",
				},
				{ key: "modulation", label: "Mode", value: p.modulation.toUpperCase() },
				{ key: "bandwidth", label: "Width", value: formatWidth(p.bandwidthHz) },
				{ key: "squelch", label: "Squelch", value: p.squelchMode },
			]
			if (p.peakChannelPowerDbfs !== null)
				out.push({
					key: "peak",
					label: "Peak",
					value: Math.round(p.peakChannelPowerDbfs * 10) / 10,
					unit: "dBFS",
				})
			if (p.tone?.ctcssHz != null)
				out.push({
					key: "ctcss",
					label: "CTCSS",
					value: p.tone.ctcssHz,
					unit: "Hz",
				})
			if (p.tone?.dcs)
				out.push({
					key: "dcs",
					label: "DCS",
					value: `${p.tone.dcs.code} ${p.tone.dcs.polarity}`,
				})
			if (p.tone?.dtmf)
				out.push({ key: "dtmf", label: "DTMF", value: p.tone.dtmf })
			out.push({ key: "closed", label: "Ended by", value: p.closeReason })
			return out
		}
		case "ingestion-gap": {
			const p = record.payload
			return [
				{ key: "dropped", label: "Not kept", value: p.dropped },
				{ key: "reason", label: "Reason", value: p.reason },
				{ key: "decoders", label: "Decoders", value: p.decoderIds.join(", ") },
			]
		}
		default:
			return []
	}
}

/** A summary rebuilt from the stored record (an event opened by its id, with no list row to come from). */
export function summaryOfRecord(record: ActivityRecord): ActivitySummary {
	const base = {
		eventId: record.eventId,
		commitSeq: record.commitSeq,
		kind: record.kind,
		producedAt: record.producedAt,
		receivedAt: record.receivedAt,
		fields: recordFields(record),
	}
	switch (record.kind) {
		case "decoder-reception": {
			const p = record.payload
			return {
				...base,
				decoderId: p.decoderId,
				sourceId: p.provenance.sourceId,
				protocol: p.protocol,
				category: p.category,
				frequencyHz: p.provenance.frequency?.hz ?? null,
				entityKey: p.entityKey,
				title: p.title,
				...(p.position ? { position: p.position } : {}),
			}
		}
		case "analog-transmission":
			return {
				...base,
				decoderId: null,
				sourceId: record.payload.sourceId,
				protocol: "analog",
				category: "voice",
				frequencyHz: record.payload.frequency?.hz ?? null,
				entityKey: null,
				title: null,
			}
		default:
			return {
				...base,
				decoderId: null,
				sourceId: null,
				protocol: null,
				category: "other",
				frequencyHz: null,
				entityKey: null,
				title: null,
			}
	}
}

/** The decoded JSON behind the card: decodedData for a reception, the payload otherwise. */
export function rawOf(record: ActivityRecord | null): JsonValue | null {
	if (!record) return null
	if (record.kind === "decoder-reception") return record.payload.decodedData
	return record.payload as unknown as JsonValue
}

/** The Map item an Activity entity key stands for, when the Map shows that kind. */
export function mapIdOf(entityKey: string | null): string | null {
	if (!entityKey) return null
	const at = entityKey.indexOf(":")
	if (at <= 0) return null
	const kind = entityKey.slice(0, at)
	const value = entityKey.slice(at + 1)
	if (value === "") return null
	switch (kind) {
		case "icao":
			return `a:${value.toUpperCase()}`
		case "mmsi":
			return `v:${value}`
		case "callsign":
		case "aprs-object":
		case "aprs-item":
			return `p:${entityKey}`
		case "node":
			return `m:${value}`
		default:
			return null
	}
}

/** "POCSAG 1200", "VDL2 · CPDLC", "APRS weather". */
export function protocolLabel(
	s: ActivitySummary,
	data: JsonValue | undefined,
): string {
	const key = (s.protocol ?? "").toLowerCase()
	let name = PROTOCOL_NAMES[key] ?? protocolText(s) ?? "Decoded"
	if (isRecord(data)) {
		const wire = data["protocol"]
		const baud =
			typeof wire === "string"
				? /^(POCSAG|FLEX)[\s_-]?(\d{3,4})$/i.exec(wire)
				: null
		if (baud?.[1] && baud[2]) name = `${baud[1].toUpperCase()} ${baud[2]}`
		const app = data["app"]
		if (typeof app === "string" && app.length > 0 && app.length <= 12)
			name = `${name} · ${app}`
		if (key === "aprs" && isRecord(data["weather"])) name = "APRS weather"
	}
	return name
}

/** rtl_433 sends `battery_ok` as 1 or 0. */
function batteryWord(f: DecodeField): DecodeField {
	if (f.key !== "battery_ok" || typeof f.value === "string") return f
	return { ...f, value: f.value === 1 || f.value === true ? "OK" : "Low" }
}

function timeOf(iso: string): string {
	return clockText(iso, { seconds: true })
}

const MACHINE_TEXT = /^[\d\s*#\-+().,:/U[\]]+$/

function isMono(protocol: string, text: string | null): boolean {
	if (text === null) return false
	const p = protocol.toLowerCase()
	if (p.startsWith("acars") || p.startsWith("vdl2") || p.startsWith("dtmf"))
		return true
	return MACHINE_TEXT.test(text)
}

function encryptedOf(
	fields: readonly DecodeField[],
	data: JsonValue | undefined,
): boolean {
	if (fields.some(f => f.key === "encrypted" && f.value === true)) return true
	return isRecord(data) && data["encrypted"] === true
}

const WORDS = /[\p{L}\p{N}]+/gu

/** True when every word of the value is in the text ("2081045" in "TG 2081 · radio 2081045"). */
function said(f: DecodeField, text: string): boolean {
	const words = String(f.value).toLowerCase().match(WORDS) ?? []
	if (words.length === 0) return false
	const have = new Set(text.toLowerCase().match(WORDS) ?? [])
	return words.every(w => have.has(w))
}

export function messageView(
	item: ActivitySummary,
	record: ActivityRecord | null = null,
): MessageView {
	const row = rowView(item)
	const raw = rawOf(record)
	const data = raw ?? undefined
	const coreFields = record ? recordFields(record) : [...item.fields]
	const analog = item.kind === "analog-transmission"
	const notice = row.notice

	let protocol: string
	let sub: string
	if (analog) {
		const mod = coreFields.find(f => f.key === "modulation")?.value
		protocol = `${typeof mod === "string" ? mod.toUpperCase() : "Analog"} voice`
		sub = row.subtitle
			.split(" · ")
			.filter(
				p =>
					p !== "Analog voice" &&
					p !== (typeof mod === "string" ? mod.toUpperCase() : ""),
			)
			.join(" · ")
	} else if (notice) {
		protocol = "Activity"
		sub = row.subtitle
	} else {
		protocol = protocolLabel(item, data)
		const lead = protocolText(item)
		sub = row.subtitle
			.split(" · ")
			.filter((p, i) => !(i === 0 && p === lead) && !/^\d+\.\d+ MHz$/.test(p))
			.join(" · ")
	}

	const encrypted = encryptedOf(coreFields, data)
	const badges: MessageBadge[] = []
	if (encrypted) badges.push({ label: "Encrypted", variant: "amber" })
	if ((item.protocol ?? "").toLowerCase() === "ais" && isRecord(data)) {
		const t = data["msgType"] ?? data["messageType"] ?? data["type"]
		if (typeof t === "number")
			badges.push({ label: `Type ${t}`, variant: "neutral" })
	}

	const text = row.message
	const extra = !FULLY_PRESENTED.has(item.category) || item.protocol === null
	const said_ = `${row.title} · ${sub}`
	const fields = mergeFields(coreFields, analog ? undefined : data, extra)
		.map(batteryWord)
		.filter(f => {
			if (BADGE_KEYS.has(f.key)) return false
			if (
				MESSAGE_KEYS.has(f.key) &&
				typeof f.value === "string" &&
				f.value === text
			)
				return false
			if (text !== null && f.value === text) return false
			// the header already says "NFM voice"
			if (analog && f.key === "modulation") return false
			// identifiers already in the title or subtitle; readings (with a unit) always stay
			if (!f.unit && typeof f.value !== "boolean" && said(f, said_))
				return false
			return true
		})

	const position =
		item.position ??
		(record?.kind === "decoder-reception"
			? (record.payload.position ?? null)
			: null)

	return {
		icon: row.icon,
		protocol,
		badges,
		time: timeOf(item.producedAt),
		title: row.title,
		large: !notice && !analog && item.category === "voice",
		sub,
		text,
		mono: isMono(protocol, text),
		toneOnly:
			!notice &&
			item.category === "paging" &&
			text === null &&
			!protocol.startsWith("DTMF"),
		fields,
		position,
		frequencyHz: item.frequencyHz,
		mapId: mapIdOf(item.entityKey),
		raw,
		notice,
	}
}

/** "48.7312° N  3.4627° W". */
export function positionText(p: DecodePosition): string {
	const lat = `${Math.abs(p.lat).toFixed(4)}° ${p.lat >= 0 ? "N" : "S"}`
	const lon = `${Math.abs(p.lon).toFixed(4)}° ${p.lon >= 0 ? "E" : "W"}`
	return `${lat}  ${lon}`
}

/** The position preview: the station in the middle, the message on its bearing at a fixed radius (the distance is written). */
export function positionPlot(
	station: { lat: number; lon: number } | null,
	p: DecodePosition,
	radiusPx = 30,
): { dx: number; dy: number; from: string | null } {
	if (!station) return { dx: 0, dy: 0, from: null }
	const km = distanceKm(station, p)
	if (km < 0.05) return { dx: 0, dy: 0, from: "At the station" }
	const b = (bearing(station, p) * Math.PI) / 180
	return {
		dx: Math.round(Math.sin(b) * radiusPx * 10) / 10,
		dy: Math.round(-Math.cos(b) * radiusPx * 10) / 10,
		from: relativeText(station, p),
	}
}

export { fieldText }

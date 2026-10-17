// The tuned card's "now" block and its earlier rows (docs/web/canvas/Tuned.dc.html INFO, DESIGN.md "Tuned card
// reworked"): one anatomy, a content per kind. call: talkgroup large, the radio below, encrypted with a lock. tx: the
// last analog transmission, its time and length, its tone. count: vessels or aircraft in range, the latest report
// and a message-rate sparkline. msg: who or what in bold, the message in full (three lines at most), readings as
// chips. audio: broadcast FM with nothing to decode. plain: nothing heard yet (the card's band and channel block).
// Pure functions over the Activity heard on the channel.
import type { ActivitySummary, DecodeField } from "@wavekit/api-types"

import { fieldText, rowView } from "../activity/rows.ts"
import { formatMHz } from "../format.ts"
import { messageView } from "../messages/card.ts"

export type NowKind = "call" | "tx" | "count" | "msg" | "audio" | "plain"

export interface NowChip {
	/** Quiet label before the value ("Battery"); empty when the value says it all ("18.4 °C"). */
	k: string
	v: string
}

export interface EarlierRow {
	id: string
	/** "14:02". */
	time: string
	a: string
	b: string
	item: ActivitySummary
}

export interface NowView {
	kind: NowKind
	/** Header protocol ("POCSAG 1200", "NFM voice"); null keeps the card's own. */
	protocol: string | null
	/** Small label over the block ("Last transmission", "Vessels in range"). */
	eyebrow: string | null
	/** msg: who or what, in bold ("Capcode 1234567 · alpha"). */
	title: string | null
	big: string | null
	bigUnit: string | null
	locked: boolean
	line: string | null
	body: string | null
	mono: boolean
	/** The body is a quote (a transcript). */
	quote: boolean
	chips: NowChip[]
	/** count: "22 msg/min" and 30 bars over the last minute (0–1, oldest first). */
	rate: string | null
	rateBars: number[] | null
	/** The state line while nothing is live ("Listening · last page 38 s ago"); null: the card decides. */
	quiet: string | null
	/** The minimised line's identity ("DMR · TG 2081"). */
	shortId: string
	/** The Map item of the latest message (APRS, mesh, a vessel, an aircraft), or null. */
	mapId: string | null
	/** The kind has a map (fleets, APRS, mesh). */
	map: boolean
	latest: ActivitySummary | null
	earlier: EarlierRow[]
}

export interface FleetCount {
	fleet: "aircraft" | "vessels"
	/** Entities the core tracks now. */
	n: number
}

export interface NowInput {
	/** Activity on the channel, newest first. */
	items: readonly ActivitySummary[]
	/** Decoder types that listen on the channel (running first). */
	decoderTypes: readonly string[]
	/** Live demodulator mode ("nfm", "wfm"), or null. */
	modulation: string | null
	/** The band plan's mode here ("wfm" in the FM broadcast band), or null. */
	bandMode?: string | null
	/** The band plan's channel name here ("Ch 16"), or null. */
	channelName: string | null
	hz: number
	count: FleetCount | null
	/** Squelch open or a signal over the floor right now. */
	live: boolean
	now: number
	/** Earlier rows to show (two on the floating card). */
	earlierMax?: number
}

const SHOWN_KINDS = new Set<ActivitySummary["kind"]>([
	"decoder-reception",
	"call-lifecycle",
	"analog-transmission",
])
const AIRCRAFT_DECODERS = new Set(["readsb", "dump1090"])
const VESSEL_DECODERS = new Set(["ais-catcher"])
const VOICE_DECODERS = new Set(["dsd-fme"])
const TRANSCRIPT_KEYS = new Set(["transcript", "transcription"])
const TONE_LABEL: Readonly<Record<string, string>> = {
	ctcssHz: "CTCSS",
	ctcss: "CTCSS",
	dcs: "DCS",
}
const NOUN: Readonly<Record<string, string>> = {
	paging: "page",
	"aviation-data": "message",
	aprs: "packet",
	sensors: "reading",
	mesh: "message",
	marine: "report",
	aircraft: "report",
	voice: "call",
	other: "message",
}

/** "38 s ago", "3 min ago", "at 13:52". */
export function agoText(iso: string, now: number): string {
	const t = Date.parse(iso)
	if (Number.isNaN(t)) return ""
	const s = Math.max(0, Math.round((now - t) / 1000))
	if (s < 60) return `${s} s ago`
	if (s < 3600) return `${Math.floor(s / 60)} min ago`
	return `at ${hhmm(t)}`
}

function pad(n: number): string {
	return String(n).padStart(2, "0")
}
function hhmm(t: number): string {
	const d = new Date(t)
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function hhmmss(t: number): string {
	const d = new Date(t)
	return `${hhmm(t)}:${pad(d.getSeconds())}`
}
/** "0:08", "1:12". */
function clock(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000))
	return `${Math.floor(s / 60)}:${pad(s % 60)}`
}

function fieldOf(s: ActivitySummary, keys: readonly string[]) {
	return s.fields.find(f => keys.includes(f.key) && f.value !== null)
}

function durationMs(s: ActivitySummary): number | null {
	const ms = fieldOf(s, ["durationMs"])?.value
	if (typeof ms === "number") return ms
	const secs = fieldOf(s, ["duration", "durationS"])?.value
	return typeof secs === "number" ? secs * 1000 : null
}

function toneChip(s: ActivitySummary): NowChip | null {
	const f = s.fields.find(x => TONE_LABEL[x.key] && x.value !== null)
	if (!f) return null
	const k = TONE_LABEL[f.key] ?? f.label
	return { k, v: f.key === "dcs" ? String(f.value) : fieldText(f) }
}

function transcriptOf(s: ActivitySummary): string | null {
	const f = s.fields.find(x => TRANSCRIPT_KEYS.has(x.key))
	return typeof f?.value === "string" && f.value.trim() ? f.value.trim() : null
}

/** Readings as chips: measurements by value alone, the rest with their label; short ones only, three at most. */
export function chipsOf(fields: readonly DecodeField[], max = 3): NowChip[] {
	const chip = (f: DecodeField): NowChip | null => {
		if (f.value === null) return null
		const v = fieldText(f)
		if (v.length > 22) return null
		return f.unit ? { k: "", v } : { k: f.label, v }
	}
	const withUnit = fields.filter(f => f.unit)
	const rest = fields.filter(f => !f.unit)
	return [...withUnit, ...rest]
		.map(chip)
		.filter((c): c is NowChip => c !== null)
		.slice(0, max)
}

function clip(text: string, n: number): string {
	return text.length > n ? `${text.slice(0, n - 1)}…` : text
}

/** The value adds nothing to the text ("F4ABC-9" beside "F4ABC-9 · mobile"). */
function said(value: string, text: string): boolean {
	return value === "" || text.toLowerCase().includes(value.toLowerCase())
}

function earlierRow(s: ActivitySummary): EarlierRow {
	const row = rowView(s)
	const ms = durationMs(s)
	const b =
		s.kind === "analog-transmission" || s.kind === "call-lifecycle"
			? ms !== null
				? clock(ms)
				: ""
			: (row.readings ?? row.message ?? "")
	const a = s.kind === "analog-transmission" ? "Transmission" : row.title
	const first = b.split(" · ")[0] ?? ""
	return {
		id: s.eventId,
		time: hhmm(Date.parse(s.producedAt)),
		a,
		b: clip(said(first, a) ? "" : first, 20),
		item: s,
	}
}

/** Per-2 s message counts over the last minute (30 bars, oldest first), scaled to the busiest. */
function rateOf(
	items: readonly ActivitySummary[],
	now: number,
): { perMin: number; bars: number[] } {
	const bars = new Array<number>(30).fill(0)
	let perMin = 0
	for (const s of items) {
		const age = now - Date.parse(s.receivedAt)
		if (!(age >= 0 && age < 60_000)) continue
		perMin += 1
		const i = 29 - Math.floor(age / 2000)
		bars[i] = (bars[i] ?? 0) + 1
	}
	const top = Math.max(1, ...bars)
	return { perMin, bars: bars.map(b => b / top) }
}

function fleetOf(
	input: NowInput,
	latest: ActivitySummary | null,
): "aircraft" | "vessels" | null {
	if (input.count) return input.count.fleet
	if (input.decoderTypes.some(t => AIRCRAFT_DECODERS.has(t))) return "aircraft"
	if (input.decoderTypes.some(t => VESSEL_DECODERS.has(t))) return "vessels"
	if (latest?.category === "aircraft") return "aircraft"
	if (latest?.category === "marine") return "vessels"
	return null
}

const EMPTY: Omit<NowView, "kind" | "shortId" | "latest" | "earlier"> = {
	protocol: null,
	eyebrow: null,
	title: null,
	big: null,
	bigUnit: null,
	locked: false,
	line: null,
	body: null,
	mono: false,
	quote: false,
	chips: [],
	rate: null,
	rateBars: null,
	quiet: null,
	mapId: null,
	map: false,
}

export function nowView(input: NowInput): NowView {
	const items = input.items.filter(s => SHOWN_KINDS.has(s.kind))
	const latest = items[0] ?? null
	const earlier = items.slice(1, 1 + (input.earlierMax ?? 2)).map(earlierRow)
	const fleet = fleetOf(input, latest)
	const base = { latest, earlier }

	if (fleet) {
		const n = input.count?.n ?? null
		const noun = fleet === "aircraft" ? "aircraft" : "vessels"
		const rate = rateOf(items, input.now)
		const row = latest ? rowView(latest) : null
		const proto = fleet === "aircraft" ? "ADS-B" : "AIS"
		return {
			...EMPTY,
			...base,
			kind: "count",
			protocol: latest ? messageView(latest).protocol : proto,
			eyebrow: fleet === "aircraft" ? "Aircraft in range" : "Vessels in range",
			big: n === null ? "—" : String(n),
			bigUnit: noun,
			line: row
				? `Latest: ${[row.title, ...(row.readings ?? "").split(" · ").slice(0, 2)].filter(Boolean).join(" · ")}`
				: "No report yet",
			rate: `${rate.perMin} msg/min`,
			rateBars: rate.bars,
			quiet: latest
				? `${input.now - Date.parse(latest.receivedAt) < 60_000 ? "Receiving" : "Listening"} · last report ${agoText(latest.receivedAt, input.now)}`
				: "Listening · no report yet",
			shortId: n === null ? proto : `${proto} · ${n} ${noun}`,
			mapId: latest ? messageView(latest).mapId : null,
			map: true,
		}
	}

	if (!latest) {
		if (
			(input.modulation === "wfm" || input.bandMode === "wfm") &&
			input.decoderTypes.length === 0
		)
			return {
				...EMPTY,
				...base,
				kind: "audio",
				protocol: "WFM",
				eyebrow: "Broadcast FM",
				big: formatMHz(input.hz),
				bigUnit: "MHz",
				line: "No decoder for this signal. Audio only.",
				quiet: input.live ? "Audio" : "Audio only",
				shortId: "Broadcast FM",
			}
		const voice = input.decoderTypes.some(t => VOICE_DECODERS.has(t))
		return {
			...EMPTY,
			...base,
			kind: "plain",
			quiet:
				input.decoderTypes.length > 0
					? `Listening · no ${voice ? "call" : "message"} yet`
					: null,
			shortId: "",
		}
	}

	const view = messageView(latest)
	const at = Date.parse(latest.producedAt)
	const ago = agoText(latest.producedAt, input.now)

	if (latest.kind === "analog-transmission") {
		const ms = durationMs(latest)
		const transcript = transcriptOf(latest)
		const tone = toneChip(latest)
		const big = input.channelName ?? "Analog voice"
		return {
			...EMPTY,
			...base,
			kind: "tx",
			protocol: view.protocol,
			eyebrow: input.live ? "Transmission" : "Last transmission",
			big,
			line: [hhmmss(at), ms === null ? null : clock(ms)]
				.filter(Boolean)
				.join(" · "),
			body: transcript === null ? null : `“${transcript}”`,
			quote: transcript !== null,
			chips: tone ? [tone] : [],
			quiet: `Quiet · last heard ${ago}`,
			shortId: `${view.protocol} · ${big}`,
		}
	}

	const voice = latest.kind === "call-lifecycle" || latest.category === "voice"
	if (voice) {
		const locked = view.badges.some(b => b.label === "Encrypted")
		const ms = durationMs(latest)
		const tone = toneChip(latest)
		const text = view.text ?? transcriptOf(latest)
		// the core titles calls "TG 2081 · radio 2081045": the talkgroup is the title, the radio the line below
		const [talkgroup = view.title, ...rest] = view.title.split(" · ")
		const from = rest.join(" · ")
		const line = [
			from && (/^radio /i.test(from) ? `From ${from}` : from),
			view.sub,
		]
			.filter(Boolean)
			.join(" · ")
		return {
			...EMPTY,
			...base,
			kind: "call",
			protocol: view.protocol,
			big: talkgroup,
			line: line || null,
			locked,
			body: locked
				? "Encrypted. There is no audio to play or record."
				: text === null
					? null
					: `“${text}”`,
			quote: !locked && text !== null,
			chips: tone ? [tone] : [],
			quiet: `Quiet · last call ${hhmm(at)}${ms === null ? "" : ` · ${clock(ms)}`}`,
			shortId: `${view.protocol} · ${talkgroup}`,
			mapId: view.mapId,
			map: view.mapId !== null,
		}
	}

	const noun = NOUN[latest.category] ?? "message"
	return {
		...EMPTY,
		...base,
		kind: "msg",
		protocol: view.protocol,
		title: [view.title, view.sub].filter(Boolean).join(" · "),
		body: view.toneOnly ? "Tone only" : view.text,
		mono: view.mono,
		chips: chipsOf(view.fields),
		quiet: `Listening · last ${noun} ${ago}`,
		shortId: `${view.protocol} · ${view.title}`,
		mapId: view.mapId,
		map: view.mapId !== null,
	}
}

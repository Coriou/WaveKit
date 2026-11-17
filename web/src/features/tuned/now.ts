// The tuned card's "now" block and its earlier rows (docs/web/canvas/Tuned.dc.html INFO, DESIGN.md "Tuned card
// reworked"): one anatomy, a content per kind. call: talkgroup large, the radio below, encrypted with a lock. tx: the
// last analog transmission, its time and length, its tone. count: vessels or aircraft in range, the latest report
// and a message-rate sparkline. msg: who or what in bold, the message in full (three lines at most), readings as
// chips. audio: broadcast FM with nothing to decode. plain: nothing heard yet (the card's band and channel block).
// Pure functions over the Activity heard on the channel.
import type {
	ActivityRecordingLink,
	ActivitySummary,
	DecodeField,
} from "@wavekit/api-types"

import { fieldText, rowView } from "../activity/rows.ts"
import { clockText } from "../display.ts"
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
	/** The latest as a playable row (its recording, if any, titled as the block reads); null without one. */
	latestRow: EarlierRow | null
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
	// a scanner recording kept for good: never a row of its own, its file rides on its transmission (attachRecordings)
	"recording-change",
])
/** A recording and its transmission share a channel: within half a 12.5 kHz step. */
const SAME_CHANNEL_HZ = 6_250
/** A file is kept at most this long after its transmission closes (the provisional hold, a rollover). */
const KEEP_SLACK_MS = 120_000
/** A file is kept at the earliest this long before its transmission's end reads (two writers' clocks). */
const KEEP_EARLY_MS = 1_000
/** A recording's start (or length) and its transmission's start (end − duration) agree within this. */
const START_MATCH_MS = 2_000
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
	return clockText(t)
}
function hhmmss(t: number): string {
	return clockText(t, { seconds: true })
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
		isTransmission(s) || s.kind === "call-lifecycle"
			? ms !== null
				? clock(ms)
				: ""
			: (row.readings ?? row.message ?? "")
	const a = isTransmission(s) ? "Transmission" : row.title
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

const EMPTY: Omit<
	NowView,
	"kind" | "shortId" | "latest" | "earlier" | "latestRow"
> = {
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

function sameChannel(a: number | null, b: number | null): boolean {
	if (a === null || b === null) return a === b
	return Math.abs(a - b) <= SAME_CHANNEL_HZ
}

/** A recording's file, as its `recording-change` row tells it. */
interface Part {
	row: ActivitySummary
	link: ActivityRecordingLink
	/** When the file was kept (the row's producedAt). */
	kept: number
	/** The file's audio length. */
	len: number
	/** When the recorded observation started; null when the row does not say. */
	start: number | null
}

/** A transmission without a file, as its row tells it (producedAt is its end, src/core/activity/runtime.ts). */
interface Span {
	start: number
	end: number
	dur: number
}

function partOf(row: ActivitySummary, link: ActivityRecordingLink): Part {
	const started = fieldOf(row, ["observationStartedAt"])?.value
	const start = typeof started === "string" ? Date.parse(started) : Number.NaN
	return {
		row,
		link,
		kept: Date.parse(row.producedAt),
		len: link.durationMs ?? durationMs(row) ?? 0,
		start: Number.isFinite(start) ? start : null,
	}
}

function spanOf(tx: ActivitySummary): Span {
	const end = Date.parse(tx.producedAt)
	const dur = durationMs(tx) ?? 0
	return { start: end - dur, end, dur }
}

/** Kept in time to be its file: from KEEP_EARLY_MS before the transmission's end to KEEP_SLACK_MS after. */
function keptAfter(kept: number, tx: Span): boolean {
	return kept >= tx.end - KEEP_EARLY_MS && kept <= tx.end + KEEP_SLACK_MS
}

/** Parts below this score are a transmission's final file; above it, a rollover part kept mid-transmission. */
const PART_SCORE = 1e12

/**
 * The transmission a recording's parts (one file, or a rollover's files) belong to, and whether they close
 * it (a final file) or were kept while it went on (rollover parts); null when none of them is it.
 *
 * With the observation's start known, the parts match the transmission that started then: its start is its
 * end (producedAt) less its duration, and the two agree within START_MATCH_MS (two clocks rounded apart); the
 * last part is kept from KEEP_EARLY_MS before the transmission's end to KEEP_SLACK_MS after it.
 *
 * Without it (the row's summary does not carry the start), one file is the transmission's final file when it
 * is kept in that same window and is no longer than the transmission (within START_MATCH_MS). When more than
 * one open transmission on the channel passes, the file attaches only to the one whose length agrees with
 * the file's within START_MATCH_MS, and to none (its own row) when that is not exactly one: the closest end
 * is no evidence, since a file can be kept up to KEEP_SLACK_MS after its transmission. A file kept while a
 * transmission went on is its rollover part only when its audio fits between that transmission's start and
 * the keep (len ≤ kept − start + START_MATCH_MS). A final file is preferred.
 */
function matchOf(
	parts: readonly Part[],
	hz: number | null,
	txs: readonly (Span | null)[],
	out: readonly ActivitySummary[],
	closed: ReadonlySet<number>,
): { i: number; closes: boolean } | null {
	const first = parts[0]
	const last = parts[parts.length - 1]
	if (!first || !last) return null
	let best: { i: number; closes: boolean } | null = null
	let bestScore = Number.POSITIVE_INFINITY
	// without the start: every open transmission the file could close, with its length
	const finals: { i: number; dur: number }[] = []
	txs.forEach((tx, i) => {
		const row = out[i]
		if (!tx || !row || !sameChannel(row.frequencyHz, hz)) return
		let score: number
		let closes = true
		if (first.start !== null) {
			if (closed.has(i) || !keptAfter(last.kept, tx)) return
			score = Math.abs(first.start - tx.start)
			if (score > START_MATCH_MS) return
		} else if (
			!closed.has(i) &&
			keptAfter(last.kept, tx) &&
			last.len <= tx.dur + START_MATCH_MS
		) {
			finals.push({ i, dur: tx.dur })
			return
		} else if (
			last.kept >= tx.start &&
			last.kept < tx.end - KEEP_EARLY_MS &&
			last.len <= last.kept - tx.start + START_MATCH_MS
		) {
			score = PART_SCORE + (tx.end - last.kept)
			closes = false
		} else return
		if (score < bestScore) {
			best = { i, closes }
			bestScore = score
		}
	})
	if (finals.length === 0) return best
	const [only] = finals
	if (finals.length === 1 && only) return { i: only.i, closes: true }
	// several could be its transmission: only a lone length match says which
	const fits = finals.filter(f => Math.abs(f.dur - last.len) <= START_MATCH_MS)
	const [fit] = fits
	return fits.length === 1 && fit ? { i: fit.i, closes: true } : null
}

/**
 * A scanner recording's `recording-change` row is written when the file is kept, after its
 * transmission. Its file rides on the transmission it recorded (same channel, matched by start and keep
 * time: matchOf), so the transmission row keeps its tone and transcript and carries the disc. A long transmission's rollover files (one observation start) all ride
 * on that one transmission, which plays the first part (Recordings lists every part). A recording whose
 * transmission is not in the list, or cannot be told apart (matchOf), reads as a transmission itself: one
 * row, its rollover parts folded in.
 */
export function attachRecordings(
	items: readonly ActivitySummary[],
): ActivitySummary[] {
	const out: ActivitySummary[] = []
	const parts: Part[] = []
	for (const s of items) {
		if (s.kind !== "recording-change") out.push(s)
		else if (s.recording) parts.push(partOf(s, s.recording))
	}
	if (parts.length === 0) return out
	// one group per recorded observation (rollover parts share its start), one per file when it is unknown
	const groups = new Map<string, Part[]>()
	parts.forEach((p, n) => {
		const key =
			p.start === null
				? `file:${n}`
				: `obs:${p.start}:${Math.round((p.row.frequencyHz ?? -1) / SAME_CHANNEL_HZ)}`
		const g = groups.get(key)
		if (g) g.push(p)
		else groups.set(key, [p])
	})
	const ordered = [...groups.values()]
		.map(g => g.sort((a, b) => a.kept - b.kept))
		.sort((a, b) => (a.at(-1)?.kept ?? 0) - (b.at(-1)?.kept ?? 0))
	const txs = out.map(tx =>
		tx.kind === "analog-transmission" && !tx.recording ? spanOf(tx) : null,
	)
	const closed = new Set<number>()
	const riding = new Map<number, Part[]>()
	const orphans: ActivitySummary[] = []
	for (const g of ordered) {
		const m = matchOf(g, g[0]?.row.frequencyHz ?? null, txs, out, closed)
		if (m === null) {
			// its transmission is not in the list: one row, the first part's
			const first = g[0]
			if (first) orphans.push(first.row)
			continue
		}
		if (m.closes) closed.add(m.i)
		riding.set(m.i, [...(riding.get(m.i) ?? []), ...g])
	}
	for (const [i, ps] of riding) {
		const tx = out[i]
		const first = [...ps].sort((a, b) => a.kept - b.kept)[0]
		if (tx && first) out[i] = { ...tx, recording: first.link }
	}
	if (orphans.length === 0) return out
	// newest first, as the input
	return [...out, ...orphans].sort(
		(a, b) => Date.parse(b.producedAt) - Date.parse(a.producedAt),
	)
}

function isTransmission(s: ActivitySummary): boolean {
	return s.kind === "analog-transmission" || s.kind === "recording-change"
}

export function nowView(input: NowInput): NowView {
	const items = attachRecordings(
		input.items.filter(s => SHOWN_KINDS.has(s.kind)),
	)
	const latest = items[0] ?? null
	const earlier = items.slice(1, 1 + (input.earlierMax ?? 2)).map(earlierRow)
	const fleet = fleetOf(input, latest)
	const base = {
		latest,
		earlier,
		latestRow: latest?.recording ? earlierRow(latest) : null,
	}

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

	if (isTransmission(latest)) {
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

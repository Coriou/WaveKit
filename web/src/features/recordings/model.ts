// What the Recordings drawer shows of one inventory item, the day groups and the typed-chip search
// (Recordings board). Only fields the core derives are used: nothing here guesses a frequency, a
// protocol or a name the core did not give. The search runs on the core (GET /api/recordings
// filters): each chip is one query key, so a chip replaces the one of its kind.
import type {
	RecordingInventoryItem,
	RecordingInventoryKind,
	StorageAreaId,
	StorageReport,
} from "@wavekit/api-types"

import type { RecordingsQuery } from "../../data/recordings-store.ts"
import { parseFrequency } from "../activity/search.ts"
import {
	clockText,
	dateText,
	startOfDay as dayStart,
	yearOf,
} from "../display.ts"
import { formatMHz } from "../format.ts"
import { channelMHz, savedNameAt, transmissionTitle } from "../naming.ts"

export type RecordingIcon = "voice" | "scan"

/**
 * "TG 2081", "Private call to 2081012"; a scanner recording is a transmission (naming.ts): its channel's saved
 * name, else what it was ("FM voice", "Digital voice"), never "Recording <Hz>". The frequency is in the meta line.
 */
export function recordingTitle(r: RecordingInventoryItem): string {
	if (isCallKind(r.kind)) {
		if (r.callType === "private")
			return r.talkgroup ? `Private call to ${r.talkgroup}` : "Private call"
		if (r.callType === "unit")
			return r.source ? `Unit ${r.source}` : "Unit call"
		if (r.talkgroup) return `TG ${r.talkgroup}`
		return "Voice call"
	}
	return savedNameAt(r.frequencyHz) ?? transmissionTitle({ what: whatOf(r) })
}

/** What a scanner recording holds, in content words. */
function whatOf(r: RecordingInventoryItem): string {
	return r.kind === "scanner-dv" ? "Digital voice" : "FM voice"
}

export const KIND_LABEL: Record<RecordingInventoryKind, string> = {
	"dsd-fme-call": "Call",
	"scanner-dv": "Scanner · digital voice",
	"scanner-analog": "Scanner · analog",
	"dv-call": "Call",
}

/** A call recording: dsd-fme's own per-call file or the core's digital voice recorder. */
export function isCallKind(kind: RecordingInventoryKind): boolean {
	return kind === "dsd-fme-call" || kind === "dv-call"
}

export function recordingIcon(r: RecordingInventoryItem): RecordingIcon {
	return recordingIconOf(r.kind)
}

/** The icon of a recording kind: a call's voice, a scanner file's scan. */
export function recordingIconOf(
	kind: RecordingInventoryItem["kind"],
): RecordingIcon {
	return isCallKind(kind) ? "voice" : "scan"
}

/**
 * The line under the title: what it is (a call; "FM voice" when a saved name is the title), the channel
 * frequency, who spoke, which decoder, size, and where it sits in its transmission.
 */
export function recordingMeta(r: RecordingInventoryItem): string {
	const parts: string[] = []
	if (isCallKind(r.kind)) parts.push(KIND_LABEL[r.kind])
	else if (savedNameAt(r.frequencyHz) !== null) parts.push(whatOf(r))
	if (r.frequencyHz !== null) parts.push(channelMHz(r.frequencyHz))
	if (r.source && r.callType !== "unit") parts.push(`radio ${r.source}`)
	if (r.decoderId) parts.push(r.decoderId)
	parts.push(formatBytes(r.bytes))
	const cut = recordingCutLabel(r)
	if (cut) parts.push(cut)
	return parts.join(" · ")
}

/**
 * Where a scanner file sits in its transmission and, for the end of the whole transmission only, why it ended,
 * in words (design: a part never says "Cut"): "Part 1 of 3 · continues", "Part 5 of 5 · continues" (the last
 * listed part rolled over: the transmission goes on in a file not listed yet), "Scanner moved on at 1:30, may be
 * incomplete" (the time is the offset in the whole transmission, so only a lone file states it; a later part
 * reads "Part 3 of 3 · Scanner moved on, may be incomplete"), "Continues…" while the chain of a rolled-over file is
 * not resolved yet, "Receiver lost", "WaveKit stopped". Null when the core says nothing (an older core, a file
 * that ended by itself).
 */
export function recordingCutLabel(r: RecordingInventoryItem): string | null {
	const part = r.part ?? null
	const parts = r.parts ?? null
	const chained = part !== null && parts !== null && parts > 1
	const out: string[] = chained ? [`Part ${part} of ${parts}`] : []
	if (chained && part < parts) {
		// a part before the last: the transmission goes on in the next file, whatever ended this one
		out.push("continues")
		return out.join(" · ")
	}
	// a lone file's length is its transmission's; a later part's offset needs the parts before it, never listed here
	const at =
		!chained && r.durationMs !== null && r.durationMs > 0
			? ` at ${formatDuration(r.durationMs / 1000)}`
			: ""
	if (r.cut === "scanner-moved")
		out.push(`Scanner moved on${at}, may be incomplete`)
	else if (r.cut === "duration-rollover") {
		// the last listed part rolled over: it goes on; a lone file whose chain is unknown continues
		out.push(chained ? "continues" : "Continues…")
	} else if (r.cut === "source-lost") out.push("Receiver lost")
	else if (r.cut === "shutdown") out.push("WaveKit stopped")
	return out.length > 0 ? out.join(" · ") : null
}

/** "0:42", "12:05", "1:02:10". */
export function formatDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds))
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	const ss = String(s % 60).padStart(2, "0")
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}

/** "340 kB", "2.9 MB", "922 MB", "1.2 GB" (the board's fmtB). */
export function formatBytes(b: number): string {
	if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`
	if (b >= 1e6)
		return `${b >= 1e8 ? Math.round(b / 1e6) : (b / 1e6).toFixed(1)} MB`
	return `${Math.max(1, Math.round(b / 1e3))} kB`
}

/** Storage areas the footer names, in order, in words. */
const FOOTER_AREAS: readonly (readonly [StorageAreaId, string])[] = [
	["digital-voice-wav", "call recordings"],
	["scanner-evidence", "scanner recordings"],
	["iq-captures", "IQ captures"],
]

/** "1,608": counts in the panels' header, notices and footer. */
export function countText(n: number): string {
	return COUNT.format(n)
}
const COUNT = new Intl.NumberFormat("en-US")

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The drawer's footer, in words: per recording area that exists, its size and cap. Only scanner recordings are
 * auto-cleaned; the used figure is the whole scanner folder while the cap covers recordings only ("Scanner folder:
 * 214 MB. Auto-clean keeps scanner recordings under 537 MB."); IQ captures stop at
 * theirs ("IQ captures: 96.0 MB of 640 MB (new captures are refused at the limit)."); an uncapped area states
 * its size. Then that kept items are never removed (the core's count; absent from an older core) and the free
 * disk space.
 */
export function storageLine(
	storage: StorageReport | null | undefined,
	kept: number | null,
): string {
	const out: string[] = []
	for (const [id, words] of FOOTER_AREAS) {
		const area = storage?.areas.find(a => a.id === id)
		if (!area?.exists) continue
		const used = formatBytes(area.bytes)
		if (!area.cap) out.push(`${capitalised(words)}: ${used}.`)
		else if (id === "scanner-evidence")
			out.push(
				`Scanner folder: ${used}. Auto-clean keeps ${words} under ${formatBytes(area.cap.bytes)}.`,
			)
		else if (id === "iq-captures")
			out.push(
				`${capitalised(words)}: ${used} of ${formatBytes(area.cap.bytes)} (new captures are refused at the limit).`,
			)
		else
			out.push(
				`${capitalised(words)}: ${used} of ${formatBytes(area.cap.bytes)}.`,
			)
	}
	if (kept !== null)
		out.push(`Kept items are never removed (${countText(kept)}).`)
	if (storage?.filesystem)
		out.push(`${formatBytes(storage.filesystem.availableBytes)} free on disk.`)
	return out.join(" ")
}

/**
 * When it was recorded: the start of its audio (a scanner file's first sample, never the time it was kept),
 * else the start time in the file name (the core's local time, read as this browser's local time), else the
 * file's last write.
 */
export function recordedAt(r: RecordingInventoryItem): Date {
	if (r.startedAt) {
		const d = new Date(r.startedAt)
		if (!Number.isNaN(d.getTime())) return d
	}
	if (r.startedAtLocal) {
		const d = new Date(r.startedAtLocal)
		if (!Number.isNaN(d.getTime())) return d
	}
	return new Date(r.modifiedAt)
}

const startOfDay = (d: Date) => dayStart(d)

/** "Today", "Yesterday", "Thursday 8 October" (with the year when it is not this year). */
export function dayLabel(d: Date, now: Date): string {
	const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
	if (days === 0) return "Today"
	if (days === 1) return "Yesterday"
	const opts: Intl.DateTimeFormatOptions = {
		weekday: "long",
		day: "numeric",
		month: "long",
		...(yearOf(d) !== yearOf(now) ? { year: "numeric" } : {}),
	}
	return dateText(d, opts).replace(",", "")
}

/** "14:05" on the chosen clock (Settings › Display › Time). */
export function timeLabel(d: Date): string {
	return clockText(d)
}

export interface DayGroup {
	key: number
	label: string
	items: RecordingInventoryItem[]
}

/** Consecutive items of the same day (the list is newest first). */
export function groupByDay(
	items: readonly RecordingInventoryItem[],
	now: Date,
): DayGroup[] {
	const out: DayGroup[] = []
	for (const it of items) {
		const d = recordedAt(it)
		const key = startOfDay(d)
		const last = out[out.length - 1]
		if (last && last.key === key) last.items.push(it)
		else out.push({ key, label: dayLabel(d, now), items: [it] })
	}
	return out
}

/** The virtual list's entries: a day label before each day's rows (the list is newest first). */
export interface RecRowEntry {
	type: "row"
	key: string
	item: RecordingInventoryItem
	/** Position among the rows, from 1 (aria-posinset). */
	position: number
}
export type RecEntry = { type: "day"; key: string; label: string } | RecRowEntry

export function dayEntries(
	items: readonly RecordingInventoryItem[],
	now: Date,
): RecEntry[] {
	const out: RecEntry[] = []
	let day: number | null = null
	let position = 0
	for (const it of items) {
		const d = recordedAt(it)
		const key = startOfDay(d)
		if (key !== day) {
			day = key
			out.push({ type: "day", key: `day:${key}`, label: dayLabel(d, now) })
		}
		position += 1
		out.push({ type: "row", key: it.id, item: it, position })
	}
	return out
}

/**
 * The header count, from the core (never the loaded rows): what the search matches, else every
 * recording (or the kept ones under Kept); "50,000+" when the catalogue left older ones out. Null
 * before the first answer, or from a core without counts. With copies hidden (the list asked for
 * copies=false) and copies to hide, `matched` too: `counts` holds the copies, so the count equals
 * the rows shown.
 */
export function headerCount(
	meta: {
		counts: { total: number; kept: number; copiesTotal?: number } | null
		matched: number | null
		truncated: boolean
	} | null,
	filter: "all" | "kept",
	searching: boolean,
	copiesHidden = false,
): string | null {
	if (meta === null) return null
	const hiding =
		copiesHidden && (meta.counts?.copiesTotal ?? 0) > 0 && meta.matched !== null
	const n =
		searching || hiding
			? meta.matched
			: filter === "kept"
				? (meta.counts?.kept ?? meta.matched)
				: (meta.counts?.total ?? meta.matched)
	if (n === null) return null
	return `${countText(n)}${meta.truncated && filter === "all" && !searching ? "+" : ""}`
}

// ---- search

export type RecTokenKind = "talkgroup" | "radio" | "frequency" | "kind" | "text"

export interface RecToken {
	kind: RecTokenKind
	/** Digits, Hz, a kind id, or text. */
	value: string
	/** What the chip and the suggestion show. */
	kindLabel: string
	label: string
}

const KIND_WORDS: readonly [RegExp, RecordingInventoryKind, string][] = [
	[/^(c|ca|cal|call|calls)$/i, "dsd-fme-call", "Calls"],
	// The core filters one kind at a time: the call recorder's files are their own chip.
	[
		/^(c|ca|cal|call|calls|rec|reco|recor|record|recorde|recorder)$/i,
		"dv-call",
		"Calls · call recorder",
	],
	[
		/^(s|sc|sca|scan|scann|scanne|scanner)$/i,
		"scanner-dv",
		"Scanner · digital voice",
	],
	[
		/^(s|sc|sca|scan|scann|scanne|scanner|an|ana|anal|analo|analog)$/i,
		"scanner-analog",
		"Scanner · analog",
	],
]

/** Half width of a typed frequency: one 12.5 kHz channel. */
const FREQ_SPAN_HZ = 6250

/**
 * Typed text as the core's `q` reads it (talkgroup, radio, decoder, kind, local start time, MHz):
 * without a leading "tg" or "radio" word, a decimal comma as a point, no unit. Null when nothing is left.
 */
export function serverText(text: string): string | null {
	const t = text
		.trim()
		.replace(/^(?:tg|talkgroup|radio|src|from)\s*:?\s*/i, "")
		.replace(/(\d),(\d)/g, "$1.$2")
		.replace(/\s*(?:mhz)$/i, "")
		.trim()
	return t === "" ? null : t
}

/**
 * The drawer's core query: the store's, plus `copies: false` (the core lists copies unless asked not to,
 * so the drawer asks for the list without them until Show copies is on).
 */
export type RecordingsViewQuery = RecordingsQuery & { copies?: false }

/**
 * The core query of the drawer's view: Kept, copies left out unless Show copies is on, one value per
 * chip kind (a later chip of a kind replaces an earlier one, see addToken), and the typed text, which
 * wins over a text chip while it is there.
 */
export function recordingsQuery(ui: {
	tokens: readonly RecToken[]
	text: string
	filter: "all" | "kept"
	showCopies?: boolean
}): RecordingsViewQuery {
	const q: RecordingsViewQuery = {}
	if (ui.filter === "kept") q.kept = true
	if (ui.showCopies !== true) q.copies = false
	for (const t of ui.tokens) {
		if (t.kind === "talkgroup") q.talkgroup = t.value
		else if (t.kind === "radio") q.source = t.value
		else if (t.kind === "kind") q.kind = t.value as RecordingInventoryKind
		else if (t.kind === "frequency") {
			const hz = Number(t.value)
			if (Number.isFinite(hz)) {
				q.minHz = hz - FREQ_SPAN_HZ
				q.maxHz = hz + FREQ_SPAN_HZ
			}
		} else {
			const text = serverText(t.value)
			if (text !== null) q.q = text
		}
	}
	const typed = serverText(ui.text)
	if (typed !== null) q.q = typed
	return q
}

/** The chips after adding `t`: it replaces the chip of its kind (one value per query key). */
export function withToken(
	tokens: readonly RecToken[],
	t: RecToken,
): RecToken[] {
	return [...tokens.filter(x => x.kind !== t.kind), t]
}

export function textToken(q: string): RecToken {
	return { kind: "text", value: q, kindLabel: "Anywhere", label: `“${q}”` }
}

/** The chips `input` could become (the core answers how many each leaves once it is chosen). */
export function suggest(
	input: string,
	tokens: readonly RecToken[],
): { token: RecToken }[] {
	const q = input.trim()
	if (!q) return []
	const out: RecToken[] = []
	const tg = /^(?:tg\s*:?\s*)?(\d{1,8})$/i.exec(q)
	if (tg?.[1]) {
		out.push({
			kind: "talkgroup",
			value: tg[1],
			kindLabel: "Talkgroup",
			label: tg[1],
		})
		out.push({ kind: "radio", value: tg[1], kindLabel: "Radio", label: tg[1] })
	}
	const radio = /^(?:radio|src|from)\s*:?\s*(\d{1,10})$/i.exec(q)
	if (radio?.[1])
		out.push({
			kind: "radio",
			value: radio[1],
			kindLabel: "Radio",
			label: radio[1],
		})
	if (/^\d{2,4}[.,]\d*/.test(q) || /\s*(mhz|khz)$/i.test(q)) {
		const hz = parseFrequency(q)
		if (hz !== null && hz > 0)
			out.push({
				kind: "frequency",
				value: String(Math.round(hz)),
				kindLabel: "Frequency",
				label: `${formatMHz(hz)} MHz`,
			})
	}
	for (const [re, kind, label] of KIND_WORDS)
		if (re.test(q))
			out.push({ kind: "kind", value: kind, kindLabel: "Kind", label })
	out.push(textToken(q))
	const seen = new Set<string>()
	return out
		.filter(t => {
			const k = `${t.kind}:${t.value}`
			if (
				seen.has(k) ||
				tokens.some(x => x.kind === t.kind && x.value === t.value)
			)
				return false
			seen.add(k)
			return true
		})
		.map(token => ({ token }))
}

// ---- copies

/** Whether the item is a copy (the core's copyOf names its listed original). */
export function isCopy(r: RecordingInventoryItem): boolean {
	return (r.copyOf ?? null) !== null
}

/**
 * The footer's Show copies toggle, in words: "Show copies (3)" while they are hidden, "Hide copies" while
 * they are shown; null when there is nothing to toggle (no copies, or an older core without the count).
 */
export function copiesToggleLabel(
	copiesTotal: number | null | undefined,
	showing: boolean,
): string | null {
	if (showing) return "Hide copies"
	if (copiesTotal == null || copiesTotal <= 0) return null
	return `Show copies (${countText(copiesTotal)})`
}

// ---- actions

/** Why the recording cannot be deleted from here, or null when it can. */
export function deleteBlocker(r: RecordingInventoryItem): string | null {
	if (r.kept === true) return "Kept recordings are protected. Unkeep it first."
	if (!isCallKind(r.kind))
		return "Scanner recordings go with their discovery. Delete the discovery in Scanner."
	return null
}

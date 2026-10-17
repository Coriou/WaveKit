// What the Recordings drawer shows of one inventory item, the day groups and the typed-chip search
// (Recordings board). Only fields the core derives are used: nothing here guesses a frequency, a
// protocol or a name the core did not give.
import type {
	RecordingInventoryItem,
	RecordingInventoryKind,
} from "@wavekit/api-types"

import { parseFrequency } from "../activity/search.ts"
import { formatMHz } from "../format.ts"

export type RecordingIcon = "voice" | "scan"

/** "TG 2081", "Private call to 2081012", "Digital voice 161.150", "161.150 MHz". */
export function recordingTitle(r: RecordingInventoryItem): string {
	if (r.kind === "dsd-fme-call") {
		if (r.callType === "private")
			return r.talkgroup ? `Private call to ${r.talkgroup}` : "Private call"
		if (r.callType === "unit")
			return r.source ? `Unit ${r.source}` : "Unit call"
		if (r.talkgroup) return `TG ${r.talkgroup}`
		return "Voice call"
	}
	const mhz = r.frequencyHz !== null ? formatMHz(r.frequencyHz) : null
	if (r.kind === "scanner-dv")
		return mhz ? `Digital voice ${mhz}` : "Digital voice"
	return mhz ? `${mhz} MHz` : "Scanner recording"
}

export const KIND_LABEL: Record<RecordingInventoryKind, string> = {
	"dsd-fme-call": "Call",
	"scanner-dv": "Scanner · digital voice",
	"scanner-analog": "Scanner · analog",
}

export function recordingIcon(r: RecordingInventoryItem): RecordingIcon {
	return r.kind === "dsd-fme-call" ? "voice" : "scan"
}

/** The line under the title: what it is, who spoke, which decoder, size. */
export function recordingMeta(r: RecordingInventoryItem): string {
	// the title already carries the frequency when the core knows it
	const parts: string[] = [KIND_LABEL[r.kind]]
	if (r.source && r.callType !== "unit") parts.push(`radio ${r.source}`)
	if (r.decoderId) parts.push(r.decoderId)
	parts.push(formatBytes(r.bytes))
	return parts.join(" · ")
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

/**
 * When it was recorded: the start time in the file name (the core's local time, read as this
 * browser's local time) or else the file's last write.
 */
export function recordedAt(r: RecordingInventoryItem): Date {
	if (r.startedAtLocal) {
		const d = new Date(r.startedAtLocal)
		if (!Number.isNaN(d.getTime())) return d
	}
	return new Date(r.modifiedAt)
}

const startOfDay = (d: Date) =>
	new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** "Today", "Yesterday", "Thursday 8 October" (with the year when it is not this year). */
export function dayLabel(d: Date, now: Date): string {
	const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
	if (days === 0) return "Today"
	if (days === 1) return "Yesterday"
	const opts: Intl.DateTimeFormatOptions = {
		weekday: "long",
		day: "numeric",
		month: "long",
		...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
	}
	return d.toLocaleDateString("en-GB", opts).replace(",", "")
}

export function timeLabel(d: Date): string {
	return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
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

export function matchesToken(r: RecordingInventoryItem, t: RecToken): boolean {
	switch (t.kind) {
		case "talkgroup":
			return r.talkgroup === t.value
		case "radio":
			return r.source === t.value
		case "frequency":
			return (
				r.frequencyHz !== null &&
				Math.abs(r.frequencyHz - Number(t.value)) <= FREQ_SPAN_HZ
			)
		case "kind":
			return r.kind === t.value
		case "text": {
			const hay =
				`${recordingTitle(r)} ${recordingMeta(r)} ${r.id}`.toLowerCase()
			return hay.includes(t.value.toLowerCase())
		}
	}
}

export function matchesAll(
	r: RecordingInventoryItem,
	tokens: readonly RecToken[],
	text = "",
): boolean {
	if (!tokens.every(t => matchesToken(r, t))) return false
	const q = text.trim()
	return q === "" || matchesToken(r, textToken(q))
}

export function textToken(q: string): RecToken {
	return { kind: "text", value: q, kindLabel: "Anywhere", label: `“${q}”` }
}

/** The chips `input` could become, each with how many recordings it would leave (zero ones dropped). */
export function suggest(
	input: string,
	items: readonly RecordingInventoryItem[],
	tokens: readonly RecToken[],
): { token: RecToken; count: number }[] {
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
		.map(token => ({
			token,
			count: items.filter(r => matchesAll(r, [...tokens, token])).length,
		}))
		.filter(s => s.count > 0)
}

// ---- actions

/** Why the recording cannot be deleted from here, or null when it can. */
export function deleteBlocker(r: RecordingInventoryItem): string | null {
	if (r.kept === true) return "Kept recordings are protected. Unkeep it first."
	if (r.kind !== "dsd-fme-call")
		return "Scanner recordings go with their discovery. Delete the discovery in Scanner."
	return null
}

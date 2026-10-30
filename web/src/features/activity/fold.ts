// Activity folding: one row per "thing going on" instead of one per decode. Every summary gets a fold key
// from its own data (protocol, the core's entityKey, the call's radio, the frequency where the entity is
// channel-bound, and a content signature when it carries a message); summaries with the same key whose
// times are within the family's gap fold into one stack. The list shows a stack's latest state, its count
// and its span, and expands in place to the folded rows. Pure functions over ActivitySummary: the list,
// the detail and the controller fold the same loaded window and get the same stacks (memoised per array).
//
// Folding is client-side over the loaded window (at most MAX_ITEMS rows), so counts are "in the loaded
// list", never totals: see docs/WEB-APP.md#activity-folding for the arithmetic behind each gap.
import type { ActivitySummary } from "@wavekit/api-types"

import { compareSeq } from "../../data/activity-feed.ts"

export type FoldFamily =
	| "aircraft"
	| "vessel"
	| "pager"
	| "call"
	| "sensor"
	| "station"
	| "node"
	| "notice"
	| "other"

export interface FamilyRule {
	/** A longer silence between two decodes of the same key ends the stack, ms. */
	gapMs: number
	/** The frequency is part of the identity (a capcode or talkgroup is only unique per channel). */
	perChannel: boolean
}

/**
 * Gaps per family. Each must exceed the longest normal interval between two stored decodes of one thing
 * while it is still "the same thing going on", and stay short enough that a new episode starts a new row.
 */
export const FAMILY_RULES: Readonly<Record<FoldFamily, FamilyRule>> = {
	// readsb sends 1-30 messages/s per aircraft; the core stores a position-only update at most once per
	// 60 s per aircraft (ACTIVITY_POSITION_COALESCE_MS). 2 × 60 s tolerates one missed window; an aircraft
	// gone for over 2 min (out of range, landed) starts a new row. ICAO addresses are global: AIS-like
	// channel changes must not split, so no frequency.
	aircraft: { gapMs: 120_000, perChannel: false },
	// AIS class A reports every 2-10 s underway, every 3 min at anchor; class B every 30 s to 3 min; the
	// core coalesces to one per 60 s. 600 s = 3 missed 3-min anchor reports. Vessels alternate AIS 1 and
	// AIS 2 (two channels), so no frequency.
	vessel: { gapMs: 600_000, perChannel: false },
	// Paging-network idle beacons repeat every 30-60 s. 180 s = 3 × the 60 s worst case, so two missed
	// beacons do not split the stack; a capcode is unique per network (channel).
	pager: { gapMs: 180_000, perChannel: true },
	// DMR / P25 / YSF: one call is bursts every 0.36-3 s (dsd-fme state rows) with 2-5 s hang time between
	// overs. 10 s = 2 × the 5 s hang time ends a call; a talkgroup is per site (channel).
	call: { gapMs: 10_000, perChannel: true },
	// 433/868 MHz sensors send every 16-60 s (often 2-3 copies per send). 300 s = 5 × 60 s.
	sensor: { gapMs: 300_000, perChannel: true },
	// APRS: mobile stations beacon every 1-3 min, fixed ones every 10 min (plus digipeated copies within
	// seconds). 900 s = one 10-min fixed interval plus 50 % jitter. A callsign is global.
	station: { gapMs: 900_000, perChannel: false },
	// Meshtastic nodes send position and telemetry every 15 min by default. 1 800 s = 2 × 15 min.
	node: { gapMs: 1_800_000, perChannel: false },
	// Never folds (each ingestion gap is its own notice); the gap is unused.
	notice: { gapMs: 0, perChannel: false },
	// Anything else (analog transmissions, scanner results, unknown entities): 120 s groups one exchange on
	// one channel (analog overs are seconds apart) without merging unrelated traffic minutes later.
	other: { gapMs: 120_000, perChannel: true },
}

/** The core's entityKey kinds (`<kind>:<value>`, src/core/activity/presentation) per family. */
const ENTITY_FAMILY: Readonly<Record<string, FoldFamily>> = {
	icao: "aircraft",
	reg: "aircraft",
	mmsi: "vessel",
	capcode: "pager",
	talkgroup: "call",
	sensor: "sensor",
	callsign: "station",
	node: "node",
}

/** Fields that carry a message body (rows.ts shows the first one as the row's message). */
export const MESSAGE_KEYS = new Set([
	"message",
	"text",
	"msg",
	"transcript",
	"body",
	"comment",
])

export function familyOf(s: ActivitySummary): FoldFamily {
	if (s.kind === "ingestion-gap") return "notice"
	const kind = entityKind(s.entityKey)
	return (kind !== null ? ENTITY_FAMILY[kind] : undefined) ?? "other"
}

function entityKind(key: string | null): string | null {
	if (key === null) return null
	const colon = key.indexOf(":")
	return colon > 0 ? key.slice(0, colon) : null
}

/** The entity's own value ("ABC123" for "icao:ABC123"), or null. */
export function entityValue(key: string | null): string | null {
	if (key === null) return null
	const colon = key.indexOf(":")
	return colon > 0 ? key.slice(colon + 1) : null
}

/** The message text a summary carries, or null. */
export function messageOf(s: ActivitySummary): string | null {
	const f = s.fields.find(
		x =>
			MESSAGE_KEYS.has(x.key) && typeof x.value === "string" && x.value !== "",
	)
	return f ? String(f.value) : null
}

/** A page with no content (the core labels function-zero empty pages "tone only"). */
export function isToneOnly(s: ActivitySummary): boolean {
	return (
		s.fields.some(f => f.key === "label" && f.value === "tone only") ||
		(familyOf(s) === "pager" && messageOf(s) === null)
	)
}

// POCSAG numeric pages use 0-9, space, U (urgent), -, [, ] and the spare characters the decoders print.
const NUMERIC = /^[\d\s\-[\]().*#U]+$/

export type ContentClass = "none" | "tone" | "numeric" | "alpha"

export function contentClass(s: ActivitySummary): ContentClass {
	const m = messageOf(s)
	if (m === null) return familyOf(s) === "pager" ? "tone" : "none"
	return NUMERIC.test(m) ? "numeric" : "alpha"
}

const fieldValue = (s: ActivitySummary, key: string) =>
	s.fields.find(f => f.key === key)?.value ?? null

/**
 * The fold key: family, event kind, protocol, identity (entity, plus the radio for a call; the title when
 * there is no entity), the channel to 1 kHz where the family is channel-bound, and the content (class +
 * the text itself, quoted) when the row carries a message: two pages fold only when their text is equal,
 * so two different pages to one capcode never fold (a hash could collide).
 */
export function foldKey(s: ActivitySummary): string {
	const family = familyOf(s)
	if (family === "notice") return `notice|${s.eventId}`
	const rule = FAMILY_RULES[family]
	const identity = s.entityKey ?? `t:${s.title ?? ""}|d:${s.decoderId ?? ""}`
	const radio =
		family === "call" ? `|src:${String(fieldValue(s, "source") ?? "?")}` : ""
	const channel =
		rule.perChannel && s.frequencyHz !== null
			? `|khz:${Math.round(s.frequencyHz / 1000)}`
			: ""
	const cls = contentClass(s)
	const message = messageOf(s)
	const content =
		cls === "none"
			? ""
			: `|c:${cls}${message === null ? "" : `:${JSON.stringify(message)}`}`
	return `${family}|${s.kind}|${s.protocol ?? ""}|${identity}${radio}${channel}${content}`
}

/** When it was heard: producedAt, else receivedAt, else 0 (an unparseable time never splits a stack). */
export function timeOf(s: ActivitySummary): number {
	const p = Date.parse(s.producedAt)
	if (Number.isFinite(p)) return p
	const r = Date.parse(s.receivedAt)
	return Number.isFinite(r) ? r : 0
}

export interface ActivityStack {
	/**
	 * Stable React key: the fold key and the first member it was seen with. foldedOf keeps a stack's key
	 * while it shares a member with the stack that had it, so rows evicted from the old end of the list or
	 * an older page loaded beneath it do not change it; foldActivity alone anchors on the earliest member.
	 */
	key: string
	foldKey: string
	family: FoldFamily
	/** Newest first (by commitSeq), the newest is the row itself. */
	members: readonly ActivitySummary[]
	/** The newest member, as stored. */
	latest: ActivitySummary
	/** The latest state: the newest member with what older members knew and it does not repeat. */
	view: ActivitySummary
	firstMs: number
	lastMs: number
}

/**
 * Folds a list into stacks, newest stack first (by their newest commitSeq). Per fold key, members are taken
 * in time order (commitSeq breaks ties) and a new stack starts when a member is more than the family's gap
 * after the one before it, so a row stored late never bridges a silence. Membership depends only on the
 * set of rows, never on their input order.
 */
export function foldActivity(
	items: readonly ActivitySummary[],
	rules: Readonly<Record<FoldFamily, FamilyRule>> = FAMILY_RULES,
): ActivityStack[] {
	const byKey = new Map<string, ActivitySummary[]>()
	for (const item of items) {
		const k = foldKey(item)
		const list = byKey.get(k)
		if (list) list.push(item)
		else byKey.set(k, [item])
	}
	const stacks: ActivityStack[] = []
	for (const [k, list] of byKey) {
		list.sort(chronological)
		const family = familyOf(list[0] as ActivitySummary)
		const gap = rules[family].gapMs
		let run: ActivitySummary[] = []
		let runLast = Number.NEGATIVE_INFINITY
		for (const item of list) {
			const t = timeOf(item)
			if (run.length > 0 && (family === "notice" || t - runLast > gap)) {
				stacks.push(makeStack(k, family, run))
				run = []
			}
			run.push(item)
			runLast = t
		}
		if (run.length > 0) stacks.push(makeStack(k, family, run))
	}
	return stacks.sort((a, b) =>
		compareSeq(b.latest.commitSeq, a.latest.commitSeq),
	)
}

/** Oldest first by time, commitSeq breaking ties. */
function chronological(a: ActivitySummary, b: ActivitySummary): number {
	return timeOf(a) - timeOf(b) || compareSeq(a.commitSeq, b.commitSeq)
}

/** `byTime` is in chronological order; the members and the latest state go by commitSeq. */
function makeStack(
	foldKeyText: string,
	family: FoldFamily,
	byTime: readonly ActivitySummary[],
): ActivityStack {
	const members = [...byTime].sort((a, b) =>
		compareSeq(b.commitSeq, a.commitSeq),
	)
	const latest = members[0] as ActivitySummary
	const oldest = byTime[0] as ActivitySummary
	let firstMs = Number.POSITIVE_INFINITY
	let lastMs = Number.NEGATIVE_INFINITY
	for (const m of members) {
		const t = timeOf(m)
		if (t < firstMs) firstMs = t
		if (t > lastMs) lastMs = t
	}
	return {
		key: `${foldKeyText}@${oldest.eventId}`,
		foldKey: foldKeyText,
		family,
		members,
		latest,
		view: latestState(members),
		firstMs,
		lastMs,
	}
}

/**
 * The newest member, filled in from older ones: fields it lacks (an ADS-B presence row carries no
 * callsign; the one before did), a position, and a title that names more than the bare entity id.
 */
export function latestState(
	newestFirst: readonly ActivitySummary[],
): ActivitySummary {
	const latest = newestFirst[0] as ActivitySummary
	if (newestFirst.length === 1) return latest
	const bare = entityValue(latest.entityKey)?.toLowerCase() ?? null
	const named = (s: ActivitySummary) =>
		s.title !== null &&
		s.title !== "" &&
		(bare === null || s.title.toLowerCase() !== bare)
	const titled = newestFirst.find(named)
	const seen = new Set<string>()
	const fields: ActivitySummary["fields"][number][] = []
	for (const m of newestFirst)
		for (const f of m.fields) {
			if (seen.has(f.key)) continue
			seen.add(f.key)
			fields.push(f)
		}
	const positioned = newestFirst.find(m => m.position !== undefined)
	const view: ActivitySummary = {
		...latest,
		title: titled?.title ?? latest.title,
		fields,
	}
	if (positioned?.position) view.position = positioned.position
	return view
}

/** Most event ids StackKeys remembers (two full lists, so a second feed does not wipe the first). */
const REMEMBERED = 10_000

/**
 * Keeps stack keys across folds of a changing list: a stack takes the key of a stack it shares a member
 * with (same fold key, newest shared member first, each key used once), else keeps its own. So a stack
 * whose oldest rows are evicted, or that gains older rows from a loaded page, stays mounted and expanded.
 */
export class StackKeys {
	private readonly byEvent = new Map<string, string>()

	reconcile(stacks: ActivityStack[]): ActivityStack[] {
		const used = new Set<string>()
		// kept keys first, so a new stack's own key never takes one a known stack still holds
		const kept = stacks.map(stack => {
			for (const m of stack.members) {
				const k = this.byEvent.get(m.eventId)
				if (
					k !== undefined &&
					!used.has(k) &&
					k.startsWith(`${stack.foldKey}@`)
				) {
					used.add(k)
					return k
				}
			}
			return null
		})
		const out = stacks.map((stack, i) => {
			let key = kept[i] ?? null
			if (key === null) {
				key = stack.key
				for (let n = 2; used.has(key); n++) key = `${stack.key}#${n}`
				used.add(key)
			}
			return key === stack.key ? stack : { ...stack, key }
		})
		for (const stack of out)
			for (const m of stack.members) {
				this.byEvent.delete(m.eventId)
				this.byEvent.set(m.eventId, stack.key)
			}
		for (const id of this.byEvent.keys()) {
			if (this.byEvent.size <= REMEMBERED) break
			this.byEvent.delete(id)
		}
		return out
	}
}

const folded = new WeakMap<readonly ActivitySummary[], ActivityStack[]>()
const keys = new StackKeys()

/**
 * foldActivity, memoised per list array (the feed replaces its array on every change), with stack keys
 * kept across the arrays (StackKeys).
 */
export function foldedOf(items: readonly ActivitySummary[]): ActivityStack[] {
	let out = folded.get(items)
	if (!out) {
		out = keys.reconcile(foldActivity(items))
		folded.set(items, out)
	}
	return out
}

/** The stack holding an event, or null. */
export function stackOf(
	stacks: readonly ActivityStack[],
	eventId: string,
): ActivityStack | null {
	for (const s of stacks)
		if (s.members.some(m => m.eventId === eventId)) return s
	return null
}

/** "45 s", "3 min", "1 h 20 min": a stack's span, or an interval. */
export function spanText(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000))
	if (s < 60) return `${s} s`
	const m = Math.round(s / 60)
	if (m < 60) return `${m} min`
	const h = Math.floor(m / 60)
	return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

/**
 * The typical interval between members, when they repeat on a schedule: at least 3 members and every
 * interval within 35 % of the median (a beacon every 45 s jittered by ±10 s still counts; a call of bursts
 * and silences does not). Null otherwise.
 */
export function regularIntervalMs(stack: ActivityStack): number | null {
	if (stack.members.length < 3) return null
	const times = stack.members.map(timeOf).sort((a, b) => a - b)
	const gaps: number[] = []
	for (let i = 1; i < times.length; i++)
		gaps.push((times[i] as number) - (times[i - 1] as number))
	const sorted = [...gaps].sort((a, b) => a - b)
	const median = sorted[Math.floor(sorted.length / 2)] as number
	if (median <= 0) return null
	return gaps.every(g => Math.abs(g - median) * 100 <= median * 35)
		? median
		: null
}

export interface StackExplanation {
	/** One line, worded as a hypothesis from the data ("Likely …"), or a plain fact about the rows. */
	headline: string
	/** How sure the wording is: "likely" lines are inferences, "seen" lines only count what was loaded. */
	tone: "likely" | "seen"
}

/** What a stack probably is, from its rows only. Never states an inference as fact. */
export function explainStack(stack: ActivityStack): StackExplanation {
	const n = stack.members.length
	const span = stack.lastMs - stack.firstMs
	const every = regularIntervalMs(stack)
	const repeats =
		every !== null ? `, repeats about every ${spanText(every)}` : ""
	const times = `${n} time${n === 1 ? "" : "s"}`
	const over = n > 1 ? ` over ${spanText(span)}` : ""
	const v = stack.view
	switch (stack.family) {
		case "pager":
			if (isToneOnly(v))
				return every !== null
					? {
							headline: `Likely a paging-network idle beacon (no content${repeats})`,
							tone: "likely",
						}
					: {
							headline:
								n > 1
									? `A tone-only page (no content), heard ${times}${over}`
									: "A tone-only page: an alert with no message content",
							tone: "seen",
						}
			return every !== null
				? {
						headline: `Likely an automated page (the same content${repeats})`,
						tone: "likely",
					}
				: { headline: `A page, heard ${times}${over}`, tone: "seen" }
		case "aircraft":
			return {
				headline:
					n > 1
						? `Likely one aircraft in range for ${spanText(span)} (${times})`
						: "One aircraft decode",
				tone: n > 1 ? "likely" : "seen",
			}
		case "vessel":
			return {
				headline:
					n > 1
						? `Likely one vessel in range for ${spanText(span)} (${times})`
						: "One vessel report",
				tone: n > 1 ? "likely" : "seen",
			}
		case "call":
			return {
				headline:
					n > 1
						? `Likely one call: ${n} bursts over ${spanText(span)}`
						: "One call burst",
				tone: n > 1 ? "likely" : "seen",
			}
		case "sensor":
		case "station":
		case "node":
			return every !== null
				? {
						headline: `Likely a scheduled transmitter${repeats}`,
						tone: "likely",
					}
				: { headline: `Heard ${times}${over}`, tone: "seen" }
		case "notice":
			return { headline: "A note from Activity storage", tone: "seen" }
		case "other":
			return every !== null
				? { headline: `Likely a repeating signal${repeats}`, tone: "likely" }
				: { headline: `Heard ${times}${over}`, tone: "seen" }
	}
}

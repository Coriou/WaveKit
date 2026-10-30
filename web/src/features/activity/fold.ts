// Activity folding: one row per "thing going on" instead of one per decode. Every summary gets a fold key
// from its own data (protocol, the core's entityKey, the frequency where the entity is channel-bound, and a
// content signature when it carries a message); summaries with the same key whose times are within the
// family's gap fold into one stack (a call splits by radio, a page by channel unless simulcast). The list
// shows a stack's newest row as stored (only who it is filled in from older rows), its count and its span,
// and expands in place to the folded rows. The list, the detail and the controller fold the same loaded
// window and get the same stacks: memoised per array, and incremental per list (foldedOf), so a live
// update folds only the keys its rows touched.
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
	/** Calls: one stack per radio; a row whose radio is not known yet joins its neighbour's. */
	byRadio?: boolean
	/**
	 * Pages: the channel splits stacks instead of the key, and a copy heard within this many ms of one of the
	 * stack's rows on another channel joins it (one page simulcast by several transmitters).
	 */
	simulcastMs?: number
}

/**
 * Simulcast copies of one page, 2 s. A POCSAG batch is 544 bits (sync + 16 codewords × 32 bits), 1.06 s at
 * the slowest rate (512 baud); each decoder stamps a page when its batch ends, so copies received by two
 * decoders can be one batch apart (1.06 s) plus the network's launch skew between transmitters (well under
 * 1 s). 2 s covers both; a network repeats a page on purpose tens of seconds later at the soonest (idle
 * beacons 30-60 s), which stays a separate decode of the stack, never a merge across channels.
 */
export const SIMULCAST_MS = 2_000

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
	// beacons do not split the stack; a capcode is unique per network (channel), except that one page
	// simulcast on several channels within SIMULCAST_MS is one stack.
	pager: { gapMs: 180_000, perChannel: true, simulcastMs: SIMULCAST_MS },
	// DMR / P25 / YSF: one call is bursts every 0.36-3 s (dsd-fme state rows) with 2-5 s hang time between
	// overs. 10 s = 2 × the 5 s hang time ends a call; a talkgroup is per site (channel), and each radio's
	// overs are their own stack (a call start sent before the radio is known joins the next one's).
	call: { gapMs: 10_000, perChannel: true, byRadio: true },
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

/** Work the caches did not save (a key or a time worked out from a summary): for tests and diagnostics. */
export const foldWork = { keys: 0, times: 0 }

// The feed never edits a summary (a changed row is a new object), so a summary's key and time are worked
// out once per object: a live update parses only the rows it brought, never the whole list again.
// One entry per summary for both (a WeakMap set is the costly part of a cold fold).
const cache = new WeakMap<ActivitySummary, { key?: string; time?: number }>()
const entryOf = (s: ActivitySummary) => {
	let e = cache.get(s)
	if (!e) cache.set(s, (e = {}))
	return e
}

/**
 * The fold key: family, event kind, protocol, identity (the entity; the title when there is none), the
 * channel to 1 kHz where the family is channel-bound, and the content (class + the text itself, quoted)
 * when the row carries a message: two pages fold only when their text is equal, so two different pages
 * to one capcode never fold (a hash could collide). A call's radio and a page's channel are not in the key:
 * they split stacks of one key (see splitRuns), so a call start sent before its radio is known joins its
 * call, and one page simulcast on several channels is one stack.
 */
export function foldKey(s: ActivitySummary): string {
	const e = entryOf(s)
	if (e.key !== undefined) return e.key
	foldWork.keys += 1
	return (e.key = computeKey(s))
}

function computeKey(s: ActivitySummary): string {
	const family = familyOf(s)
	if (family === "notice") return `notice|${s.eventId}`
	const rule = FAMILY_RULES[family]
	const identity = s.entityKey ?? `t:${s.title ?? ""}|d:${s.decoderId ?? ""}`
	const channel =
		rule.perChannel && rule.simulcastMs === undefined && s.frequencyHz !== null
			? `|khz:${Math.round(s.frequencyHz / 1000)}`
			: ""
	const cls = contentClass(s)
	const message = messageOf(s)
	const content =
		cls === "none"
			? ""
			: `|c:${cls}${message === null ? "" : `:${JSON.stringify(message)}`}`
	return `${family}|${s.kind}|${s.protocol ?? ""}|${identity}${channel}${content}`
}

/** When it was heard: producedAt, else receivedAt, else 0 (an unparseable time never splits a stack). */
export function timeOf(s: ActivitySummary): number {
	const e = entryOf(s)
	if (e.time !== undefined) return e.time
	foldWork.times += 1
	const p = Date.parse(s.producedAt)
	const r = Number.isFinite(p) ? Number.NaN : Date.parse(s.receivedAt)
	return (e.time = Number.isFinite(p) ? p : Number.isFinite(r) ? r : 0)
}

/** The channel to 1 kHz, or null when the row has no frequency. */
function khzOf(s: ActivitySummary): number | null {
	return s.frequencyHz === null ? null : Math.round(s.frequencyHz / 1000)
}

/** The radio of a call row, or null while the decoder does not know it yet (a DMR call start). */
function radioOf(s: ActivitySummary): string | null {
	const v = fieldValue(s, "source")
	return v === null || v === "" ? null : String(v)
}

/** Identity fields an earlier-heard row of a stack can fill in: who it is, never what this decode measured. */
export const IDENTITY_KEYS: ReadonlySet<string> = new Set([
	"callsign",
	"flight",
	"registration",
	"name",
])

/** What a row lacks that an earlier row of its stack said: who it is (title, callsign, registration). */
export interface KnownIdentity {
	/** A title naming more than the bare entity id, from an earlier row; null when the row has its own. */
	title: { value: string; from: ActivitySummary } | null
	/** Identity fields the row lacks, each from the latest earlier-heard row that carried it. */
	fields: readonly {
		field: ActivitySummary["fields"][number]
		from: ActivitySummary
	}[]
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
	/** The same rows oldest first by time (what the stack was made from). */
	byTime: readonly ActivitySummary[]
	/** The newest member, as stored. */
	latest: ActivitySummary
	/**
	 * What the list row shows: the newest member as stored, with only its identity filled in from members
	 * heard before it (`known`). Its measurements (duration, altitude, position, signal…) are always its own.
	 */
	view: ActivitySummary
	/**
	 * The identity `view` took from the members heard before the newest row (time, then commitSeq; the
	 * latest of them wins): never from a row heard after it, even one stored earlier.
	 */
	known: KnownIdentity
	firstMs: number
	lastMs: number
	/** The channels it was heard on (to 1 kHz, ascending): more than one for a simulcast page. */
	channelsHz: readonly number[]
}

/**
 * Folds a list into stacks, newest stack first (by their newest commitSeq). Per fold key, members are taken
 * in time order (commitSeq breaks ties) and split into stacks by splitRuns, so a row stored late never
 * bridges a silence. Membership depends only on the set of rows, never on their input order.
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
		const { rows, times } = chronological(list)
		const family = familyOf(rows[0] as ActivitySummary)
		for (const run of splitRuns(family, rows, times, rules[family]))
			stacks.push(makeStack(k, family, run))
	}
	return stacks.sort(newestStackFirst)
}

const newestStackFirst = (a: ActivityStack, b: ActivityStack) =>
	compareSeq(b.latest.commitSeq, a.latest.commitSeq)

/** Rows oldest first by time (commitSeq breaking ties), with their times beside them. */
function chronological(list: readonly ActivitySummary[]): {
	rows: ActivitySummary[]
	times: number[]
} {
	const pairs = list.map(r => ({ r, t: timeOf(r) }))
	pairs.sort((a, b) => a.t - b.t || compareSeq(a.r.commitSeq, b.r.commitSeq))
	return { rows: pairs.map(p => p.r), times: pairs.map(p => p.t) }
}

/**
 * A stack being built: its rows (in time order), its newest time, the channel it started on, when each of
 * its channels was last heard, and its radio.
 */
interface Run {
	rows: ActivitySummary[]
	last: number
	primary: number | null
	heard: Map<number | null, number>
	radio: string | null
}

/** A copy of `run`'s page: heard on `khz` within `within` ms of one of its rows on another channel. */
function simulcastCopy(
	run: Run,
	khz: number | null,
	t: number,
	within: number,
): boolean {
	for (const [c, at] of run.heard)
		if (c !== khz && t - at <= within) return true
	return false
}

/**
 * Splits one key's rows (in time order) into stacks. A row joins an open stack (one whose newest row is
 * within the family's gap) and otherwise starts one. Calls keep one stack per radio; a row whose radio is
 * not known yet (a DMR call start) joins the stack of the next row with a radio, or, when none follows
 * within the gap, the stack before it. A page joins a stack it is a simulcast copy of (heard within
 * `simulcastMs` of one of the stack's rows on another channel), else a stack that already heard both its
 * channel and the channel of a copy following it within `simulcastMs` (the copies' arrival order may swap
 * from one repeat to the next), else the stack that started on its channel: a channel stays with another
 * channel's stack only while its copies keep arriving with that stack's, so a repeat heard on it alone
 * later is its own channel's again.
 */
function splitRuns(
	family: FoldFamily,
	rows: readonly ActivitySummary[],
	times: readonly number[],
	rule: FamilyRule,
): ActivitySummary[][] {
	if (family === "notice") return rows.map(r => [r])
	const gap = rule.gapMs
	const runs: Run[] = []
	let open: Run[] = []
	let floating: ActivitySummary[] = []
	let floatFirst = 0
	let floatLast = 0
	const start = (rs: ActivitySummary[], t: number, khz: number | null) => {
		const run: Run = {
			rows: rs,
			last: t,
			primary: khz,
			heard: new Map([[khz, t]]),
			radio: null,
		}
		runs.push(run)
		open.push(run)
		return run
	}
	/** The open stack with the newest row, among those `ok` accepts. */
	const newest = (ok: (r: Run) => boolean) => {
		let best: Run | null = null
		for (const r of open)
			if (ok(r) && (best === null || r.last >= best.last)) best = r
		return best
	}
	// rows with no radio that no later radio claimed: the stack before them, else their own
	const settle = () => {
		if (floating.length === 0) return
		const before = newest(r => floatFirst - r.last <= gap)
		if (before) {
			before.rows.push(...floating)
			before.last = floatLast
		} else start(floating, floatLast, khzOf(floating[0] as ActivitySummary))
		floating = []
	}
	/**
	 * An open stack that heard `khz` and a channel whose copy follows row `i` within `within` ms, both within
	 * the gap: the network repeating its page on both channels, this time with that channel first.
	 */
	const pairedAhead = (
		i: number,
		khz: number | null,
		t: number,
		within: number,
	) => {
		for (
			let j = i + 1;
			j < rows.length && (times[j] as number) - t <= within;
			j++
		) {
			const other = khzOf(rows[j] as ActivitySummary)
			if (other === khz) continue
			const run = newest(r => {
				const a = r.heard.get(khz)
				const b = r.heard.get(other)
				return (
					a !== undefined && b !== undefined && t - a <= gap && t - b <= gap
				)
			})
			if (run) return run
		}
		return null
	}
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i] as ActivitySummary
		const t = times[i] as number
		if (floating.length > 0 && t - floatLast > gap) settle()
		if (open.some(r => t - r.last > gap))
			open = open.filter(r => t - r.last <= gap)
		const khz = khzOf(row)
		if (rule.byRadio === true) {
			const radio = radioOf(row)
			if (radio === null) {
				if (floating.length === 0) floatFirst = t
				floating.push(row)
				floatLast = t
				continue
			}
			const run = newest(r => r.radio === radio)
			const joined = [...floating, row]
			floating = []
			if (run) {
				run.rows.push(...joined)
				run.last = t
			} else start(joined, t, khz).radio = radio
			continue
		}
		// one open stack per key, except pages: one per channel, unless a simulcast copy joins
		const within = rule.simulcastMs
		const run =
			within === undefined
				? newest(() => true)
				: (newest(r => simulcastCopy(r, khz, t, within)) ??
					pairedAhead(i, khz, t, within) ??
					newest(r => r.primary === khz))
		if (run) {
			run.rows.push(row)
			run.last = t
			run.heard.set(khz, t)
		} else start([row], t, khz)
	}
	settle()
	return runs.map(r => r.rows)
}

/** `byTime` is in chronological order; the members and the latest state go by commitSeq. */
function makeStack(
	foldKeyText: string,
	family: FoldFamily,
	byTime: readonly ActivitySummary[],
): ActivityStack {
	// time order is almost always commit order: reversed, the sort has little left to do
	const members = [...byTime]
		.reverse()
		.sort((a, b) => compareSeq(b.commitSeq, a.commitSeq))
	const latest = members[0] as ActivitySummary
	const oldest = byTime[0] as ActivitySummary
	const khz = new Map<number, number>()
	if (latest.frequencyHz !== null)
		khz.set(Math.round(latest.frequencyHz / 1000), latest.frequencyHz)
	// only a page folds across channels; every other key has one channel (or does not care)
	if (FAMILY_RULES[family].simulcastMs !== undefined)
		for (const m of byTime) {
			const k = khzOf(m)
			if (k !== null && !khz.has(k)) khz.set(k, m.frequencyHz as number)
		}
	const known =
		members.length === 1
			? NOTHING_KNOWN
			: knownBefore(byTime, byTime.indexOf(latest))
	return {
		key: `${foldKeyText}@${oldest.eventId}`,
		foldKey: foldKeyText,
		family,
		members,
		byTime,
		latest,
		view: withIdentity(latest, known),
		known,
		firstMs: timeOf(oldest),
		lastMs: timeOf(byTime[byTime.length - 1] as ActivitySummary),
		channelsHz: [...khz.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]),
	}
}

const NOTHING_KNOWN: KnownIdentity = { title: null, fields: [] }

/**
 * The identity `row` lacks that `newestFirst` (the rows heard before it, the latest first) says: a title
 * naming more than the bare entity id, and the IDENTITY_KEYS fields it does not carry, each from the first
 * row that has it. Never a measurement.
 */
export function identityFrom(
	row: ActivitySummary,
	newestFirst: readonly ActivitySummary[],
): KnownIdentity {
	const bare = entityValue(row.entityKey)?.toLowerCase() ?? null
	const named = (s: ActivitySummary) =>
		s.title !== null &&
		s.title !== "" &&
		(bare === null || s.title.toLowerCase() !== bare)
	let title: KnownIdentity["title"] = null
	let titled = named(row)
	const missing = new Set(IDENTITY_KEYS)
	for (const f of row.fields) missing.delete(f.key)
	const fields: KnownIdentity["fields"][number][] = []
	for (const m of newestFirst) {
		if (titled && missing.size === 0) break
		if (m === row) continue
		if (!titled && named(m) && m.title !== null) {
			title = { value: m.title, from: m }
			titled = true
		}
		for (const f of m.fields)
			if (missing.has(f.key) && f.value !== null && f.value !== "") {
				missing.delete(f.key)
				fields.push({ field: f, from: m })
			}
	}
	return { title, fields }
}

/** The row with what `known` fills in (the row itself when nothing). */
function withIdentity(
	row: ActivitySummary,
	known: KnownIdentity,
): ActivitySummary {
	if (known.title === null && known.fields.length === 0) return row
	return {
		...row,
		title: known.title?.value ?? row.title,
		fields: [...row.fields, ...known.fields.map(k => k.field)],
	}
}

/**
 * The identity the row at `at` of `byTime` lacks that the rows heard before it say (time order, commitSeq
 * breaking ties), the latest of them first: the one rule for the list row and the detail.
 */
function knownBefore(
	byTime: readonly ActivitySummary[],
	at: number,
): KnownIdentity {
	if (at <= 0) return NOTHING_KNOWN
	return identityFrom(
		byTime[at] as ActivitySummary,
		byTime.slice(0, at).reverse(),
	)
}

/**
 * The identity an event lacks that rows of its stack heard before it say (the detail's "Latest known (from
 * earlier rows)"): never a later row's. The event is found by eventId, so a retained copy of it (the row
 * opened before a reload brought new objects) gets the same answer as the stack's own.
 */
export function knownFor(
	stack: ActivityStack,
	item: ActivitySummary,
): KnownIdentity {
	const at = stack.byTime.findIndex(r => r.eventId === item.eventId)
	// the row the list shows: what the list row took, by the same rule
	if (at >= 0 && stack.byTime[at] === stack.latest) return stack.known
	if (at >= 0) return knownBefore(stack.byTime, at)
	// not in the stack: the rows heard before it (time, then commitSeq)
	const t = timeOf(item)
	let n = 0
	while (n < stack.byTime.length) {
		const r = stack.byTime[n] as ActivitySummary
		const tr = timeOf(r)
		if (tr > t || (tr === t && compareSeq(r.commitSeq, item.commitSeq) >= 0))
			break
		n++
	}
	return n === 0
		? NOTHING_KNOWN
		: identityFrom(item, stack.byTime.slice(0, n).reverse())
}

/** The list a fold belongs to (an ActivityFeed): its identity owns the keys, its capacity bounds them. */
export interface FoldOwner {
	readonly capacity: number
}

/** One key's rows in time order, their times, and its stacks. */
interface KeyFold {
	rows: ActivitySummary[]
	times: number[]
	stacks: ActivityStack[]
}

/**
 * The last fold of one list, kept to fold the next one incrementally: only the keys that gained or lost
 * rows are folded again, and a stack whose rows did not change is the same object. Everything here holds
 * the list's current rows only (at most its capacity): `byEvent` has one entry per row in the list.
 */
interface OwnerFolds {
	/** The rows of the last fold, newest first. */
	present: readonly ActivitySummary[]
	byKey: Map<string, KeyFold>
	stacks: ActivityStack[]
	/** Each current row's stack: keys are kept through it, and the detail finds its stack in O(1). */
	byEvent: Map<string, ActivityStack>
	/** Every current stack's key, so a new stack never takes one in use. */
	used: Set<string>
	folded: WeakMap<readonly ActivitySummary[], ActivityStack[]>
}

const owners = new WeakMap<FoldOwner, OwnerFolds>()

/**
 * foldActivity, memoised per list array (the feed replaces its array on every change) and incremental per
 * owner: the rows that came and went since the owner's last fold are found by identity, only their keys
 * are folded again, and the rest of the stacks are reused. Stack keys are kept across the arrays of one
 * owner: a stack takes the key of a stack it shares a member with (same fold key, newest shared member
 * first, each key used once), else keeps its own, so a stack whose oldest rows are evicted, or that gains
 * older rows from a loaded page, stays mounted and expanded. One owner per list: what it remembers is that
 * list's rows only (at most its capacity), so a busy list never changes another's keys.
 */
export function foldedOf(
	items: readonly ActivitySummary[],
	owner: FoldOwner,
): ActivityStack[] {
	let own = owners.get(owner)
	if (!own) {
		own = {
			present: [],
			byKey: new Map(),
			stacks: [],
			byEvent: new Map(),
			used: new Set(),
			folded: new WeakMap(),
		}
		owners.set(owner, own)
	}
	let out = own.folded.get(items)
	if (!out) {
		out = refold(own, items)
		own.folded.set(items, out)
	}
	return out
}

function refold(
	own: OwnerFolds,
	items: readonly ActivitySummary[],
): ActivityStack[] {
	const touched = new Map<
		string,
		{ add: ActivitySummary[]; drop: Set<ActivitySummary> }
	>()
	const touch = (r: ActivitySummary) => {
		const k = foldKey(r)
		let t = touched.get(k)
		if (!t) touched.set(k, (t = { add: [], drop: new Set() }))
		return t
	}
	const { added, removed } = diffRows(own.present, items)
	for (const r of removed) touch(r).drop.add(r)
	for (const r of added) touch(r).add.push(r)
	own.present = items
	if (touched.size === 0) return own.stacks

	const replaced = new Set<ActivityStack>()
	const created: ActivityStack[] = []
	const keyStacks = new Map<string, ActivityStack[]>()
	for (const [k, change] of touched) {
		const before = own.byKey.get(k)
		let rows = before?.rows ?? []
		let times = before?.times ?? []
		if (change.drop.size > 0) {
			const keep = rows.map(r => !change.drop.has(r))
			rows = rows.filter((_, i) => keep[i])
			times = times.filter((_, i) => keep[i])
		}
		if (change.add.length > 0)
			({ rows, times } = mergeChronological(rows, times, change.add))
		const old = before?.stacks ?? []
		if (rows.length === 0) {
			own.byKey.delete(k)
			for (const s of old) replaced.add(s)
			continue
		}
		const family = familyOf(rows[0] as ActivitySummary)
		const byOldest = new Map(old.map(s => [s.byTime[0], s]))
		const stacks: ActivityStack[] = []
		const reused = new Set<ActivityStack>()
		for (const run of splitRuns(family, rows, times, FAMILY_RULES[family])) {
			const prev = byOldest.get(run[0])
			if (
				prev &&
				prev.byTime.length === run.length &&
				prev.byTime.every((r, i) => r === run[i])
			) {
				reused.add(prev)
				stacks.push(prev)
			} else {
				const s = makeStack(k, family, run)
				created.push(s)
				stacks.push(s)
			}
		}
		for (const s of old) if (!reused.has(s)) replaced.add(s)
		keyStacks.set(k, stacks)
		own.byKey.set(k, { rows, times, stacks })
	}

	// keys: a new stack takes the key of a replaced stack it shares a row with, newest first
	for (const s of replaced) own.used.delete(s.key)
	created.sort(newestStackFirst)
	const kept = created.map(stack => {
		for (const m of stack.members) {
			const prev = own.byEvent.get(m.eventId)
			if (
				prev !== undefined &&
				replaced.has(prev) &&
				prev.foldKey === stack.foldKey &&
				!own.used.has(prev.key)
			) {
				own.used.add(prev.key)
				return prev.key
			}
		}
		return null
	})
	const finals = new Map<ActivityStack, ActivityStack>()
	created.forEach((stack, i) => {
		let key = kept[i] ?? null
		if (key === null) {
			key = stack.key
			for (let n = 2; own.used.has(key); n++) key = `${stack.key}#${n}`
			own.used.add(key)
		}
		finals.set(stack, key === stack.key ? stack : { ...stack, key })
	})
	for (const [k, stacks] of keyStacks) {
		const fold = own.byKey.get(k)
		if (fold) fold.stacks = stacks.map(s => finals.get(s) ?? s)
	}
	for (const r of removed) own.byEvent.delete(r.eventId)
	for (const s of finals.values())
		for (const m of s.members) own.byEvent.set(m.eventId, s)

	// order: the untouched stacks keep theirs; the new ones (newest first) merge in by their latest decode
	const fresh = [...finals.values()]
	const out: ActivityStack[] = []
	let j = 0
	for (const s of own.stacks) {
		if (replaced.has(s)) continue
		while (
			j < fresh.length &&
			newestStackFirst(fresh[j] as ActivityStack, s) < 0
		)
			out.push(fresh[j++] as ActivityStack)
		out.push(s)
	}
	while (j < fresh.length) out.push(fresh[j++] as ActivityStack)
	own.stacks = out
	return out
}

/**
 * The rows that came and went between two lists, by identity. The feed's usual changes are found by
 * comparing references only: live rows on top, an older page below, the oldest rows evicted (the old
 * list is one contiguous run of the new one, cut at either end). Anything else falls back to sets.
 */
export function diffRows(
	prev: readonly ActivitySummary[],
	next: readonly ActivitySummary[],
): { added: ActivitySummary[]; removed: ActivitySummary[] } {
	if (prev.length === 0) return { added: [...next], removed: [] }
	if (next.length === 0) return { added: [], removed: [...prev] }
	// where the old list's first surviving row sits in the new one
	let from = 0
	let at = next.indexOf(prev[0] as ActivitySummary)
	if (at < 0) {
		// the old list's newest rows went (a reload): find its first row that stayed
		const first = next[0] as ActivitySummary
		from = prev.indexOf(first)
		at = from < 0 ? -1 : 0
	}
	if (at >= 0) {
		let n = 0
		while (
			from + n < prev.length &&
			at + n < next.length &&
			prev[from + n] === next[at + n]
		)
			n++
		// contiguous: everything outside the shared run is added or removed (a row is in the run of both
		// lists or of neither, so one outside it in both lists moved: it cancels out)
		if (from + n === prev.length || at + n === next.length) {
			const added = [...next.slice(0, at), ...next.slice(at + n)]
			const removed = [...prev.slice(0, from), ...prev.slice(from + n)]
			if (added.length === 0 || removed.length === 0) return { added, removed }
			const both = new Set(added)
			const moved = new Set(removed.filter(r => both.has(r)))
			return moved.size === 0
				? { added, removed }
				: {
						added: added.filter(r => !moved.has(r)),
						removed: removed.filter(r => !moved.has(r)),
					}
		}
	}
	const had = new Set(prev)
	const has = new Set(next)
	return {
		added: next.filter(r => !had.has(r)),
		removed: prev.filter(r => !has.has(r)),
	}
}

/** `rows` (in time order, with `times`) with `add` merged in; appends when they all come after. */
function mergeChronological(
	rows: readonly ActivitySummary[],
	times: readonly number[],
	add: readonly ActivitySummary[],
): { rows: ActivitySummary[]; times: number[] } {
	const extra = chronological(add)
	const before = (
		ta: number,
		a: ActivitySummary,
		tb: number,
		b: ActivitySummary,
	) => ta - tb < 0 || (ta === tb && compareSeq(a.commitSeq, b.commitSeq) < 0)
	const last = rows.length - 1
	if (
		last < 0 ||
		before(
			times[last] as number,
			rows[last] as ActivitySummary,
			extra.times[0] as number,
			extra.rows[0] as ActivitySummary,
		)
	)
		return { rows: [...rows, ...extra.rows], times: [...times, ...extra.times] }
	const outRows: ActivitySummary[] = []
	const outTimes: number[] = []
	let i = 0
	let j = 0
	while (i < rows.length || j < extra.rows.length) {
		const takeOld =
			j >= extra.rows.length ||
			(i < rows.length &&
				before(
					times[i] as number,
					rows[i] as ActivitySummary,
					extra.times[j] as number,
					extra.rows[j] as ActivitySummary,
				))
		if (takeOld) {
			outRows.push(rows[i] as ActivitySummary)
			outTimes.push(times[i++] as number)
		} else {
			outRows.push(extra.rows[j] as ActivitySummary)
			outTimes.push(extra.times[j++] as number)
		}
	}
	return { rows: outRows, times: outTimes }
}

/** Forgets an owner's folds (its feed was disposed); a later fold starts fresh. */
export function releaseFolds(owner: FoldOwner): void {
	owners.delete(owner)
	const held = heldOwners.get(owner)
	if (held) owners.delete(held)
}

/** Rows an owner's last fold remembers now (0 when it has none): for tests and diagnostics. */
export function rememberedFor(owner: FoldOwner): number {
	return owners.get(owner)?.byEvent.size ?? 0
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

/** The stack holding an event in an owner's list: O(1) for its latest fold (live), else a scan. */
export function stackIn(
	items: readonly ActivitySummary[],
	owner: FoldOwner,
	eventId: string,
): ActivityStack | null {
	const stacks = foldedOf(items, owner)
	const own = owners.get(owner)
	if (own && own.stacks === stacks) return own.byEvent.get(eventId) ?? null
	return stackOf(stacks, eventId)
}

const heldOwners = new WeakMap<FoldOwner, FoldOwner>()

/**
 * How many stacks the held arrivals ("N new") fold into: one beacon heard five times while scrolled away
 * is 1 new, not 5. Folded incrementally beside the list, under its own owner (same capacity).
 */
export function heldStacks(
	pending: readonly ActivitySummary[],
	owner: FoldOwner,
): number {
	if (pending.length === 0) return 0
	let held = heldOwners.get(owner)
	if (!held) {
		held = { capacity: owner.capacity }
		heldOwners.set(owner, held)
	}
	return foldedOf(pending, held).length
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

import type { BranchTelemetry } from "@wavekit/api-types"
import {
	decodesFact,
	isFailing,
	lastDecodeAt,
	procRole,
	processState,
	type DecodesFact,
	type ProcState,
} from "../data/decoder-state.js"
import { isFresh, isOld } from "../data/freshness.js"
import { memoOne } from "../data/memo.js"
import {
	bandLabel,
	configuredNote,
	decoderBand,
	type BandOrigin,
} from "../data/nominal-bands.js"
import { branchDropNow, counterRate, restartIncrements } from "../data/rates.js"
import {
	ENDPOINT_PATHS,
	type AppState,
	type DecoderRow,
	type GlyphRole,
} from "../data/types.js"
import { decoderMembership, type Membership } from "../data/window.js"
import {
	layoutColumns,
	renderHeader,
	renderRow,
	type ColumnSpec,
} from "../ui/columns.js"
import {
	formatAge,
	formatBytes,
	formatCount,
	formatDuration,
	formatEventRate,
	formatPercent,
} from "../ui/format.js"
import { cell, sp, type Cell, type Line, type Role } from "../ui/line.js"
import { glyphSpan } from "../ui/strip.js"
import { cellWidth, sanitize } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import { bannerConditions } from "./chrome.js"

export interface DecoderFacts {
	row: DecoderRow
	proc: ProcState
	role: GlyphRole
	failing: boolean
	decodes: DecodesFact
	ratePerSec: number | null
	lastAt: number | null
	branch: BranchTelemetry | null
	dropNow: number | null
	backpressure: boolean
	lifetime: number | null
	membership: Membership
	/** Band label (`tuned`, `1090.000`, …) or `?`; R40: tuned types always read `tuned`. */
	nominal: string
	/** `configured` when core's targetFrequenciesHz drive the band (R15), else `nominal`; null when unknown. */
	bandOrigin: BandOrigin | null
	/** R40 detail annotation for targets a tuned decoder does not apply, else null. */
	bandNote: string | null
	/** REST decoders lane older than the TTL: every REST-fed cell renders dim (T6). */
	oldRest: boolean
	/** Fanout lane is fresh: a running decoder without a branch then has no drop (—), not an unknown one. */
	fanoutFresh: boolean
	/** Fanout lane older than the TTL: drop and lifetime render dim. */
	oldFanout: boolean
	/** Sources or tuner lane older than the TTL: window and band render dim. */
	oldWindow: boolean
	/** Decodes of this decoder in the message feed over the last 60 s (M12). */
	feed60: number
}

const compute = memoOne(
	(
		decoders: AppState["decoders"],
		session: AppState["session"],
		fanout: AppState["fanout"],
		history: AppState["fanoutHistory"],
		sources: AppState["sources"],
		tuner: AppState["tuner"],
		relay: AppState["relay"],
		stopped: readonly string[],
		ring: AppState["messages"]["ring"],
		_ringVersion: number,
		now: number,
	): DecoderFacts[] => {
		const rows = decoders.value ?? []
		// M12: decodes per decoder in the feed's last minute (local receipt times).
		const feed60: Record<string, number> = Object.create(null)
		for (const e of ring.entries)
			if (e.receivedAt >= now - 60_000)
				feed60[e.decoderId] = (feed60[e.decoderId] ?? 0) + 1
		const oldRest = isOld(decoders, now)
		const fanoutFresh = isFresh(fanout, now)
		const oldFanout = isOld(fanout, now)
		const oldWindow = isOld(sources, now) || isOld(tuner, now)
		return rows.map(row => {
			const sess = session[row.id]
			const inc = restartIncrements(sess?.restarts ?? [], now)
			const proc = processState(row, inc, stopped.includes(row.id), now)
			const ratePerSec = oldRest ? null : counterRate(sess?.events ?? [])
			const lastAt = lastDecodeAt(row, sess)
			const branch =
				fanout.value?.branches.find(b => b.decoderId === row.id) ?? null
			// R8: a stopped decoder keeps its lifetime %, but has no drop now.
			const dropNow =
				branch && row.running && fanoutFresh
					? branchDropNow(history, branch.id)
					: null
			const offered = branch?.totalBytesWritten
			const band = decoderBand(row)
			return {
				row,
				proc,
				role: procRole(proc),
				failing: isFailing(proc),
				decodes: decodesFact(row, ratePerSec, lastAt),
				ratePerSec,
				lastAt,
				branch,
				dropNow,
				backpressure: branch?.backpressureActive === true && fanoutFresh,
				lifetime:
					branch && offered !== undefined && offered > 0
						? branch.droppedBytesTotal / offered
						: null,
				membership: decoderMembership(
					row,
					sources.value,
					tuner.value,
					relay.value,
				),
				nominal: band ? bandLabel(band.band, glyphs().range) : "?",
				bandOrigin: band?.origin ?? null,
				bandNote: band ? configuredNote(band) : null,
				oldRest,
				fanoutFresh,
				oldFanout,
				oldWindow,
				feed60: feed60[row.id] ?? 0,
			}
		})
	},
)

export function decoderFacts(state: AppState): DecoderFacts[] {
	return compute(
		state.decoders,
		state.session,
		state.fanout,
		state.fanoutHistory,
		state.sources,
		state.tuner,
		state.relay,
		state.actions.stoppedByCli,
		state.messages.ring,
		state.messages.version,
		state.now,
	)
}

const PROC_ROLE: Readonly<Record<ProcState, Role>> = {
	faulted: "fault",
	"faulted-retry": "fault",
	"faulted-retrying": "attention",
	"crash-loop": "fault",
	down: "fault",
	restarting: "attention",
	"suspend-pending": "attention",
	suspended: "neutral",
	stopped: "neutral",
	starting: "neutral",
	up: "value",
	unknown: "unknown",
}

function processCell(f: DecoderFacts, now: number): Cell {
	const role = PROC_ROLE[f.proc]
	const n = f.row.restartCount
	const restarts = `${formatCount(n)} restart${n === 1 ? "" : "s"}`
	const sep = ` ${glyphs().sep} `
	const up = formatDuration(f.row.uptime)
	// R70: time to core's next automatic restart (server time; never negative).
	const next = f.row.nextRestartAt
		? Date.parse(f.row.nextRestartAt)
		: Number.NaN
	const inNext = Number.isFinite(next) ? `in ${formatAge(next - now)}` : null
	switch (f.proc) {
		case "unknown":
			return cell([sp("?", "unknown")])
		case "suspended":
			return cell([sp("suspended", role)], [sp(`suspended${sep}rate`, role)])
		case "suspend-pending":
			return cell(
				[sp("suspending", role)],
				[sp("suspending (stop pending)", role)],
			)
		case "faulted-retrying":
			return cell([sp("faulted", role)], [sp(`faulted${sep}retrying`, role)])
		case "faulted-retry":
			return inNext
				? cell(
						[sp("faulted", role)],
						[sp(`faulted${sep}retry ${inNext}`, role)],
						...(n > 0
							? [[sp(`faulted${sep}retry ${inNext}${sep}${restarts}`, role)]]
							: []),
					)
				: cell([sp("faulted", role)], [sp(`faulted${sep}retrying`, role)])
		case "restarting":
			if (inNext)
				return cell(
					[sp("restarting", role)],
					[sp(`restarting ${inNext}`, role)],
					...(n > 0
						? [[sp(`restarting ${inNext}${sep}${restarts}`, role)]]
						: []),
				)
			break
		default:
			break
	}
	switch (f.proc) {
		case "up":
			return n > 0
				? cell([sp(`up ${up}`, role)], [sp(`up ${up}${sep}${restarts}`, role)])
				: cell([sp(`up ${up}`, role)])
		case "starting":
			// R52 m2: the minimal variant fits the Decoders view's 10 columns.
			return cell([sp("starting", role)], [sp(`starting ${up}`, role)])
		case "stopped":
			return cell([sp("stopped", role)])
		default:
			// R50: keep the restart evidence as width allows (min, mid, rich); none without restarts.
			// The multiplication sign is the fault glyph, so ASCII mode reads `x13`.
			return n > 0
				? cell(
						[sp(f.proc, role)],
						[sp(`${f.proc} ${glyphs().fault}${formatCount(n)}`, role)],
						[sp(`${f.proc}${sep}${restarts}`, role)],
					)
				: cell([sp(f.proc, role)])
	}
}

/**
 * M12: the rate leads (`2/min`), the age is added when there is room
 * (`2/min · 25s ago`). The rate is core's counter rate, else the feed's count
 * over the last minute. A last decode older than a minute reads
 * `none for 6m`; never decoded: `none for <uptime>`.
 */
function decodesCell(f: DecoderFacts, now: number): Cell {
	const d = f.decodes
	const sep = ` ${glyphs().sep} `
	const ago = (at: number): string => `${formatAge(now - at)} ago`
	const none = (age: string): Cell =>
		cell([sp(`none ${age}`, "neutral")], [sp(`none for ${age}`, "neutral")])
	if (d.kind === "na") return cell([sp(glyphs().na, "label")])
	if (d.kind === "none") return none(formatDuration(d.uptimeSec))
	if (d.kind === "total") return cell([sp(`${formatCount(d.count)} total`)])
	const lastAt = d.lastAt
	const rate =
		d.kind === "rate"
			? formatEventRate(d.perSec)
			: f.feed60 > 0
				? `${formatCount(f.feed60)}/min`
				: null
	if (rate === null) {
		if (lastAt !== null && now - lastAt > 60_000)
			return none(formatAge(now - lastAt))
		return lastAt !== null
			? cell([sp(ago(lastAt))])
			: cell([sp("?", "unknown")])
	}
	return lastAt === null
		? cell([sp(rate)])
		: cell([sp(rate)], [sp(`${rate}${sep}${ago(lastAt)}`)])
}

const NA = (): Cell => cell([sp(glyphs().na, "label")])

function dropCell(f: DecoderFacts): Cell {
	if (!f.row.running) return NA()
	// R52 m5: no branch while fanout is fresh means nothing to drop, not an unknown drop.
	if (f.branch === null && f.fanoutFresh) return NA()
	if (f.dropNow === null)
		return f.backpressure
			? cell([sp("?", "unknown"), sp(" "), sp(glyphs().attention, "attention")])
			: cell([sp("?", "unknown")])
	const pct = formatPercent(f.dropNow)
	return f.backpressure
		? cell([sp(glyphs().attention, "attention"), sp(pct, "attention")])
		: cell([sp(pct)])
}

function lifetimeCell(f: DecoderFacts): Cell {
	if (f.lifetime !== null) return cell([sp(formatPercent(f.lifetime))])
	return f.branch === null && (f.fanoutFresh || !f.row.running)
		? NA()
		: cell([sp("?", "unknown")])
}

/** Marks a configured band in every variant, so it never passes as nominal (R15, T7). */
export const CONFIGURED_MARK = "*"

function nominalCell(f: DecoderFacts): Cell {
	if (f.nominal === "?") return cell([sp("?", "unknown")])
	if (f.bandOrigin !== "configured") return cell([sp(f.nominal)])
	return cell([sp(f.nominal), sp(CONFIGURED_MARK, "label")])
}

function windowCell(f: DecoderFacts): Cell {
	const m = f.membership
	if (m === "—") return NA()
	return cell([sp(m, m === "?" ? "unknown" : "value")])
}

/** Every span of the cell in the `old` role (stale lane, T6). */
function dim(c: Cell): Cell {
	return {
		variants: c.variants.map(v => v.map(x => ({ ...x, role: "old" as const }))),
	}
}

const REST_CELLS = [
	"decoder",
	"process",
	"decodes",
	"restarts",
	"errors",
	"events",
	"iq",
] as const
const FANOUT_CELLS = ["drop", "lifetime"] as const
const WINDOW_CELLS = ["window", "nominal"] as const

/**
 * Cells for one decoder row. Each cell dims (role `old`) when the lane it comes
 * from is older than the TTL (T6): REST cells by the decoders lane, drop and
 * lifetime by the fanout lane, window and band by the sources/tuner lanes.
 * `dimAll` dims every cell (spec §6.1: everything below the banner is dim).
 */
export function decoderCells(
	f: DecoderFacts,
	now: number,
	dimAll = false,
): Record<string, Cell> {
	const cells: Record<string, Cell> = {
		decoder: cell([glyphSpan(f.role), sp(" "), sp(sanitize(f.row.id))]),
		process: processCell(f, now),
		decodes: decodesCell(f, now),
		drop: dropCell(f),
		lifetime: lifetimeCell(f),
		nominal: nominalCell(f),
		window: windowCell(f),
		restarts: cell([sp(formatCount(f.row.restartCount))]),
		errors: cell([sp(formatCount(f.row.stats.errors))]),
		events: cell([sp(formatCount(f.row.stats.eventsOut))]),
		iq: cell([sp(formatBytes(f.row.stats.bytesIn))]),
	}
	const groups: ReadonlyArray<[boolean, readonly string[]]> = [
		[dimAll || f.oldRest, REST_CELLS],
		[dimAll || f.oldFanout, FANOUT_CELLS],
		[dimAll || f.oldWindow, WINDOW_CELLS],
	]
	for (const [old, ids] of groups) {
		if (!old) continue
		for (const id of ids) {
			const c = cells[id]
			if (c) cells[id] = dim(c)
		}
	}
	return cells
}

const header = (...variants: string[]): Cell => ({
	variants: variants.map(v => [sp(v, "label")]),
})
const col = (
	id: string,
	min: number,
	pref: number,
	priority: number,
	align: "left" | "right",
	head: Cell,
): ColumnSpec => ({ id, min, pref, priority, align, header: head })
/** The title sits over the names, after the glyph and its space (spec §6.1 `   DECODERS`). */
const TITLE: Cell = { variants: [[sp("  DECODERS", "label", true)]] }

/**
 * Spec §5.3 at standard width and up. The decoder column carries the state
 * glyph (`● dsd-fme`, one space, as in the mockups), so its widths are the
 * name's plus 2. Like the Decoders view (assumption 18), the core columns use
 * their pref widths as minimums, so at 80 columns lifetime and nominal drop
 * whole instead of squeezing process to `restar…` (§6.1 80×24).
 */
export const OVERVIEW_COLUMNS: ColumnSpec[] = [
	col("decoder", 18, 18, 0, "left", TITLE),
	col("process", 18, 18, 0, "left", header("process")),
	col("decodes", 16, 16, 1, "left", header("decodes")),
	col("drop", 8, 8, 1, "right", header("drop", "drop now")),
	col("lifetime", 8, 8, 4, "right", header("lifetime")),
	col("nominal", 15, 15, 3, "left", header("band MHz")),
	col("window", 6, 6, 2, "left", header("window")),
]

/**
 * Decoders view adds restarts/errors/events/IQ in. Nominal gets priority 7 so it drops first; its
 * band moves to the detail pane. The core columns use their pref widths as minimums, so the 120-column
 * layout matches spec §6.2 (nominal gone, every other column present).
 */
export const DECODERS_COLUMNS: ColumnSpec[] = [
	col("decoder", 18, 18, 0, "left", TITLE),
	col("process", 10, 10, 0, "left", header("process")),
	col("restarts", 8, 8, 5, "right", header("restarts")),
	col("errors", 6, 6, 5, "right", header("errors")),
	col("decodes", 15, 15, 1, "left", header("decodes")),
	col("events", 6, 6, 6, "right", header("events")),
	col("iq", 8, 9, 6, "right", header("iq in")),
	col("drop", 8, 8, 1, "right", header("drop", "drop now")),
	col("lifetime", 8, 8, 4, "right", header("lifetime")),
	col("nominal", 15, 15, 7, "left", header("band MHz")),
	col("window", 6, 6, 2, "left", header("window")),
]

/** Narrow width class (< 79 content columns, spec §6.1 60×20): lifetime and nominal gone, minimal cells. */
const NARROW_COLUMNS: ColumnSpec[] = [
	col("decoder", 14, 17, 0, "left", TITLE),
	col("process", 6, 10, 0, "left", header("process")),
	col("decodes", 8, 12, 1, "left", header("decodes")),
	col("drop", 4, 4, 1, "right", header("drop", "drop now")),
	col("window", 6, 6, 2, "left", header("window")),
]

const NARROW_BELOW = 79

/** Which table a view lays out; the kind, not a column array, selects the narrow set (R52 m4). */
/**
 * S10: beside a right detail pane (~111 columns at 200) the band column
 * outranks the counters, so events and iq in go first and the band stays.
 */
const DECODERS_PANE_COLUMNS: ColumnSpec[] = DECODERS_COLUMNS.map(c =>
	c.id === "nominal" ? { ...c, priority: 3 } : c,
)

export type DecoderTableKind = "overview" | "decoders" | "decoders-pane"

/** The columns a table lays out at `width`: its standard set, or the narrow set below 79 columns. */
export function decoderColumns(
	kind: DecoderTableKind,
	width: number,
): readonly ColumnSpec[] {
	if (width < NARROW_BELOW) return NARROW_COLUMNS
	if (kind === "overview") return OVERVIEW_COLUMNS
	return kind === "decoders-pane" ? DECODERS_PANE_COLUMNS : DECODERS_COLUMNS
}

/** With a configured band on screen the band column gains a column for the mark and says what it means (I1). */
function withConfiguredMark(
	cols: readonly ColumnSpec[],
	facts: readonly DecoderFacts[],
): readonly ColumnSpec[] {
	const configured = facts.filter(f => f.bandOrigin === "configured")
	if (configured.length === 0) return cols
	// min = pref = the widest marked label, so the column shows whole or drops whole:
	// layout never truncates the mark away (R57).
	const widest = Math.max(
		...configured.map(f => cellWidth(f.nominal) + CONFIGURED_MARK.length),
	)
	// M13: the header stays `band MHz`; the `*` is explained by the help legend.
	const headText = "band MHz"
	return cols.map(c => {
		if (c.id !== "nominal") return c
		const w = Math.max(c.pref + 1, widest, cellWidth(headText))
		return { ...c, min: w, pref: w, header: header(headText) }
	})
}

export interface DecoderTable {
	header: Line
	rows: Line[]
	shownIds: string[]
}

export interface DecoderTableOptions {
	/** Dim every row (spec §6.1: with a cached view under the banner, everything below it is dim). */
	dim?: boolean
}

/**
 * maxRows includes the "+N more" marker row; the selected row is always kept visible.
 * `columns` is a table kind (standard set, narrow set below 79 columns) or an
 * explicit column array laid out as given at every width.
 */
export function decoderTable(
	facts: readonly DecoderFacts[],
	columns: DecoderTableKind | readonly ColumnSpec[],
	width: number,
	maxRows: number,
	selectedId: string | null,
	now: number,
	opts: DecoderTableOptions = {},
): DecoderTable {
	const base =
		typeof columns === "string" ? decoderColumns(columns, width) : columns
	const cols = withConfiguredMark(base, facts)
	const layout = layoutColumns(width, cols)
	const fits = facts.length <= maxRows
	const visible = fits ? facts.length : Math.max(0, maxRows - 1)
	const sel =
		selectedId === null ? -1 : facts.findIndex(f => f.row.id === selectedId)
	const start =
		fits || sel < visible
			? 0
			: Math.min(sel - visible + 1, facts.length - visible)
	const shown = facts.slice(start, start + visible)
	const rows = shown.map(f => {
		const cells = decoderCells(f, now, opts.dim === true)
		// Spec §6.2: the selected row is inverse on the glyph and the name.
		if (f.row.id === selectedId) {
			cells["decoder"] = cell([
				{ ...glyphSpan(f.role), role: "selected" },
				sp(" ", "selected"),
				sp(sanitize(f.row.id), "selected", true),
			])
		}
		return renderRow(layout, cells)
	})
	if (!fits)
		rows.push([
			sp(
				`  +${facts.length - shown.length} more`,
				opts.dim === true ? "old" : "label",
			),
		])
	return {
		header: renderHeader(layout, cols),
		rows,
		shownIds: shown.map(f => f.row.id),
	}
}

/** Spec §9: cold start, API down without cache, REST 200 with []. */
export function decodersPlaceholder(state: AppState): Line | null {
	const lane = state.decoders
	if (lane.value !== undefined)
		return lane.value.length === 0
			? [sp("no decoders configured", "label")]
			: null
	const sep = ` ${glyphs().sep} `
	// R57: the banner's rule and wording decide, so the two never disagree (§9):
	// some-but-not-all endpoints failing is an endpoint failure, all of them is the API.
	const conds = bannerConditions(state)
	const ep = conds.find(
		c => c.kind === "endpoint" && c.path === ENDPOINT_PATHS.decoders,
	)
	if (ep?.kind === "endpoint")
		return [
			sp(
				`no data${sep}GET ${ENDPOINT_PATHS.decoders} failing${sep}${ep.reason}`,
				"label",
			),
		]
	if (
		conds.some(c => c.kind === "api-down" || c.kind === "rest-down") ||
		lane.error ||
		state.conn.rest.firstFailAt !== null
	)
		return [sp(`no data${sep}API unreachable`, "label")]
	return [sp("fetching /api/decoders", "label")]
}

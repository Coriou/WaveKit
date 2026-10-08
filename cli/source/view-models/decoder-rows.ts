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
import type { AppState, DecoderRow, GlyphRole } from "../data/types.js"
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
import { sanitize } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"

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
	oldRest: boolean
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
		now: number,
	): DecoderFacts[] => {
		const rows = decoders.value ?? []
		const oldRest = isOld(decoders, now)
		const fanoutFresh = isFresh(fanout, now)
		return rows.map(row => {
			const sess = session[row.id]
			const inc = restartIncrements(sess?.restarts ?? [], now)
			const proc = processState(row, inc, stopped.includes(row.id))
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
		state.now,
	)
}

const PROC_ROLE: Readonly<Record<ProcState, Role>> = {
	faulted: "fault",
	"crash-loop": "fault",
	down: "fault",
	restarting: "attention",
	stopped: "neutral",
	starting: "neutral",
	up: "value",
}

function processCell(f: DecoderFacts): Cell {
	const role: Role = f.oldRest ? "old" : PROC_ROLE[f.proc]
	const n = f.row.restartCount
	const restarts = `${formatCount(n)} restart${n === 1 ? "" : "s"}`
	const sep = ` ${glyphs().sep} `
	const up = formatDuration(f.row.uptime)
	switch (f.proc) {
		case "up":
			return n > 0
				? cell([sp(`up ${up}`, role)], [sp(`up ${up}${sep}${restarts}`, role)])
				: cell([sp(`up ${up}`, role)])
		case "starting":
			return cell([sp(`starting ${up}`, role)])
		case "stopped":
			return cell([sp("stopped", role)])
		default:
			return cell([sp(f.proc, role)], [sp(`${f.proc}${sep}${restarts}`, role)])
	}
}

function decodesCell(f: DecoderFacts, now: number): Cell {
	const role: Role = f.oldRest ? "old" : "value"
	const d = f.decodes
	const ago = (at: number): string => `${formatAge(now - at)} ago`
	switch (d.kind) {
		case "na":
			return cell([sp(glyphs().na, "label")])
		case "rate": {
			const rate = formatEventRate(d.perSec)
			return d.lastAt === null
				? cell([sp(rate, role)])
				: cell(
						[sp(ago(d.lastAt), role)],
						[sp(`${rate} ${glyphs().sep} ${ago(d.lastAt)}`, role)],
					)
		}
		case "last":
			return cell([sp(ago(d.lastAt), role)])
		case "none": {
			const dur = formatDuration(d.uptimeSec)
			return cell(
				[sp(`none ${dur}`, f.oldRest ? "old" : "neutral")],
				[sp(`none for ${dur}`, f.oldRest ? "old" : "neutral")],
			)
		}
		case "total":
			return cell([sp(`${formatCount(d.count)} total`, role)])
	}
}

function dropCell(f: DecoderFacts): Cell {
	if (!f.row.running) return cell([sp(glyphs().na, "label")])
	if (f.dropNow === null) return cell([sp("?", "unknown")])
	const pct = formatPercent(f.dropNow)
	return f.backpressure
		? cell([sp(glyphs().attention, "attention"), sp(pct, "attention")])
		: cell([sp(pct)])
}

function lifetimeCell(f: DecoderFacts): Cell {
	if (f.lifetime !== null) return cell([sp(formatPercent(f.lifetime))])
	return f.branch === null && !f.row.running
		? cell([sp(glyphs().na, "label")])
		: cell([sp("?", "unknown")])
}

/** A configured band is never passed off as nominal (R15): the rich variant says `cfg`. */
function nominalCell(f: DecoderFacts): Cell {
	if (f.nominal === "?") return cell([sp("?", "unknown")])
	if (f.bandOrigin !== "configured") return cell([sp(f.nominal)])
	return cell([sp(f.nominal)], [sp(f.nominal), sp(" cfg", "label")])
}

export function decoderCells(
	f: DecoderFacts,
	now: number,
): Record<string, Cell> {
	return {
		decoder: cell([glyphSpan(f.role), sp(" "), sp(sanitize(f.row.id))]),
		process: processCell(f),
		decodes: decodesCell(f, now),
		drop: dropCell(f),
		lifetime: lifetimeCell(f),
		nominal: nominalCell(f),
		window: cell([
			sp(
				f.membership,
				f.membership === "?"
					? "unknown"
					: f.membership === "—"
						? "label"
						: "value",
			),
		]),
		restarts: cell([sp(formatCount(f.row.restartCount))]),
		errors: cell([sp(formatCount(f.row.stats.errors))]),
		events: cell([sp(formatCount(f.row.stats.eventsOut))]),
		iq: cell([sp(formatBytes(f.row.stats.bytesIn))]),
	}
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
	col("nominal", 15, 15, 3, "left", header("nominal MHz")),
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
	col("iq", 8, 9, 6, "right", header("IQ in")),
	col("drop", 8, 8, 1, "right", header("drop", "drop now")),
	col("lifetime", 8, 8, 4, "right", header("lifetime")),
	col("nominal", 15, 15, 7, "left", header("nominal MHz")),
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

/** The column set a table actually lays out: both exported sets switch to the narrow set below 79 columns. */
export function decoderColumnsFor(
	columns: readonly ColumnSpec[],
	width: number,
): readonly ColumnSpec[] {
	const known = columns === OVERVIEW_COLUMNS || columns === DECODERS_COLUMNS
	return known && width < NARROW_BELOW ? NARROW_COLUMNS : columns
}

export interface DecoderTable {
	header: Line
	rows: Line[]
	shownIds: string[]
}

/** maxRows includes the "+N more" marker row; the selected row is always kept visible. */
export function decoderTable(
	facts: readonly DecoderFacts[],
	columns: readonly ColumnSpec[],
	width: number,
	maxRows: number,
	selectedId: string | null,
	now: number,
): DecoderTable {
	const cols = decoderColumnsFor(columns, width)
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
		const cells = decoderCells(f, now)
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
	if (!fits) rows.push([sp(`  +${facts.length - shown.length} more`, "label")])
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
	if (lane.error || state.conn.rest.firstFailAt !== null)
		return [sp(`no data ${glyphs().sep} API unreachable`, "label")]
	return [sp("fetching /api/decoders", "label")]
}

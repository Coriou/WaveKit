import { iqView, isFresh, isOld } from "../data/freshness.js"
import type { AppState } from "../data/types.js"
import { windowFor } from "../data/window.js"
import { fitGroups } from "../ui/fit.js"
import {
	formatAge,
	formatClock,
	formatClockShort,
	formatMHz,
	formatMHzBare,
	formatMSps,
	formatRate,
	formatSampleAge,
	formatWindow,
} from "../ui/format.js"
import { overviewBudget } from "../ui/frame.js"
import { sp, type Group, type Line, type Role } from "../ui/line.js"
import { glyphSpan } from "../ui/strip.js"
import { padEnd, sanitize, truncateLine } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { UiState } from "../ui/ui-state.js"
import {
	OVERVIEW_COLUMNS,
	decoderFacts,
	decoderTable,
	decodersPlaceholder,
} from "./decoder-rows.js"
import {
	feedCounts,
	feedLines,
	interleave,
	newestFirst,
} from "./message-rows.js"

const GROUP_SEP = "   "
const title = (t: string): Line => [sp(padEnd(t, 10), "label", true)]
const label = (t: string): Line => [sp(padEnd(t, 10), "label")]

/** Core reports source URLs as `host:port` (no scheme) or a full URL; anything else is not shown. */
function hostOf(url: string | undefined): string | null {
	if (!url) return null
	const bare = sanitize(url).trim()
	if (
		/^[A-Za-z0-9.\-]+:\d{1,5}$/.test(bare) ||
		/^\[[0-9A-Fa-f:.]+\]:\d{1,5}$/.test(bare)
	)
		return bare
	try {
		const host = new URL(bare).host
		return host === "" ? null : host
	} catch {
		return null
	}
}

/** Spec §6.1 receiver rows: groups drop by priority (relay clients and centre first). */
export function receiverSummary(state: AppState, width: number): [Line, Line] {
	const now = state.now
	const src = state.sources.value?.[0]
	const sep = ` ${glyphs().sep} `
	if (!src) {
		const why =
			state.sources.error || state.conn.rest.firstFailAt !== null
				? "no data · API unreachable"
				: "fetching /api/sources"
		return [[...title("RECEIVER"), sp(why, "label")], label("window")]
	}
	const old = isOld(state.sources, now)
	const v = (
		t: string,
		role: Role = "value",
	): { text: string; role: Role } => ({ text: t, role: old ? "old" : role })
	const iq = iqView(
		src,
		isFresh(state.sources, now),
		state.metrics[src.id],
		now,
	)
	const host = hostOf(src.url)
	// Server strings are sanitised before they reach a line.
	const srcId = sanitize(src.id)
	const transport = src.type !== undefined ? sanitize(src.type) : "source"
	const age = src.activity?.sampleAgeMs
	const relay = state.relay.value
	const rate: Line = [v(formatRate(iq.rateBytesPerSec))]
	const rateRich: Line = [
		...rate,
		sp(sep, "label"),
		v(formatMSps(src.caps.sampleRate)),
	]
	const relayText = relay
		? `relay ${relay.clientsConnected} client${relay.clientsConnected === 1 ? "" : "s"}`
		: null
	// Priorities: activity first, then the source identity, then rates; relay clients are the richest
	// rate variant so they are the first thing to go (spec §6.1 "relay clients and centre first").
	const row1: Group[] = [
		{
			priority: 1,
			variants: [
				[...title("RECEIVER"), v(srcId)],
				[
					...title("RECEIVER"),
					v(srcId),
					sp(`${sep}${transport}${host ? ` ${host}` : ""}`, "label"),
				],
			],
		},
		{
			priority: 0,
			variants: [
				[glyphSpan(iq.glyph), v(` ${iq.word}`)],
				...(iq.word === "streaming" && age !== null && age !== undefined
					? [
							[
								glyphSpan(iq.glyph),
								v(` ${iq.word}`),
								sp(`${sep}sample age ${formatSampleAge(age)}`, "label"),
							],
						]
					: []),
			],
		},
		{
			priority: 2,
			variants: [
				rate,
				rateRich,
				...(relayText
					? [[...rateRich, sp(`${GROUP_SEP}${relayText}`, "label")]]
					: []),
			],
		},
	]
	const win = windowFor(src.id, state.tuner.value, state.sources.value, relay)
	const tuner = state.tuner.value?.find(t => t.sourceId === src.id)
	const owner = tuner
		? tuner.controlMode === "external"
			? "external control"
			: "wavekit control"
		: null
	const ownerIp =
		relay?.controlClientRemote !== undefined
			? sanitize(relay.controlClientRemote.split(":")[0] ?? "")
			: undefined
	const lastCmd = tuner?.lastCommandAt
		? Date.parse(tuner.lastCommandAt)
		: Number.NaN
	const row2: Group[] = [
		{
			priority: 0,
			variants: win
				? [
						[...label("window"), v(formatWindow(win.loHz, win.hiHz))],
						[
							...label("window"),
							v(formatWindow(win.loHz, win.hiHz)),
							sp(`${sep}centre ${formatMHzBare(win.centreHz, 4)}`, "label"),
						],
					]
				: [[...label("window"), sp("?", "unknown")]],
		},
		...(owner
			? [
					{
						priority: 1,
						variants: [
							[v(owner)],
							...(owner === "external control" && ownerIp
								? [[v(owner), sp(`${sep}${ownerIp}`, "label")]]
								: []),
						],
					},
				]
			: []),
		...(Number.isFinite(lastCmd)
			? [
					{
						priority: 2,
						variants: [
							[sp(`last command ${formatAge(now - lastCmd)} ago`, "label")],
						],
					},
				]
			: []),
	]
	return [
		fitGroups(row1, width, { sep: GROUP_SEP }),
		fitGroups(row2, width, { sep: GROUP_SEP }),
	]
}

/** MESSAGES header: live counts, or "feed stopped" while the WS is down (spec §6.1). */
export function feedHeader(state: AppState): Line {
	const c = feedCounts(state.messages.ring, state.now)
	const sep = ` ${glyphs().sep} `
	if (
		state.conn.ws.state !== "open" &&
		state.conn.ws.since !== null &&
		c.cached > 0
	) {
		return [
			...title("MESSAGES"),
			sp(
				`feed stopped ${formatClock(state.conn.ws.since)}${sep}${c.cached} cached`,
				"label",
			),
		]
	}
	return [
		...title("MESSAGES"),
		sp(`${c.in60s} in 60s${sep}${c.total} total`, "label"),
	]
}

/** Spec §6.3 empty state: no decodes since … · n of m decoders in window · rx …. */
export function emptyFeedLine(state: AppState): Line {
	const facts = decoderFacts(state)
	const since = state.conn.ws.since ?? state.now
	const inWin = facts.filter(f => f.membership === "in").length
	// R44: the window's centre (first positive), so a tuner frequency of 0 never prints.
	const tuner = state.tuner.value?.[0]
	const sourceId = tuner?.sourceId ?? state.sources.value?.[0]?.id
	const centre =
		sourceId === undefined
			? undefined
			: windowFor(
					sourceId,
					state.tuner.value,
					state.sources.value,
					state.relay.value,
				)?.centreHz
	const sep = ` ${glyphs().sep} `
	const parts = [
		`no decodes since ${formatClockShort(since)} (${formatAge(state.now - since)})`,
		...(facts.length > 0
			? [`${inWin} of ${facts.length} decoders in window`]
			: []),
		...(centre !== undefined ? [`rx ${formatMHz(centre)}`] : []),
	]
	return [sp(parts.join(sep), "label")]
}

export interface OverviewModel {
	layout: "stacked" | "columns"
	left: Line[]
	right: Line[]
	leftWidth: number
	rightWidth: number
	rowIds: string[]
	pageSize: number
}

export function overviewModel(
	state: AppState,
	ui: UiState,
	width: number,
	height: number,
	roomy: boolean,
): OverviewModel {
	const facts = decoderFacts(state)
	const b = overviewBudget(width + 1, height, roomy, facts.length)
	const leftWidth = b.layout === "columns" ? b.leftWidth : width
	const receiver = receiverSummary(state, leftWidth)
	const table = decoderTable(
		facts,
		OVERVIEW_COLUMNS,
		leftWidth,
		b.decoderRows + b.more,
		ui.selected.overview,
		state.now,
	)
	const placeholder = decodersPlaceholder(state)
	const decoderLines = placeholder
		? [table.header, placeholder]
		: [table.header, ...table.rows]
	const msgWidth = b.layout === "columns" ? b.rightWidth : width
	const ring = state.messages.ring
	const rows = interleave(newestFirst(ring), ring.gaps)
	const feedOld = state.conn.ws.state !== "open"
	const feed =
		rows.length > 0
			? feedLines(rows, msgWidth, b.messageRows, null, state.now, feedOld).lines
			: [emptyFeedLine(state)]
	const messages = [feedHeader(state), ...feed].map(l =>
		truncateLine(l, msgWidth),
	)
	const left = [
		...receiver,
		...(b.gapAfterReceiver ? [[]] : []),
		...decoderLines,
	]
	if (b.layout === "columns") {
		return {
			layout: "columns",
			left: left.slice(0, height),
			right: messages.slice(0, height),
			leftWidth,
			rightWidth: b.rightWidth,
			rowIds: facts.map(f => f.row.id),
			pageSize: b.decoderRows,
		}
	}
	const stacked = [...left, ...(b.gapAfterDecoders ? [[]] : []), ...messages]
	return {
		layout: "stacked",
		left: stacked.slice(0, height),
		right: [],
		leftWidth,
		rightWidth: 0,
		rowIds: facts.map(f => f.row.id),
		pageSize: b.decoderRows,
	}
}

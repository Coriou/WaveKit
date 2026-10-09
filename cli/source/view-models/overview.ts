import { iqView, isFresh, isOld } from "../data/freshness.js"
import type { AppState } from "../data/types.js"
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
import { rxValues, windowCount } from "./chrome.js"
import { remoteHost } from "./net.js"
import { sp, type Group, type Line, type Role } from "../ui/line.js"
import { glyphSpan } from "../ui/strip.js"
import { padEnd, sanitize, truncateLine } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { UiState } from "../ui/ui-state.js"
import {
	decoderFacts,
	decoderTable,
	decodersPlaceholder,
} from "./decoder-rows.js"
import {
	aircraftLookup,
	feedCounts,
	feedLines,
	in60sText,
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

/** The Overview's source: the first listed one (the receiver row and the empty-feed line agree). */
function primarySource(state: AppState) {
	return state.sources.value?.[0]
}

/** Spec §6.1 receiver rows: groups drop by priority (relay clients and centre first). */
export function receiverSummary(state: AppState, width: number): [Line, Line] {
	const now = state.now
	const src = primarySource(state)
	const sep = ` ${glyphs().sep} `
	if (!src) {
		const why =
			state.sources.error || state.conn.rest.firstFailAt !== null
				? `no data${sep}API unreachable`
				: "fetching /api/sources"
		return [
			[...title("RECEIVER"), sp(why, "label")],
			[...label("window"), sp("?", "unknown")],
		]
	}
	const old = isOld(state.sources, now)
	const role = (r: Role, isOldLane: boolean): Role => (isOldLane ? "old" : r)
	const v = (t: string, r: Role = "value"): { text: string; role: Role } => ({
		text: t,
		role: role(r, old),
	})
	const iq = iqView(
		src,
		isFresh(state.sources, now),
		state.metrics[src.id],
		now,
	)
	const host = hostOf(src.url)
	// Server strings are sanitised before they reach a line; no made-up transport word (M6).
	const srcId = sanitize(src.id)
	const transport = src.type !== undefined ? sanitize(src.type) : null
	const ident = [transport, host]
		.filter((x): x is string => x !== null)
		.join(" ")
	const age = src.activity?.sampleAgeMs
	const relay = state.relay.value
	const { centre, rate } = rxValues(state, src.id)
	const rateLine: Line = [v(formatRate(iq.rateBytesPerSec))]
	// M1: the sample rate follows the window rule; unknown is left out, never 0.
	const rateRich: Line | null = rate
		? [
				...rateLine,
				sp(sep, "label"),
				{ text: formatMSps(rate.v), role: role("value", rate.old) },
			]
		: null
	// M5: a disabled relay has no clients to report.
	const relayText =
		relay && relay.enabled
			? `relay ${relay.clientsConnected} client${relay.clientsConnected === 1 ? "" : "s"}`
			: null
	const others = (state.sources.value?.length ?? 1) - 1
	// M2: a stale source keeps its sample age ("no samples 23s", §9).
	const word =
		iq.ageMs !== null && iq.word === "no samples"
			? `${iq.word} ${formatAge(iq.ageMs)}`
			: iq.word
	// Priorities: activity first, then the source identity, then rates; relay clients are the richest
	// rate variant so they are the first thing to go (spec §6.1 "relay clients and centre first").
	const row1: Group[] = [
		{
			priority: 1,
			variants: [
				[...title("RECEIVER"), v(srcId)],
				...(ident !== ""
					? [[...title("RECEIVER"), v(srcId), sp(`${sep}${ident}`, "label")]]
					: []),
			],
		},
		{
			priority: 0,
			variants: [
				[glyphSpan(iq.glyph), v(` ${word}`)],
				...(iq.word === "streaming" && age !== null && age !== undefined
					? [
							[
								glyphSpan(iq.glyph),
								v(` ${word}`),
								sp(`${sep}sample age ${formatSampleAge(age)}`, "label"),
							],
						]
					: []),
			],
		},
		{
			priority: 2,
			variants: [
				rateLine,
				...(rateRich ? [rateRich] : []),
				...(relayText
					? [
							[
								...(rateRich ?? rateLine),
								sp(`${GROUP_SEP}${relayText}`, "label"),
							],
						]
					: []),
			],
		},
		// M7: further sources are counted, not hidden.
		...(others > 0
			? [
					{
						priority: 3,
						variants: [
							[sp(`+${others} source${others === 1 ? "" : "s"}`, "label")],
						],
					},
				]
			: []),
	]
	const tunerLaneOld = isOld(state.tuner, now)
	const tuner = state.tuner.value?.find(t => t.sourceId === src.id)
	const owner = tuner
		? tuner.controlMode === "external"
			? "external control"
			: "wavekit control"
		: null
	const remote = relay?.controlClientRemote
	const ownerIp = remote !== undefined ? remoteHost(remote) || null : null
	const lastCmd = tuner?.lastCommandAt
		? Date.parse(tuner.lastCommandAt)
		: Number.NaN
	// M3: window dims by the lanes its centre and rate came from; owner and last
	// command by the tuner lane; the owner address by the relay lane.
	const winOld = (centre?.old ?? false) || (rate?.old ?? false)
	const centreText = centre ? `centre ${formatMHzBare(centre.v, 4)}` : null
	const windowVariants: Line[] =
		centre && rate
			? [
					[
						...label("window"),
						{
							text: formatWindow(centre.v - rate.v / 2, centre.v + rate.v / 2),
							role: role("value", winOld),
						},
					],
					[
						...label("window"),
						{
							text: formatWindow(centre.v - rate.v / 2, centre.v + rate.v / 2),
							role: role("value", winOld),
						},
						{ text: `${sep}${centreText ?? ""}`, role: role("label", winOld) },
					],
				]
			: centre
				? // I3 (R53): a known centre is shown even when the rate is not.
					[
						[
							...label("window"),
							sp("?", "unknown"),
							sp(sep, "label"),
							{ text: centreText ?? "", role: role("value", winOld) },
						],
					]
				: [[...label("window"), sp("?", "unknown")]]
	const row2: Group[] = [
		{ priority: 0, variants: windowVariants },
		...(owner
			? [
					{
						priority: 1,
						variants: [
							[{ text: owner, role: role("value", tunerLaneOld) }],
							...(owner === "external control" && ownerIp
								? [
										[
											{ text: owner, role: role("value", tunerLaneOld) },
											{
												text: `${sep}${ownerIp}`,
												role: role("label", isOld(state.relay, now)),
											},
										],
									]
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
							[
								{
									text: `last command ${formatAge(now - lastCmd)} ago`,
									role: role("label", tunerLaneOld),
								},
							],
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

/**
 * The live feed has been open at some point: it is open now, it delivered messages, or
 * a gap was recorded (a gap is only opened for a socket that was open).
 */
function feedEverLive(state: AppState): boolean {
	const ring = state.messages.ring
	return (
		state.conn.ws.state === "open" || ring.total > 0 || ring.gaps.length > 0
	)
}

/** MESSAGES header: live counts, or "feed stopped" while the WS is down (spec §6.1). */
export function feedHeader(state: AppState): Line {
	const c = feedCounts(state.messages.ring, state.now)
	const sep = ` ${glyphs().sep} `
	// I1: counts are unknown until the feed has been live; never "0 in 60s".
	if (!feedEverLive(state)) {
		return [...title("MESSAGES"), sp(`? in 60s${sep}? total`, "label")]
	}
	// I2: the open gap's start is when the feed stopped; ws.since moves on every retry.
	const openGap = state.messages.ring.gaps.findLast(g => g.to === null)
	// The feed was live and is down: say when it stopped, with or without a cache.
	if (state.conn.ws.state !== "open") {
		const stopped = openGap?.from ?? state.conn.ws.since
		return [
			...title("MESSAGES"),
			sp(
				`feed stopped${stopped !== null ? ` ${formatClock(stopped)}` : ""}${c.cached > 0 ? `${sep}${c.cached} cached` : ""}`,
				"label",
			),
		]
	}
	return [
		...title("MESSAGES"),
		sp(`${in60sText(c)} in 60s${sep}${c.total} total`, "label"),
	]
}

/** §9 copy for an empty feed that is not live: the empty-state line needs a live feed (§6.3). */
function feedPlaceholder(state: AppState): Line {
	const c = state.conn
	const sep = ` ${glyphs().sep} `
	const apiDown = c.rest.firstFailAt !== null || c.discovery.mode === "failed"
	if (apiDown) return [sp(`no data${sep}API unreachable`, "label")]
	if (c.ws.state === "closed")
		return [sp(`no data${sep}live feed down`, "label")]
	return [sp("connecting to /ws", "label")]
}

/** Spec §6.3 empty state: no decodes since … · n of m decoders in window · rx …. */
export function emptyFeedLine(state: AppState): Line {
	const facts = decoderFacts(state)
	const since = state.conn.ws.since ?? state.now
	// I4: one rule with the strip (windowCount): tuned decoders prove nothing; — is not counted.
	const win = windowCount(
		facts.map(f => ({
			membership: f.membership,
			tuned: f.nominal === "tuned",
		})),
	)
	// R44/R53: the centre on its own (first positive), for the receiver row's source (M7).
	const centre = rxValues(
		state,
		primarySource(state)?.id ?? state.tuner.value?.[0]?.sourceId,
	).centre?.v
	const sep = ` ${glyphs().sep} `
	const parts = [
		`no decodes since ${formatClockShort(since)} (${formatAge(state.now - since)})`,
		...(win ? [`${win.inWindow} of ${win.counted} decoders in window`] : []),
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

/** M8: what keyInfo needs (row ids, page size) without building the whole model. */
export function overviewKeys(
	state: AppState,
	width: number,
	height: number,
	roomy: boolean,
): { rowIds: string[]; pageSize: number } {
	const facts = decoderFacts(state)
	const b = overviewBudget(width + 1, height, roomy, facts.length)
	return { rowIds: facts.map(f => f.row.id), pageSize: b.decoderRows }
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
	// "overview" picks the narrow column set below 79 columns; with the decoders
	// lane old (API down, cached view) every row is dim (§6.1).
	const table = decoderTable(
		facts,
		"overview",
		leftWidth,
		b.decoderRows + b.more,
		ui.selected.overview,
		state.now,
		{ dim: isOld(state.decoders, state.now) },
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
			? feedLines(
					rows,
					msgWidth,
					b.messageRows,
					null,
					state.now,
					feedOld,
					aircraftLookup(state),
				).lines
			: state.conn.ws.state === "open"
				? [emptyFeedLine(state)]
				: [feedPlaceholder(state)]
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

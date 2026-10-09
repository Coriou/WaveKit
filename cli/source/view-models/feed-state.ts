import { iqSummary } from "../data/freshness.js"
import { POLL_ENDPOINTS, type AppState, type LaneError } from "../data/types.js"
import { formatAge, formatClockShort, formatMHz } from "../ui/format.js"
import { sp, type Group } from "../ui/line.js"
import { glyphs } from "../ui/theme.js"
import { bannerConditions, rxValues, windowCount } from "./chrome.js"
import { followsCentre } from "../data/window.js"
import { decoderFacts } from "./decoder-rows.js"

/** Every polled endpoint failing, or discovery found nothing: core cannot be reached. */
function apiUnreachable(state: AppState): boolean {
	const c = state.conn
	if (c.discovery.mode === "failed") return true
	return (
		c.ws.state !== "open" &&
		c.rest.failing.length > 0 &&
		POLL_ENDPOINTS.every(e => c.rest.failing.includes(e))
	)
}

function reasonOf(err: LaneError | null): string {
	if (!err) return glyphs().unknown
	return err.kind === "http" ? String(err.status ?? "http") : err.message
}

/**
 * M4, R82: why a section has no data, one copy for every call site (Overview receiver,
 * Decoders placeholder, Receiver sections):
 * - only this endpoint failing (R57, the banner's rule): `no data · GET <path> failing · <reason>`
 * - REST failing while the WS is live: `no data · REST failing (timeout 2s) · ws live`
 * - core unreachable: `no data · API unreachable`
 * - otherwise: `fetching <path>`
 */
export function noDataText(state: AppState, path: string): string {
	const c = state.conn
	const sep = ` ${glyphs().sep} `
	const conds = bannerConditions(state)
	const ep = conds.find(x => x.kind === "endpoint" && x.path === path)
	if (ep?.kind === "endpoint")
		return `no data${sep}GET ${path} failing${sep}${ep.reason}`
	if (c.ws.state === "open" && c.rest.failing.length > 0)
		return `no data${sep}REST failing (${reasonOf(c.rest.lastError)})${sep}ws live`
	if (
		apiUnreachable(state) ||
		conds.some(x => x.kind === "api-down" || x.kind === "rest-down") ||
		c.rest.firstFailAt !== null
	)
		return `no data${sep}API unreachable`
	return `fetching ${path}`
}

const group = (text: string, priority: number): Group => ({
	priority,
	variants: [[sp(text, "label")]],
})

/**
 * M3: why the feed is empty, as fit-able groups: the first broken link of the chain
 * (API, live feed, IQ, tuned window) and nothing after it. A healthy chain says for how
 * long nothing decoded, then the window count, the rx centre and when the feed opened.
 * Shared by the Overview and Messages.
 */
export function emptyFeedGroups(state: AppState): Group[] {
	const c = state.conn
	const now = state.now
	if (c.ws.state !== "open") {
		if (apiUnreachable(state))
			return [group("no feed", 0), group("API unreachable", 0)]
		if (c.ws.state === "closed" && c.rest.lastOkAt !== null)
			return [
				group("no feed", 0),
				group(`ws closed${c.ws.code !== null ? ` ${c.ws.code}` : ""}`, 0),
				group("polling REST", 1),
			]
		return [group("no feed", 0), group("connecting to /ws", 0)]
	}
	const iq = iqSummary(state.sources, state.metrics, now)
	if (iq.glyph === "fault") {
		const src = state.sources.value?.[0]
		const age =
			iq.ageMs ??
			(state.sources.value?.length === 1
				? (src?.activity?.sampleAgeMs ?? null)
				: null)
		return [
			group("no decodes", 0),
			group(`iq ${iq.word}${age !== null ? ` ${formatAge(age)}` : ""}`, 0),
		]
	}
	const facts = decoderFacts(state)
	const win = windowCount(
		facts.map(f => ({
			membership: f.membership,
			followsCentre: followsCentre(f.row),
		})),
	)
	const centre = rxValues(
		state,
		state.sources.value?.[0]?.id ?? state.tuner.value?.[0]?.sourceId,
	).centre?.v
	const rx = centre !== undefined ? [group(`rx ${formatMHz(centre)}`, 1)] : []
	// R90 I1: decoders whose membership is ? are left out of both counts, and said.
	const unknown =
		win && win.unknown > 0 ? ` ${glyphs().sep} ${win.unknown} unknown` : ""
	if (win && win.inWindow === 0)
		return [
			group("no decodes", 0),
			group(`0 of ${win.counted} decoders in window${unknown}`, 0),
			...rx,
		]
	const since = c.ws.since ?? now
	return [
		group(`no decodes for ${formatAge(now - since)}`, 0),
		...(win
			? [group(`${win.inWindow} of ${win.counted} in window${unknown}`, 2)]
			: []),
		...rx,
		group(`since ${formatClockShort(since)}`, 3),
	]
}

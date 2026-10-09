import { iqSummary } from "../data/freshness.js"
import {
	ENDPOINT_PATHS,
	POLL_ENDPOINTS,
	type AppState,
	type Endpoint,
	type LaneError,
} from "../data/types.js"
import { formatAge, formatClockShort, formatMHz } from "../ui/format.js"
import { sp, type Group } from "../ui/line.js"
import { sanitize } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import { isFailing, type ProcState } from "../data/decoder-state.js"
import {
	bannerConditions,
	rxSourceId,
	rxValues,
	windowCount,
} from "./chrome.js"
import { followsCentre } from "../data/window.js"
import { decoderFacts, type DecoderFacts } from "./decoder-rows.js"

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
 * Decoders placeholder, Receiver sections), from this lane's endpoint only (final views):
 * - core unreachable: `no data · API unreachable`
 * - this endpoint failing alone (R57, the banner's rule): `no data · GET <path> failing · <reason>`
 * - every endpoint failing while the WS is live: `no data · REST failing (timeout 2s) · ws live`
 * - otherwise: `fetching <path>`
 * Only for a lane that has never answered; an answered empty lane says what came back.
 */
export function noDataText(state: AppState, path: string): string {
	const c = state.conn
	const sep = ` ${glyphs().sep} `
	const conds = bannerConditions(state)
	if (apiUnreachable(state) || conds.some(x => x.kind === "api-down"))
		return `no data${sep}API unreachable`
	const endpoint = ENDPOINTS.find(e => ENDPOINT_PATHS[e] === path)
	if (endpoint === undefined || !c.rest.failing.includes(endpoint))
		return `fetching ${path}`
	const ep = conds.find(x => x.kind === "endpoint" && x.path === path)
	if (ep?.kind === "endpoint")
		return `no data${sep}GET ${path} failing${sep}${ep.reason}`
	return `no data${sep}REST failing (${reasonOf(c.rest.lastError)})${sep}ws live`
}

const ENDPOINTS = Object.keys(ENDPOINT_PATHS) as Endpoint[]

/** The failing words for the empty-feed line: one word per kind of fault. */
const FAULT_WORD: Partial<Record<ProcState, string>> = {
	faulted: "faulted",
	"faulted-retry": "faulted",
	"crash-loop": "crash-loop",
	down: "down",
}

/** "dsd-fme, multimon-ng faulted"; mixed kinds: "dsd-fme faulted, multimon-ng down". */
function failingNames(facts: readonly DecoderFacts[]): string {
	const word = (f: DecoderFacts) => FAULT_WORD[f.proc] ?? f.proc
	const words = new Set(facts.map(word))
	const ids = facts.map(f => sanitize(f.row.id))
	if (words.size === 1) return `${ids.join(", ")} ${[...words][0] ?? ""}`
	return facts.map((f, i) => `${ids[i] ?? ""} ${word(f)}`).join(", ")
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
		if (c.ws.state === "closed")
			return [
				group("no feed", 0),
				group(`ws closed${c.ws.code !== null ? ` ${c.ws.code}` : ""}`, 0),
				...(c.rest.lastOkAt !== null ? [group("polling REST", 1)] : []),
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
	const centre = rxValues(state, rxSourceId(state)).centre?.v
	const rx = centre !== undefined ? [group(`rx ${formatMHz(centre)}`, 1)] : []
	// Final views: in-window decoders that are all failing explain the silence first.
	const inside = facts.filter(f => f.membership === "in")
	if (inside.length > 0 && inside.every(f => isFailing(f.proc)))
		return [group("no decodes", 0), group(failingNames(inside), 0), ...rx]
	// R90 I1: decoders whose membership is ? are left out of both counts, and said.
	const unknown =
		win && win.unknown > 0 ? ` ${glyphs().sep} ${win.unknown} unknown` : ""
	if (win && win.inWindow === 0)
		return [
			group("no decodes", 0),
			group(`0 of ${win.counted} in window${unknown}`, 0),
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

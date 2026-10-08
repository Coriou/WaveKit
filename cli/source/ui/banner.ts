import { fitGroups } from "./fit.js"
import { formatClock } from "./format.js"
import type { Group, Line } from "./line.js"
import { cellWidth, sanitize, truncate } from "./text.js"
import { glyphs } from "./theme.js"

export interface ApiDownCondition {
	kind: "api-down"
	reason: string
	retryAt: number | null
	asOf: number | null
	target: string | null
	tried: readonly string[]
}

export interface RestDownCondition {
	kind: "rest-down"
	reason: string
	retryAt: number | null
	asOf: number | null
}

export interface WsDownCondition {
	kind: "ws-down"
	code: number | null
	retryAt: number | null
}

export interface EndpointCondition {
	kind: "endpoint"
	path: string
	reason: string
}

export type BannerCondition =
	| ApiDownCondition
	| RestDownCondition
	| WsDownCondition
	| EndpointCondition

const RANK: Readonly<Record<BannerCondition["kind"], number>> = {
	"api-down": 0,
	"rest-down": 1,
	"ws-down": 2,
	endpoint: 3,
}

/**
 * Priorities (lower survives longer): the head, then `+N`, then the reason,
 * then the retry countdown, then the trailing context. `+N` therefore never
 * goes before the reason.
 */
const P = { head: 0, more: 1, reason: 2, retry: 3, tail: 4 } as const

/** Free text longer than this also gets a clipped minimal variant, so it cannot push out the countdown. */
const CLIP_COLS = 24

/** Minimal → rich variants of server or error text, sanitised here. */
function variantsOf(raw: string): string[] {
	const text = sanitize(raw)
	return cellWidth(text) > CLIP_COLS
		? [truncate(text, CLIP_COLS), text]
		: [text]
}

const plain = (text: string, priority: number): Group => ({
	priority,
	variants: variantsOf(text).map(v => [{ text: v, role: "value" }]),
})

function head(prefix: string, raw: string, suffix: string): Group {
	return {
		priority: P.head,
		variants: variantsOf(raw).map(v => [
			{ text: `${glyphs().attention} `, role: "attention", bold: true },
			{ text: `${prefix}${v}${suffix}`, role: "value", bold: true },
		]),
	}
}

function retry(retryAt: number | null, now: number): Group[] {
	if (retryAt === null) return []
	const s = Math.ceil((retryAt - now) / 1000)
	return [plain(s > 0 ? `retry in ${s}s` : "retrying", P.retry)]
}

function hostOf(url: string): string {
	try {
		return new URL(url).host
	} catch {
		return url
	}
}

function groupsFor(c: BannerCondition, now: number): Group[] {
	switch (c.kind) {
		case "api-down": {
			const out: Group[] = [head("", "API unreachable", "")]
			if (c.target === null && c.tried.length > 0)
				out.push(plain(`tried ${c.tried.join(", ")}`, P.reason))
			else out.push(plain(c.reason, P.reason))
			out.push(...retry(c.retryAt, now))
			if (c.asOf !== null)
				out.push(plain(`data as of ${formatClock(c.asOf)}`, P.tail))
			else if (c.target !== null) out.push(plain(hostOf(c.target), P.tail))
			return out
		}
		case "rest-down": {
			const out: Group[] = [
				head("", "REST failing", ""),
				plain(c.reason, P.reason),
				...retry(c.retryAt, now),
			]
			if (c.asOf !== null)
				out.push(plain(`REST data as of ${formatClock(c.asOf)}`, P.tail))
			return out
		}
		case "ws-down":
			// Display order follows the spec copy; `REST every 5s` (tail) still drops before `retry`.
			return [
				head("", "live feed down", ""),
				plain(c.code === null ? "ws closed" : `ws closed ${c.code}`, P.reason),
				plain("REST every 5s", P.tail),
				...retry(c.retryAt, now),
			]
		case "endpoint":
			return [
				head("GET ", c.path, " failing"),
				plain(c.reason, P.reason),
				plain("other endpoints answering", P.tail),
			]
	}
}

/** Spec §9: the highest-priority condition, plus `· +N` when more than one holds. Null when none. */
export function bannerLine(
	conds: readonly BannerCondition[],
	now: number,
	width: number,
): Line | null {
	if (conds.length === 0) return null
	const sorted = [...conds].sort((a, b) => RANK[a.kind] - RANK[b.kind])
	const first = sorted[0]
	if (!first) return null
	const groups = groupsFor(first, now)
	if (sorted.length > 1) groups.push(plain(`+${sorted.length - 1}`, P.more))
	return fitGroups(groups, width, {
		sep: [{ text: ` ${glyphs().sep} `, role: "label" }],
	})
}

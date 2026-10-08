import { fitGroups } from "./fit.js"
import { formatClock } from "./format.js"
import type { Group, Line } from "./line.js"
import { sanitize } from "./text.js"
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

/** Reasons, paths and hosts come from errors and servers, so they are sanitised here. */
const plain = (text: string, priority: number): Group => ({
	priority,
	variants: [[{ text: sanitize(text), role: "value" }]],
})

function head(text: string): Group {
	return {
		priority: 0,
		variants: [
			[
				{ text: `${glyphs().attention} `, role: "attention", bold: true },
				{ text: sanitize(text), role: "value", bold: true },
			],
		],
	}
}

function retry(retryAt: number | null, now: number): Group[] {
	if (retryAt === null) return []
	return [
		plain(`retry in ${Math.max(0, Math.ceil((retryAt - now) / 1000))}s`, 2),
	]
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
			const out: Group[] = [head("API unreachable")]
			if (c.target === null && c.tried.length > 0)
				out.push(plain(`tried ${c.tried.join(", ")}`, 1))
			else out.push(plain(c.reason, 1))
			out.push(...retry(c.retryAt, now))
			if (c.asOf !== null)
				out.push(plain(`data as of ${formatClock(c.asOf)}`, 3))
			else if (c.target !== null) out.push(plain(hostOf(c.target), 3))
			return out
		}
		case "rest-down": {
			const out: Group[] = [
				head("REST failing"),
				plain(c.reason, 1),
				...retry(c.retryAt, now),
			]
			if (c.asOf !== null)
				out.push(plain(`REST data as of ${formatClock(c.asOf)}`, 3))
			return out
		}
		case "ws-down":
			// Display order follows the spec copy; `REST every 5s` (3) still drops before `retry` (2).
			return [
				head("live feed down"),
				plain(c.code === null ? "ws closed" : `ws closed ${c.code}`, 1),
				plain("REST every 5s", 3),
				...retry(c.retryAt, now),
			]
		case "endpoint":
			return [
				head(`GET ${c.path} failing`),
				plain(c.reason, 1),
				plain("other endpoints answering", 3),
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
	if (sorted.length > 1) groups.push(plain(`+${sorted.length - 1}`, 4))
	return fitGroups(groups, width, {
		sep: [{ text: ` ${glyphs().sep} `, role: "label" }],
	})
}

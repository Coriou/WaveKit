// Palette ranking (DESIGN.md: exact intents always win; usage boosts the score): a fuzzy match over a row's
// title and keywords, and a per-browser frecency list. Pure apart from the storage passed in.
import type { KeyValueStorage } from "../../shell/theme.ts"

export interface FuzzyMatch {
	score: number
	/** Matched character positions in the text, for highlighting. */
	idx: number[]
}

const WORD_START = /[\s·›(\-“"/]/

/**
 * Prefix beats a word start beats a substring beats letters in order (word starts and runs score more). Null when
 * the letters are not all there or are too scattered to mean anything.
 */
export function fuzzy(query: string, text: string): FuzzyMatch | null {
	const q = query.trim().toLowerCase()
	if (!q) return null
	const t = text.toLowerCase()
	const span = (a: number, b: number) =>
		Array.from({ length: b - a }, (_, i) => a + i)
	const at = t.indexOf(q)
	if (at === 0) return { score: 100 - t.length * 0.1, idx: span(0, q.length) }
	if (at > 0)
		return {
			score: (WORD_START.test(t[at - 1] ?? "") ? 80 : 50) - at * 0.3,
			idx: span(at, at + q.length),
		}
	const qs = q.replace(/\s+/g, "")
	let i = 0
	let last = -2
	let score = 0
	const idx: number[] = []
	for (let j = 0; j < t.length && i < qs.length; j++) {
		if (t[j] !== qs[i]) continue
		score +=
			j === 0 || WORD_START.test(t[j - 1] ?? "") ? 6 : j === last + 1 ? 3 : 0.5
		idx.push(j)
		last = j
		i++
	}
	if (i < qs.length || score < qs.length * 2) return null
	const first = idx[0] ?? 0
	return { score: 20 + score - (last - first) * 0.2, idx }
}

function keywordMatch(query: string, key: string): FuzzyMatch | null {
	const q = query.trim().toLowerCase()
	return q && key.toLowerCase().includes(q) ? fuzzy(q, key) : null
}

export interface Rankable {
	readonly id: string
	readonly title: string
	readonly keys?: readonly string[] | undefined
	/** Other names for the row, matched like its title ("Light" for "Theme › Light"). */
	readonly aliases?: readonly string[] | undefined
}

export type Ranked<T> = T & { readonly score: number; readonly idx: number[] }

/** Items matching `query`, best first. A keyword match counts a little less than a title match. */
export function rank<T extends Rankable>(
	items: readonly T[],
	query: string,
	boost: (id: string) => number = () => 0,
): Ranked<T>[] {
	const out: Ranked<T>[] = []
	for (const it of items) {
		let best = fuzzy(query, it.title)
		for (const a of it.aliases ?? []) {
			const m = keywordMatch(query, a)
			if (m && (!best || m.score > best.score))
				best = { score: m.score, idx: [] }
		}
		// keywords match as written (a prefix or a run of letters), never as scattered letters
		for (const k of it.keys ?? []) {
			const m = keywordMatch(query, k)
			if (m && (!best || m.score * 0.85 > best.score))
				best = { score: m.score * 0.85, idx: [] }
		}
		if (best)
			out.push({ ...it, score: best.score + boost(it.id), idx: best.idx })
	}
	return out.sort((a, b) => b.score - a.score)
}

// ---- recent (frecency)

export interface RecentEntry {
	readonly id: string
	/** Times run. */
	readonly n: number
	/** Last run, ms since the epoch. */
	readonly t: number
}

export const RECENT_KEY = "wavekit.web.palette.recent"
const RECENT_MAX = 24
const DAY = 86_400_000

/** Frecency: uses, decayed by age (a week-old command counts about a third). */
export function frecency(e: RecentEntry, now: number): number {
	const age = Math.max(0, now - e.t) / DAY
	return e.n / (1 + age / 3)
}

export function parseRecent(raw: string | null): RecentEntry[] {
	if (!raw) return []
	try {
		const data: unknown = JSON.parse(raw)
		if (!Array.isArray(data)) return []
		return data
			.filter(
				(x): x is RecentEntry =>
					typeof x === "object" &&
					x !== null &&
					typeof (x as RecentEntry).id === "string" &&
					typeof (x as RecentEntry).n === "number" &&
					typeof (x as RecentEntry).t === "number",
			)
			.slice(0, RECENT_MAX)
	} catch {
		return []
	}
}

/** Remembers what the palette ran, per browser; a blocked storage keeps it for the page only. */
export class RecentList {
	#entries: RecentEntry[]
	readonly #storage: KeyValueStorage | null

	constructor(storage: KeyValueStorage | null) {
		this.#storage = storage
		let raw: string | null = null
		try {
			raw = storage?.getItem(RECENT_KEY) ?? null
		} catch {
			raw = null
		}
		this.#entries = parseRecent(raw)
	}

	entries(): readonly RecentEntry[] {
		return this.#entries
	}

	/** Ids by frecency, best first. */
	ids(now: number): string[] {
		return [...this.#entries]
			.sort((a, b) => frecency(b, now) - frecency(a, now))
			.map(e => e.id)
	}

	/** Score boost for ranking typed results: up to ~10 points. */
	boost(id: string, now: number): number {
		const e = this.#entries.find(x => x.id === id)
		return e ? Math.min(10, frecency(e, now) * 3) : 0
	}

	used(id: string, now: number): void {
		const old = this.#entries.find(x => x.id === id)
		this.#entries = [
			{ id, n: (old?.n ?? 0) + 1, t: now },
			...this.#entries.filter(x => x.id !== id),
		].slice(0, RECENT_MAX)
		try {
			this.#storage?.setItem(RECENT_KEY, JSON.stringify(this.#entries))
		} catch {
			// storage blocked or full: kept for this page
		}
	}
}

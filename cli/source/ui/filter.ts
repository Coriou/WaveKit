import type { MessageCategory } from "../data/types.js"
import type { PresetName } from "./ui-state.js"

export interface FilterSpec {
	/** AND of OR-groups. */
	terms: string[][]
	emerg: boolean
}

export const EMPTY_FILTER: FilterSpec = { terms: [], emerg: false }
export const EMERG_TOKEN = "!emerg"

export function parseFilter(text: string): FilterSpec {
	const terms: string[][] = []
	let emerg = false
	for (const tok of text.trim().split(/\s+/)) {
		if (tok === "") continue
		if (tok.toLowerCase() === EMERG_TOKEN) {
			emerg = true
			continue
		}
		const alts = tok
			.toLowerCase()
			.split(",")
			.filter(x => x !== "")
		if (alts.length > 0) terms.push(alts)
	}
	return { terms, emerg }
}

export function printFilter(f: FilterSpec): string {
	return [
		...f.terms.map(t => t.join(",")),
		...(f.emerg ? [EMERG_TOKEN] : []),
	].join(" ")
}

export interface FilterSubject {
	text: string
	emergency: boolean
	category: MessageCategory
}

export function matchesFilter(f: FilterSpec, s: FilterSubject): boolean {
	if (f.emerg && !s.emergency) return false
	const t = s.text.toLowerCase()
	return f.terms.every(alts => alts.some(a => t.includes(a)))
}

export function matchesPreset(p: PresetName, c: MessageCategory): boolean {
	if (p === "all") return true
	if (p === "data") return c === "data" || c === "other"
	return p === c
}

export function applyFilter<T>(
	items: readonly T[],
	f: FilterSpec,
	preset: PresetName,
	subject: (t: T) => FilterSubject,
): T[] {
	return items.filter(x => {
		const s = subject(x)
		return matchesPreset(preset, s.category) && matchesFilter(f, s)
	})
}

// The Activity list header's count: events the core counts for the search, in the same unit as the category
// chips (the facets read), never the folded rows on screen. A column (its own search, no facets read) and a
// core without facets fall back to the loaded events, "+" while older ones are not loaded.

export interface HeaderCountInput {
	/** Per chip, the core's count for the search without its chip; null until read. */
	counts: Readonly<Record<string, number>> | null
	/** The core's count for the search without its chip, every category; null until read. */
	total: number | null
	/** The category chip of the search, if any. */
	chip: string | null
	/** The core stopped counting at its scan cap: the counts are lower bounds ("50,000+"). */
	truncated?: boolean
	/** The list shows a column's search (no facets read for it). */
	column: boolean
	/** Events loaded in the list. */
	events: number
	/** Older events are not loaded yet. */
	more: boolean
}

export interface HeaderCount {
	text: string
	title: string
	/** Counted by the core (true) or from the loaded events (false). */
	core: boolean
}

/** A count as the header and the category chips show it: "2,350". */
export const countText = (n: number): string => n.toLocaleString("en-US")

const plural = (n: number, word: string) =>
	`${countText(n)} ${word}${n === 1 ? "" : "s"}`

export function headerCount(i: HeaderCountInput): HeaderCount {
	const core =
		i.column || i.total === null
			? null
			: i.chip === null
				? i.total
				: (i.counts?.[i.chip] ?? null)
	if (core !== null)
		return i.truncated === true
			? {
					text: `${countText(core)}+`,
					title: `at least ${countText(core)} events for this search; WaveKit stops counting there`,
					core: true,
				}
			: {
					text: countText(core),
					title: `${plural(core, "event")} for this search, counted by WaveKit`,
					core: true,
				}
	return {
		text: `${countText(i.events)}${i.more ? "+" : ""}`,
		title: `${plural(i.events, "loaded event")}${i.more ? "; older events are not loaded yet" : ""}`,
		core: false,
	}
}

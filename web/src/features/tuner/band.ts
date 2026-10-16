// Band plan wording for the Tuner island and the tuned card.
import type {
	BandChannel,
	DisplayGroup,
	ResolvedBandPlanView,
} from "@wavekit/api-types"
import { formatMHz } from "../format.ts"

const GROUP: Readonly<Record<DisplayGroup, { name: string; token: string }>> = {
	marine: { name: "Marine", token: "marine" },
	air: { name: "Air", token: "air" },
	"ism-srd": { name: "ISM / SRD", token: "srd" },
	pagers: { name: "Pagers", token: "pagers" },
	"personal-radio": { name: "Personal radio", token: "personal" },
	amateur: { name: "Amateur", token: "amateur" },
	"land-mobile": { name: "Land mobile", token: "landmobile" },
	broadcast: { name: "Broadcast", token: "broadcast" },
	other: { name: "Other", token: "other" },
}

export function groupName(group: DisplayGroup): string {
	return GROUP[group].name
}

/** The group's swatch colour token. */
export function groupColour(group: DisplayGroup): string {
	return `var(--wk-grp-${GROUP[group].token})`
}

export interface ChannelSuggestion {
	key: string
	label: string
	hz: number
	band: string
	group: DisplayGroup
}

/**
 * Plan channels whose name or alias matches typed text ("ch 16", "pmr 3", "ais"); empty for a
 * plain number. Prefix matches first, at most `limit`.
 */
export function channelSuggestions(
	view: ResolvedBandPlanView | null,
	query: string,
	limit = 6,
): ChannelSuggestion[] {
	const q = query.trim().toLowerCase().replace(/\s+/g, " ")
	if (!view || !/[a-z]/.test(q)) return []
	const scored: { s: ChannelSuggestion; score: number }[] = []
	const seen = new Set<string>()
	for (const rb of view.bands) {
		for (const ch of rb.band.channels as readonly BandChannel[]) {
			const names = [ch.name, ...ch.aliases].map(n => n.toLowerCase())
			const score = names.some(n => n === q)
				? 0
				: names.some(n => n.startsWith(q))
					? 1
					: names.some(n => n.includes(q))
						? 2
						: -1
			if (score < 0) continue
			const key = `${rb.key}/${ch.id}`
			if (seen.has(key)) continue
			seen.add(key)
			scored.push({
				score,
				s: {
					key,
					label: ch.name,
					hz: ch.frequencyHz,
					band: rb.band.name,
					group: rb.band.group,
				},
			})
		}
	}
	return scored
		.sort((a, b) => a.score - b.score || a.s.hz - b.s.hz)
		.slice(0, limit)
		.map(x => x.s)
}

export function suggestionText(s: ChannelSuggestion): string {
	return `${s.label} · ${s.band} · ${formatMHz(s.hz)}`
}

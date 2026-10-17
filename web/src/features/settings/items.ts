// What the Settings drawer lists, in order: the eight groups with their More folds and Display's "On this device"
// block, a decoder's page, or the search results with breadcrumbs. Pure, so the order and the folds test in node.
import {
	FILTERS,
	SETTING_GROUPS,
	filterSuggestion,
	groupOf,
	haystack,
	matches,
	passes,
	type SettingFilter,
	type SettingGroupId,
	type SettingRow,
} from "./model.ts"

export interface HeadItem {
	readonly kind: "head"
	readonly group: SettingGroupId
	readonly first: boolean
}
export interface RowItem {
	readonly kind: "row"
	readonly row: SettingRow
	readonly crumb?: string
}
export interface FoldItem {
	readonly kind: "fold"
	readonly key: string
	readonly count: number
	readonly names: string
	readonly open: boolean
}
export interface NothingItem {
	readonly kind: "nothing"
	readonly group: SettingGroupId
	readonly text: string
}
export interface SuggestItem {
	readonly kind: "suggest"
	readonly filter: SettingFilter
	readonly count: number
}
export type SettingsItem =
	| HeadItem
	| RowItem
	| FoldItem
	| NothingItem
	| SuggestItem
	| { readonly kind: "device"; readonly group: SettingGroupId }
	| { readonly kind: "count"; readonly n: number }
	| { readonly kind: "none"; readonly q: string }
	| { readonly kind: "pagehead"; readonly page: string }
	| { readonly kind: "status"; readonly page: string }

export interface ItemsInput {
	readonly rows: readonly SettingRow[]
	readonly query: string
	readonly filters: readonly SettingFilter[]
	/** An open decoder page. */
	readonly page: string | null
	/** On a phone, the group pushed in; null lists the groups. */
	readonly only: SettingGroupId | null
	/** Opened folds: a group id or `page:<id>`. */
	readonly open: ReadonlySet<string>
	/** Decoder names for breadcrumbs. */
	readonly pageName: (page: string) => string
}

/** Groups with nothing the app can set yet say so instead of showing an empty heading. */
const NOTHING: Partial<Record<SettingGroupId, string>> = {
	storage: "Nothing to set yet: recording is not in this app yet.",
}

export function crumbOf(
	row: SettingRow,
	pageName: (page: string) => string,
): string {
	const g = groupOf(row.group)
	const parts = [g.label]
	if (row.page !== undefined) parts.push(pageName(row.page))
	if (row.device) parts.push("On this device")
	else if (row.more) parts.push("More")
	return parts.join(" › ")
}

function section(
	rows: readonly SettingRow[],
	key: string,
	open: ReadonlySet<string>,
	out: SettingsItem[],
): void {
	const main = rows.filter(r => !r.more && !r.device)
	const more = rows.filter(r => r.more && !r.device)
	for (const row of main) out.push({ kind: "row", row })
	if (more.length > 0) {
		const isOpen = open.has(key)
		out.push({
			kind: "fold",
			key,
			count: more.length,
			names: more.map(r => r.label).join(", "),
			open: isOpen,
		})
		if (isOpen) for (const row of more) out.push({ kind: "row", row })
	}
}

export function settingsItems(input: ItemsInput): SettingsItem[] {
	const { rows, query, filters, page, only, open, pageName } = input
	const out: SettingsItem[] = []
	const searching = query.trim() !== "" || filters.length > 0
	if (searching) {
		const suggestion = filterSuggestion(query, filters)
		const hits = rows.filter(
			r =>
				r.widget.kind !== "page" &&
				filters.every(f => passes(r, f)) &&
				matches(haystack(r, crumbOf(r, pageName)), query),
		)
		if (suggestion) {
			const count = rows.filter(
				r => r.widget.kind !== "page" && passes(r, suggestion),
			).length
			out.push({ kind: "suggest", filter: suggestion, count })
		}
		if (hits.length === 0 && !suggestion) {
			out.push({
				kind: "none",
				q: query.trim() || FILTERS.find(f => f.id === filters[0])?.label || "",
			})
			return out
		}
		out.push({ kind: "count", n: hits.length })
		for (const row of hits)
			out.push({ kind: "row", row, crumb: crumbOf(row, pageName) })
		return out
	}
	if (page !== null) {
		out.push({ kind: "pagehead", page })
		section(
			rows.filter(r => r.page === page),
			`page:${page}`,
			open,
			out,
		)
		out.push({ kind: "status", page })
		return out
	}
	let first = true
	for (const g of SETTING_GROUPS) {
		if (only !== null && g.id !== only) continue
		const mine = rows.filter(r => r.group === g.id && r.page === undefined)
		// a phone's group screen has the group name as its title
		if (only === null) out.push({ kind: "head", group: g.id, first })
		first = false
		if (mine.length === 0) {
			out.push({
				kind: "nothing",
				group: g.id,
				text: NOTHING[g.id] ?? "Nothing to set here on this WaveKit.",
			})
			continue
		}
		section(mine, g.id, open, out)
		const device = mine.filter(r => r.device)
		if (device.length > 0) {
			out.push({ kind: "device", group: g.id })
			for (const row of device) out.push({ kind: "row", row })
		}
	}
	return out
}

/** A group's one-line summary on the phone's group list ("Roscoff station · France"). */
export function groupSummary(
	rows: readonly SettingRow[],
	group: SettingGroupId,
): string {
	const mine = rows.filter(
		r => r.group === group && r.page === undefined && !r.more,
	)
	if (group === "decoders") {
		const on = mine.filter(r => r.value === true).length
		return mine.length ? `${on} of ${mine.length} on` : "None configured"
	}
	return (
		mine
			.filter(r => r.widget.kind !== "link" && r.widget.kind !== "buttons")
			.slice(0, 3)
			.map(r => r.text)
			.filter(t => t && t !== "Not set")
			.join(" · ") || groupOf(group).desc
	)
}

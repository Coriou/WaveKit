// The settings registry (DESIGN.md "⌘K fix": one registry of settings, shown by Settings and by ⌘K). Each entry is
// a setting the app has today, with where it lives: the Settings drawer, or an island panel until Settings grows its
// sections. The palette lists every entry as a row; opening one shows that place and highlights the row.
import { Store } from "../../data/store.ts"
import type { IslandId } from "../../shell/store.ts"

export type SettingPlace =
	| { readonly kind: "settings" }
	| { readonly kind: "panel"; readonly id: IslandId }

export interface SettingEntry {
	readonly id: string
	readonly group: string
	readonly label: string
	/** Words people search with ("dark mode", "oled"). */
	readonly keys: readonly string[]
	readonly place: SettingPlace
}

const SETTINGS: SettingPlace = { kind: "settings" }
const RECEIVER: SettingPlace = { kind: "panel", id: "receiver" }
const LISTEN: SettingPlace = { kind: "panel", id: "listen" }
const TUNER: SettingPlace = { kind: "panel", id: "tuner" }

/** Each keyword, plus each pair of neighbours ("dark mode"); never the whole list, which fuzzy-matches noise. */
function words(text: string): string[] {
	const w = text ? text.split(" ") : []
	return w.concat(w.slice(1).map((x, i) => `${w[i]} ${x}`))
}

const row = (
	id: string,
	group: string,
	label: string,
	keys: string,
	place: SettingPlace,
): SettingEntry => ({ id, group, label, keys: words(keys), place })

export const SETTINGS_REGISTRY: readonly SettingEntry[] = [
	row(
		"dev.theme",
		"Display",
		"Theme",
		"appearance dark mode light mode night day colour scheme color",
		SETTINGS,
	),
	row(
		"dev.ground",
		"Display",
		"Dark ground",
		"theme dark background ink graphite grey gray black true black oled amoled night",
		SETTINGS,
	),
	row(
		"dev.accent",
		"Display",
		"Accent",
		"colour color highlight tint theme phosphor ice violet coral mono",
		SETTINGS,
	),
	row("rx.gain", "Receiver", "Gain", "rf gain lna auto", RECEIVER),
	row("rx.rate", "Receiver", "Sample rate", "span bandwidth sdr", RECEIVER),
	row("rx.rtlAgc", "Receiver", "RTL AGC", "digital gain agc", RECEIVER),
	row("rx.biasT", "Receiver", "Bias-T", "lna power bias tee", RECEIVER),
	row(
		"rx.ppm",
		"Receiver",
		"Frequency correction",
		"ppm offset drift",
		RECEIVER,
	),
	row("rx.direct", "Receiver", "Direct sampling", "hf shortwave", RECEIVER),
	row("rx.offset", "Receiver", "Offset tuning", "e4000 dc", RECEIVER),
	row("au.squelch", "Audio", "Squelch", "threshold sql noise", LISTEN),
	row("au.volume", "Audio", "Volume", "loudness", LISTEN),
	row("tn.step", "Tuning", "Tuning step", "channel spacing", TUNER),
	row(
		"tn.saved",
		"Tuning",
		"Saved frequencies",
		"bookmarks favourites favorites memories",
		TUNER,
	),
]

/** The setting a place should highlight (the palette's "Open in Settings ›"); consumed by that place. */
export const settingFocus = new Store<{ id: string | null }>({ id: null })

export function focusSetting(id: string): void {
	settingFocus.set({ id })
}

/** Reads and clears the highlight request when it names one of `ids`. */
export function takeSettingFocus(ids: readonly string[]): string | null {
	const { id } = settingFocus.get()
	if (id === null || !ids.includes(id)) return null
	settingFocus.set({ id: null })
	return id
}

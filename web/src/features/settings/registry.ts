// The settings registry (DESIGN.md "⌘K fix": one registry of settings, shown by Settings and by ⌘K). Each entry is
// a setting the app has today, with where it lives: the Settings drawer (saved frequencies stay in the Tuner). The
// palette lists every entry as a row; opening one shows that place and highlights the row.
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

// Settings rows with a fixed id (decoder pages are listed per decoder in the drawer, not here). Kept in step with
// rows.ts by tests/features/settings.test.ts.
export const SETTINGS_REGISTRY: readonly SettingEntry[] = [
	row("station.name", "Station", "Station name", "title name", SETTINGS),
	row(
		"station.location",
		"Station",
		"Location",
		"position latitude longitude coordinates gps qth",
		SETTINGS,
	),
	row(
		"station.country",
		"Station",
		"Country",
		"region nation band plan legal limits",
		SETTINGS,
	),
	row(
		"station.bandplans",
		"Station",
		"Band plans",
		"band plan bandplan bands channels allocations import sdr++ gqrx sdr# csv",
		SETTINGS,
	),
	row(
		"station.callsign",
		"Station",
		"Callsign",
		"call sign ham amateur",
		SETTINGS,
	),
	row("station.altitude", "Station", "Altitude", "height elevation", SETTINGS),
	row("rx.rate", "Receiver", "Sample rate", "span bandwidth sdr", SETTINGS),
	row("rx.gain", "Receiver", "Gain", "rf gain lna auto", SETTINGS),
	row(
		"rx.ppm",
		"Receiver",
		"Frequency correction",
		"ppm offset drift",
		SETTINGS,
	),
	row("rx.biasT", "Receiver", "Bias-T", "lna power bias tee", SETTINGS),
	row("rx.direct", "Receiver", "Direct sampling", "hf shortwave", SETTINGS),
	row("rx.offset", "Receiver", "Offset tuning", "e4000 dc", SETTINGS),
	row("rx.rtlAgc", "Receiver", "RTL AGC", "digital gain agc", SETTINGS),
	row("au.squelch", "Audio", "Squelch", "threshold sql noise", SETTINGS),
	row(
		"au.margin",
		"Audio",
		"Auto squelch margin",
		"squelch sql auto",
		SETTINGS,
	),
	row(
		"au.agc",
		"Audio",
		"Level control",
		"agc automatic gain loudness",
		SETTINGS,
	),
	row("au.deemph", "Audio", "De-emphasis", "fm broadcast deemphasis", SETTINGS),
	row("au.nr", "Audio", "Noise reduction", "hiss denoise", SETTINGS),
	row("au.hp", "Audio", "Cut low rumble", "high pass filter", SETTINGS),
	row("au.lp", "Audio", "Cut high hiss", "low pass filter", SETTINGS),
	row("au.volume", "Audio", "Volume", "loudness", SETTINGS),
	row(
		"st.activity",
		"Recording & storage",
		"Keep Activity for",
		"retention history expire",
		SETTINGS,
	),
	row(
		"dp.units",
		"Display",
		"Units",
		"km miles knots feet metres meters speed distance altitude",
		SETTINGS,
	),
	row(
		"dp.time",
		"Display",
		"Time",
		"clock timezone zulu utc gmt 12 hour 24 hour am pm",
		SETTINGS,
	),
	row(
		"dp.tags",
		"Display",
		"Tags for saved frequencies",
		"saved frequency labels names spectrum",
		SETTINGS,
	),
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
	row(
		"dev.waterfall",
		"Display",
		"Waterfall colours",
		"palette colors colours heat spectrum theme ramp classic amber mono sdr++",
		SETTINGS,
	),
	row(
		"map.online",
		"Map",
		"Beyond the offline map",
		"tiles openfreemap online blank basemap privacy",
		SETTINGS,
	),
	row("map.trails", "Map", "Trail length", "history track", SETTINGS),
	row("map.labels", "Map", "Labels", "names callsigns clutter", SETTINGS),
	row(
		"dp.range",
		"Display",
		"Spectrum range",
		"db scale min max range levels floor fixed auto",
		SETTINGS,
	),
	row(
		"dp.avg",
		"Display",
		"Averaging",
		"smoothing smooth average trace line spectrum",
		SETTINGS,
	),
	row(
		"dp.fft",
		"Display",
		"FFT size",
		"resolution bins detail waterfall",
		SETTINGS,
	),
	row(
		"dev.card",
		"Display",
		"Tuned card position",
		"tuned card float move anchor above listen corner place",
		SETTINGS,
	),
	row("tn.step", "Display", "Tuning step", "channel spacing", SETTINGS),
	row("sys.config", "System", "Configuration", "backup export yaml", SETTINGS),
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

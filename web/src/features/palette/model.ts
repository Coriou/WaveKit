// The command palette's rows (docs/web/canvas/Palette.dc.html, DESIGN.md "Command palette (⌘K), first pass" and
// "⌘K fix"): built from a snapshot of the app's state, grouped and ranked for the field's text and scope. Pure: the
// rows carry what to do as data (PaletteAction, Preview); actions.ts runs them against the stores.
import type {
	Discovery,
	LiveAudioConfig,
	ResolvedBandPlanView,
	SavedFrequency,
	ScanJob,
	ScannerProtocol,
} from "@wavekit/api-types"

import { bandAt, channelAt } from "../../data/bandplan-store.ts"
import { discoveryTitle, protocolName } from "../../data/scanner-format.ts"
import type { DrawerId, ShellState, ViewId } from "../../shell/store.ts"
import {
	ACCENTS,
	GROUNDS,
	WATERFALLS,
	type Accent,
	type Ground,
	type ThemeName,
	type ThemePrefs,
	type Waterfall,
} from "../../shell/theme.ts"
import { formatDb, formatMHz, formatRate, formatWidth } from "../format.ts"
import type { Preset } from "../scanner/planner/plan.ts"
import { SETTINGS_REGISTRY, type SettingEntry } from "../settings/registry.ts"
import { channelSuggestions } from "../tuner/band.ts"
import { modeSpec, MODES, type Modulation } from "../tuner/modes.ts"
import { STEPS } from "../tuner/prefs.ts"
import {
	defaultGroup,
	defaultSaveName,
	SAVE_GROUPS,
	savedMeta,
} from "../tuner/saved.ts"
import { DECODE_AS } from "../tuned/identify-view.ts"
import type { GlyphName } from "./glyphs.ts"
import {
	parseCommand,
	parseFrequencyIntent,
	parseIdentifiers,
	type CommandIntent,
} from "./parse.ts"
import { rank } from "./rank.ts"

// ---- inputs

export interface ReceiverContext {
	readonly gainAuto: boolean
	/** Tenths of dB. */
	readonly gainTenthsDb: number
	/** The tuner's gain table (tenths of dB), ascending. */
	readonly gainSteps: readonly number[]
	readonly sampleRateHz: number
	readonly rates: readonly number[]
	readonly biasTee: boolean
	readonly rtlAgc: boolean
	/** Why WaveKit cannot change the tuner now, or null. */
	readonly lockReason: string | null
}

/** What the palette reads from the app, once per render. */
export interface PaletteContext {
	readonly tunedHz: number | null
	readonly config: LiveAudioConfig | null
	readonly listening: boolean
	/** 0..1. */
	readonly volume: number
	readonly stepHz: number
	readonly chosenStepHz: number | null
	readonly receiver: ReceiverContext | null
	/** A protected core without a session: nothing can be changed on the core. */
	readonly readOnly: boolean
	readonly theme: ThemePrefs
	/** Null when the core keeps no saved frequencies (legacy mode). */
	readonly saved: readonly SavedFrequency[] | null
	readonly bandplan: ResolvedBandPlanView | null
	readonly discoveries: readonly Discovery[]
	readonly presets: readonly Preset[]
	readonly sweep: ScanJob | null
	readonly shell: ShellState
	/** Ids by frecency, best first. */
	readonly recent: readonly string[]
	readonly boost: (id: string) => number
}

// ---- outputs

export type ScopeId =
	| "tune"
	| "mode"
	| "bw"
	| "step"
	| "gain"
	| "rate"
	| "sq"
	| "vol"
	| "theme"
	| "ground"
	| "accent"
	| "waterfall"
	| "saved"
	| "save"
	| "go"
	| "scan"
	| "set"
	| "keys"
	| "decode"

export interface ScopeMeta {
	readonly title: string
	readonly placeholder: string
	/** Typed text in this scope is read as `<prefix> <text>` too (`25` in Bandwidth is `bw 25`). */
	readonly prefix?: string
	/** The rows depend on the typed text (Save names the frequency): never filtered. */
	readonly raw?: boolean
}

export const SCOPES: Readonly<Record<ScopeId, ScopeMeta>> = {
	tune: {
		title: "Tune",
		placeholder:
			"Type or paste a frequency · 161.15 · 446.00625 MHz · +25k · ch 16",
	},
	mode: { title: "Mode", placeholder: "Choose a mode" },
	bw: {
		title: "Bandwidth",
		placeholder: "Choose, or type one (25k)",
		prefix: "bw",
	},
	step: {
		title: "Tuning step",
		placeholder: "Choose, or type one (6.25k)",
		prefix: "step",
	},
	gain: {
		title: "Gain",
		placeholder: "Choose, or type a gain in dB",
		prefix: "gain",
	},
	rate: { title: "Sample rate", placeholder: "Choose a sample rate" },
	sq: {
		title: "Squelch",
		placeholder: "Choose, or type a level (−90)",
		prefix: "sq",
	},
	vol: {
		title: "Volume",
		placeholder: "Choose, or type a level (60)",
		prefix: "vol",
	},
	theme: { title: "Theme", placeholder: "Choose a theme" },
	ground: { title: "Dark ground", placeholder: "Choose the dark ground" },
	accent: { title: "Accent", placeholder: "Choose an accent" },
	waterfall: {
		title: "Waterfall colours",
		placeholder: "Choose the waterfall colours",
	},
	saved: { title: "Saved frequencies", placeholder: "Find a saved frequency" },
	save: { title: "Save", placeholder: "Name it, then pick a group", raw: true },
	go: { title: "Go to", placeholder: "Choose a view" },
	scan: { title: "Scan a band", placeholder: "Choose a band to sweep" },
	set: { title: "Settings", placeholder: "Find a setting" },
	keys: { title: "Keyboard shortcuts", placeholder: "Find a shortcut" },
	decode: { title: "Decode as", placeholder: "Choose a protocol to try" },
}

/** Scopes whose values are found from the root ("amber" → Accent › …, "graphite" → Dark ground › Graphite). */
const DEEP: readonly ScopeId[] = [
	"mode",
	"step",
	"theme",
	"ground",
	"accent",
	"waterfall",
]

/** Applied while the row is highlighted; Enter keeps it, Esc reverts. Only local, side-effect-free state. */
export type Preview =
	| { readonly kind: "theme"; readonly patch: Partial<ThemePrefs> }
	| { readonly kind: "step"; readonly hz: number | null }
	| { readonly kind: "volume"; readonly value: number }

export interface IdentifierToken {
	readonly kind: "talkgroup" | "capcode" | "mmsi" | "text"
	readonly value: string
}
export interface FrequencyToken {
	readonly kind: "frequency"
	readonly hz: number
	readonly bandwidthHz?: number
}
export type ActivityToken = IdentifierToken | FrequencyToken

export interface TuneAction {
	readonly kind: "tune"
	readonly hz: number
	readonly mode?: Modulation
	readonly bandwidthHz?: number
}
export interface SaveAction {
	readonly kind: "save"
	readonly hz: number
	readonly name: string
	readonly group: string
	/** A frequency other than the tuned one: its mode comes from the band plan, not live audio. */
	readonly fromBand?: boolean
}
export interface ActivityAction {
	readonly kind: "activity"
	readonly tokens: readonly ActivityToken[]
	readonly label: string
}

export interface IdentifyAction {
	readonly kind: "identify"
	readonly hz: number
	/** Decode as…: only these protocols. */
	readonly protocols?: readonly ScannerProtocol[]
}

export type PaletteAction =
	| TuneAction
	| { readonly kind: "recall"; readonly saved: SavedFrequency }
	| { readonly kind: "audio"; readonly patch: Partial<LiveAudioConfig> }
	| { readonly kind: "gain"; readonly tenthsDb: number | "auto" }
	| { readonly kind: "rate"; readonly hz: number }
	| { readonly kind: "biasTee"; readonly on: boolean }
	| { readonly kind: "rtlAgc"; readonly on: boolean }
	| { readonly kind: "theme"; readonly patch: Partial<ThemePrefs> }
	| { readonly kind: "step"; readonly hz: number | null }
	| { readonly kind: "volume"; readonly value: number }
	| { readonly kind: "listen"; readonly on: boolean }
	| IdentifyAction
	| SaveAction
	| { readonly kind: "view"; readonly id: ViewId }
	| { readonly kind: "drawer"; readonly id: DrawerId }
	| ActivityAction
	| { readonly kind: "scanPlan"; readonly presetId: string | null }
	| { readonly kind: "scanJob"; readonly op: "pause" | "resume" | "stop" }
	| { readonly kind: "discovery"; readonly id: string }
	| { readonly kind: "setting"; readonly entry: SettingEntry }
	| { readonly kind: "copy"; readonly text: string; readonly label: string }

/** One line of the effect bar: `Gain 28.0 dB → 32.8 dB`. */
export interface Effect {
	readonly label: string
	readonly from: string
	readonly to: string
}

/** A colour preview tile: that option's own theme scope. */
export interface Swatch {
	readonly theme: ThemeName
	readonly ground: Ground | "paper"
	readonly accent: Accent
	/** System: half dark, half paper. */
	readonly split?: boolean
	/** A waterfall ramp strip instead of the accent dot. */
	readonly ramp?: Waterfall
}

export interface PaletteItem {
	readonly id: string
	readonly title: string
	readonly sub?: string
	readonly glyph: GlyphName
	readonly swatch?: Swatch
	/** Right-aligned current value ("12.5 kHz", "Running"). */
	readonly value?: string
	/** The current choice in a scope. */
	readonly cur?: boolean
	/** A switch row: its state. */
	readonly toggle?: boolean
	readonly kbd?: readonly string[]
	readonly keys?: readonly string[]
	/** Tab or Enter opens this scope. */
	readonly scope?: ScopeId
	/** "Open in Settings ›" on a registry row. */
	readonly opens?: string
	readonly action?: PaletteAction
	readonly preview?: Preview
	/** What Enter changes, for the effect bar (rows with an action and no `does`). */
	readonly effects?: readonly Effect[]
	/** What Enter does, in words, for the effect bar. */
	readonly does?: string
	readonly warn?: string
	/** A note, not a command (out of range, nothing to do). */
	readonly info?: boolean
	/** Shown large (the tune row). */
	readonly big?: boolean
	/** The toast after running. */
	readonly done?: string
	/** A setting row tied to an inline row (its scope or switch): ranked right after it. */
	readonly link?: string
	/** Other names matched like the title (a scope value found from the root). */
	readonly aliases?: readonly string[]
}

export type RankedItem = PaletteItem & {
	readonly score: number
	readonly idx: readonly number[]
}

export interface PaletteGroup {
	readonly label: string
	readonly items: readonly RankedItem[]
}

// ---- formatting

const mhz = (hz: number) => `${formatMHz(hz)} MHz`
const modeLabel = (m: Modulation) => modeSpec(m).label

function bandName(
	view: ResolvedBandPlanView | null,
	hz: number,
): string | null {
	return bandAt(view, hz)?.band.name ?? null
}

function gainLabel(tenths: number): string {
	return `${(tenths / 10).toFixed(1)} dB`
}

function squelchLabel(config: LiveAudioConfig | null): string {
	if (!config) return "Off"
	if (config.squelchMode === "auto") return "Auto"
	if (config.squelchMode === "noise") return "Noise"
	return config.squelch === 0 ? "Off" : `${formatDb(config.squelch, 0)} dB`
}

const THEME_OPTS: readonly (readonly [ThemeName, string, string])[] = [
	["dark", "Dark", "Ink, Graphite or True black ground"],
	["light", "Light", "Paper: warm cream, for daylight"],
]
const GROUND_OPTS: Readonly<Record<Ground, readonly [string, string]>> = {
	ink: ["Ink", "Tinted by the accent"],
	graphite: ["Graphite", "Neutral grey"],
	black: ["True black", "Pure black plot, for OLED screens"],
}
const WATERFALL_OPTS: Readonly<Record<Waterfall, readonly [string, string]>> = {
	match: ["Match accent", "Built from the ground and the accent"],
	amber: ["Amber", "Warm, from violet to gold"],
	mono: ["Mono", "Greyscale"],
	classic: ["Classic", "Blue to red heat, like SDR++"],
}
const ACCENT_LABEL: Readonly<Record<Accent, string>> = {
	phosphor: "Phosphor",
	ice: "Ice",
	violet: "Violet",
	coral: "Coral",
	mono: "Mono",
}

const MODE_DESC: Readonly<Record<string, string>> = {
	nfm: "Narrow FM: land mobile, PMR, marine, amateur",
	am: "Airband, CB, broadcast AM",
	wfm: "Broadcast FM",
	usb: "Upper sideband: HF voice, data",
	lsb: "Lower sideband: HF amateur below 10 MHz",
	cw: "Morse",
	raw: "No channel filter, the full span",
}

const VIEWS: readonly {
	id: ViewId | DrawerId
	label: string
	glyph: GlyphName
	key?: string
	kbd?: readonly string[]
	/** What the row says it does, when "Shows the <label>" does not read well. */
	does?: string
}[] = [
	{ id: "spectrum", label: "Spectrum", glyph: "waterfall", key: "S" },
	{ id: "activity", label: "Activity", glyph: "activity", key: "A" },
	{ id: "map", label: "Map", glyph: "go", key: "M" },
	{
		id: "messages",
		label: "Messages",
		glyph: "messages",
		key: "D",
		does: "Shows decoded messages as cards, keeps any drawer open",
	},
	{ id: "scanner", label: "Scanner", glyph: "scan", key: "C" },
	{ id: "recordings", label: "Recordings", glyph: "rec", key: "R" },
	{ id: "settings", label: "Settings", glyph: "settings", kbd: ["⌘", ","] },
]

const isView = (id: string): id is ViewId =>
	id === "spectrum" || id === "map" || id === "messages"

// ---- the builder

export class PaletteModel {
	readonly #c: PaletteContext

	constructor(context: PaletteContext) {
		this.#c = context
	}

	get context(): PaletteContext {
		return this.#c
	}

	#canAudio(): boolean {
		return this.#c.config !== null && !this.#c.readOnly
	}

	// -- tune rows

	tuneItem(
		hz: number,
		opt: {
			id?: string
			title?: string
			sub?: string
			keys?: readonly string[]
			mode?: Modulation | null
			bandwidthHz?: number | null
			glyph?: GlyphName
		} = {},
	): PaletteItem {
		const c = this.#c
		const band = bandAt(c.bandplan, hz)
		const channel = channelAt(band, hz)
		const mode = opt.mode ?? null
		const sub =
			opt.sub ??
			[
				channel?.name ?? band?.band.name ?? "No band plan entry",
				mode && mode !== c.config?.modulation
					? `switches to ${modeLabel(mode)}`
					: null,
			]
				.filter(Boolean)
				.join(" · ")
		const action: PaletteAction = {
			kind: "tune",
			hz,
			...(mode ? { mode } : {}),
			...(opt.bandwidthHz ? { bandwidthHz: opt.bandwidthHz } : {}),
		}
		const effects: Effect[] = [
			{
				label: "Frequency",
				from: c.tunedHz === null ? "" : mhz(c.tunedHz),
				to: mhz(hz),
			},
		]
		if (mode && mode !== c.config?.modulation)
			effects.push({
				label: "Mode",
				from: c.config ? modeLabel(c.config.modulation) : "",
				to: modeLabel(mode),
			})
		if (opt.bandwidthHz)
			effects.push({
				label: "Bandwidth",
				from: c.config ? formatWidth(c.config.bandwidth) : "",
				to: formatWidth(opt.bandwidthHz),
			})
		return {
			id: opt.id ?? `tune:${hz}`,
			title: opt.title ?? `Tune to ${mhz(hz)}`,
			sub,
			glyph: opt.glyph ?? "antenna",
			...(opt.keys ? { keys: opt.keys } : {}),
			action,
			effects,
			cur: c.tunedHz === hz,
			done: `Tuned to ${opt.title ? `${opt.title} · ` : ""}${mhz(hz)}`,
		}
	}

	savedItem(f: SavedFrequency): PaletteItem {
		const c = this.#c
		return {
			...this.tuneItem(f.frequencyHz, {
				id: `saved:${f.id}`,
				title: f.name,
				sub: `${mhz(f.frequencyHz)} · ${savedMeta(f)}`,
				glyph: "bookmark",
				mode: f.mode,
			}),
			keys: [f.group ?? "", formatMHz(f.frequencyHz)].filter(Boolean),
			action: { kind: "recall", saved: f },
			done: `Tuned to ${f.name} · ${mhz(f.frequencyHz)}`,
			cur: c.tunedHz === f.frequencyHz,
		}
	}

	discoveryItem(d: Discovery): PaletteItem {
		return {
			...this.tuneItem(d.frequencyHz, {
				id: `disc:${d.id}`,
				title: discoveryTitle(d),
				sub: `${mhz(d.frequencyHz)} · Found by the scanner · ${protocolName(d.protocol)}`,
				glyph: "scan",
			}),
			keys: [formatMHz(d.frequencyHz), protocolName(d.protocol), "discovery"],
			action: { kind: "discovery", id: d.id },
			done: `Tuned to ${discoveryTitle(d)} · ${mhz(d.frequencyHz)}`,
		}
	}

	/** Everything a name can tune to: saved frequencies, then discoveries not at a saved frequency. */
	tuneTargets(): PaletteItem[] {
		const saved = this.#c.saved ?? []
		const at = new Set(saved.map(f => f.frequencyHz))
		return [
			...saved.map(f => this.savedItem(f)),
			...this.#c.discoveries
				.filter(d => !at.has(d.frequencyHz))
				.map(d => this.discoveryItem(d)),
		]
	}

	/** Plan channels matching typed text ("ch 16", "pmr 3"). */
	channelItems(q: string): PaletteItem[] {
		return channelSuggestions(this.#c.bandplan, q, 6).map(s =>
			this.tuneItem(s.hz, {
				id: `tune:${s.hz}`,
				title: s.label,
				sub: `${mhz(s.hz)} · ${s.band}`,
			}),
		)
	}

	// -- scope rows

	modeItem(m: Modulation): PaletteItem {
		const c = this.#c
		const def = modeSpec(m).bw
		const patch: Partial<LiveAudioConfig> = def
			? { modulation: m, bandwidth: def[3] }
			: { modulation: m }
		return {
			id: `mode:${m}`,
			title: modeLabel(m),
			sub: MODE_DESC[m] ?? "",
			glyph: "mode",
			cur: c.config?.modulation === m,
			...(this.#canAudio()
				? {
						action: { kind: "audio", patch } as const,
						effects: [
							{
								label: "Mode",
								from: c.config ? modeLabel(c.config.modulation) : "",
								to: modeLabel(m),
							},
						],
						done: `Mode ${modeLabel(m)}`,
					}
				: { info: true }),
		}
	}

	bwItem(hz: number): PaletteItem {
		const c = this.#c
		return {
			id: `bw:${hz}`,
			title: formatWidth(hz),
			glyph: "bw",
			cur: c.config?.bandwidth === hz,
			...(this.#canAudio()
				? {
						action: { kind: "audio", patch: { bandwidth: hz } } as const,
						effects: [
							{
								label: "Bandwidth",
								from: c.config ? formatWidth(c.config.bandwidth) : "",
								to: formatWidth(hz),
							},
						],
						done: `Bandwidth ${formatWidth(hz)}`,
					}
				: { info: true }),
		}
	}

	/** Five widths across the mode's range, its default among them. */
	bandwidths(): number[] {
		const spec = this.#c.config ? modeSpec(this.#c.config.modulation).bw : null
		if (!spec) return []
		const [min, max, , def] = spec
		const nice = [
			100, 250, 500, 1000, 1500, 2400, 2700, 3000, 4000, 5000, 6250, 8330,
			10_000, 12_500, 15_000, 20_000, 25_000, 50_000, 100_000, 150_000, 200_000,
			250_000,
		]
		return [...new Set([...nice.filter(v => v >= min && v <= max), def])].sort(
			(a, b) => a - b,
		)
	}

	stepItem(hz: number | null): PaletteItem {
		const c = this.#c
		const title = hz === null ? "Auto" : formatWidth(hz)
		const sub =
			hz === null
				? `Follows the band plan · ${formatWidth(c.stepHz)} here`
				: hz === 8330
					? "Airband channel spacing"
					: hz === 6250
						? "Narrow land mobile, PMR446"
						: hz === 12_500
							? "Land mobile, marine"
							: ""
		return {
			id: `step:${hz ?? "auto"}`,
			title,
			sub,
			glyph: "step",
			cur: c.chosenStepHz === hz,
			action: { kind: "step", hz },
			preview: { kind: "step", hz },
			effects: [
				{
					label: "Tuning step",
					from: c.chosenStepHz === null ? "Auto" : formatWidth(c.chosenStepHz),
					to: title,
				},
			],
			done: `Tuning step ${title}`,
		}
	}

	gainItem(tenths: number | "auto"): PaletteItem {
		const c = this.#c
		const rx = c.receiver
		const title = tenths === "auto" ? "Auto" : gainLabel(tenths)
		const cur = rx
			? tenths === "auto"
				? rx.gainAuto
				: !rx.gainAuto && rx.gainTenthsDb === tenths
			: false
		const base: PaletteItem = {
			id: `gain:${tenths}`,
			title,
			...(tenths === "auto" ? { sub: "The tuner's AGC picks the gain" } : {}),
			glyph: "gain",
			cur,
		}
		if (!rx || rx.lockReason)
			return {
				...base,
				info: true,
				...(rx?.lockReason ? { sub: rx.lockReason } : {}),
			}
		return {
			...base,
			action: { kind: "gain", tenthsDb: tenths },
			effects: [
				{
					label: "Gain",
					from: rx.gainAuto ? "Auto" : gainLabel(rx.gainTenthsDb),
					to: title,
				},
			],
			done: `Gain ${title}`,
		}
	}

	rateItem(hz: number): PaletteItem {
		const rx = this.#c.receiver
		const base: PaletteItem = {
			id: `rate:${hz}`,
			title: formatRate(hz),
			sub: `${formatWidth(hz)} of spectrum`,
			glyph: "rate",
			cur: rx?.sampleRateHz === hz,
		}
		if (!rx || rx.lockReason)
			return {
				...base,
				info: true,
				...(rx?.lockReason ? { sub: rx.lockReason } : {}),
			}
		const over =
			hz > 2_400_000 ? "Above 2.4 MS/s the link may drop samples. " : ""
		return {
			...base,
			action: { kind: "rate", hz },
			effects: [
				{
					label: "Sample rate",
					from: formatRate(rx.sampleRateHz),
					to: formatRate(hz),
				},
			],
			warn: `${over}The core restarts the stream: the spectrum starts over and decoders resync.`,
			done: `Sample rate ${formatRate(hz)}`,
		}
	}

	sqItem(v: "auto" | "off" | "noise" | number): PaletteItem {
		const c = this.#c
		const cfg = c.config
		const patch: Partial<LiveAudioConfig> =
			v === "auto"
				? { squelchMode: "auto", autoMarginDb: cfg?.autoMarginDb ?? 6 }
				: v === "off"
					? { squelchMode: "manual", squelch: 0 }
					: v === "noise"
						? { squelchMode: "noise" }
						: { squelchMode: "manual", squelch: v }
		const title =
			v === "auto"
				? "Auto"
				: v === "off"
					? "Off"
					: v === "noise"
						? "Noise"
						: `${formatDb(v, 0)} dB`
		const sub =
			v === "auto"
				? "6 dB over the noise floor, follows conditions"
				: v === "off"
					? "Always open, you hear the noise"
					: v === "noise"
						? "Opens on FM quieting (NFM and WFM)"
						: ""
		const cur = squelchLabel(cfg) === title
		return {
			id: `sq:${v}`,
			title,
			...(sub ? { sub } : {}),
			glyph: "squelch",
			cur,
			...(this.#canAudio()
				? {
						action: { kind: "audio", patch } as const,
						effects: [{ label: "Squelch", from: squelchLabel(cfg), to: title }],
						done: `Squelch ${title}`,
					}
				: { info: true }),
		}
	}

	volItem(percent: number): PaletteItem {
		const c = this.#c
		const value = percent / 100
		return {
			id: `vol:${percent}`,
			title: `${percent} %`,
			glyph: "volume",
			cur: Math.round(c.volume * 100) === percent,
			action: { kind: "volume", value },
			preview: { kind: "volume", value },
			effects: [
				{
					label: "Volume",
					from: `${Math.round(c.volume * 100)} %`,
					to: `${percent} %`,
				},
			],
			done: `Volume ${percent} %`,
		}
	}

	#themeItem(
		key: "theme" | "ground" | "accent" | "waterfall",
		value: string,
		title: string,
		sub: string,
		swatch: Swatch,
	): PaletteItem {
		const t = this.#c.theme
		const patch = { [key]: value } as Partial<ThemePrefs>
		const label =
			key === "theme"
				? "Theme"
				: key === "ground"
					? "Dark ground"
					: key === "waterfall"
						? "Waterfall colours"
						: "Accent"
		const from =
			key === "theme"
				? (THEME_OPTS.find(o => o[0] === t.theme)?.[1] ?? t.theme)
				: key === "ground"
					? GROUND_OPTS[t.ground][0]
					: key === "waterfall"
						? WATERFALL_OPTS[t.waterfall][0]
						: ACCENT_LABEL[t.accent]
		return {
			id: `${key}:${value}`,
			title,
			sub,
			glyph:
				key === "accent"
					? "palette"
					: key === "ground"
						? "ground"
						: key === "waterfall"
							? "waterfall"
							: "theme",
			swatch,
			cur: t[key] === value,
			action: { kind: "theme", patch },
			preview: { kind: "theme", patch },
			effects: [{ label, from, to: title }],
			done: `${label} ${title}`,
		}
	}

	themeItems(): PaletteItem[] {
		const t = this.#c.theme
		return THEME_OPTS.map(([id, title, sub]) =>
			this.#themeItem("theme", id, title, sub, {
				theme: id,
				ground: id === "light" ? "paper" : t.ground,
				accent: t.accent,
			}),
		)
	}

	groundItems(): PaletteItem[] {
		const t = this.#c.theme
		return GROUNDS.map(g =>
			this.#themeItem(
				"ground",
				g,
				GROUND_OPTS[g][0],
				t.theme === "light"
					? `${GROUND_OPTS[g][1]} · used when the theme is Dark`
					: GROUND_OPTS[g][1],
				{ theme: "dark", ground: g, accent: t.accent },
			),
		)
	}

	accentItems(): PaletteItem[] {
		const t = this.#c.theme
		return ACCENTS.map(a =>
			this.#themeItem("accent", a, ACCENT_LABEL[a], "", {
				theme: t.theme,
				ground: t.theme === "light" ? "paper" : t.ground,
				accent: a,
			}),
		)
	}

	waterfallItems(): PaletteItem[] {
		const t = this.#c.theme
		return WATERFALLS.map(w =>
			this.#themeItem(
				"waterfall",
				w,
				WATERFALL_OPTS[w][0],
				WATERFALL_OPTS[w][1],
				{
					theme: t.theme,
					ground: t.theme === "light" ? "paper" : t.ground,
					accent: t.accent,
					ramp: w,
				},
			),
		)
	}

	viewItem(v: (typeof VIEWS)[number]): PaletteItem {
		const s = this.#c.shell
		const view = isView(v.id)
		return {
			id: `view:${v.id}`,
			title: `Go to ${v.label}`,
			glyph: v.glyph,
			kbd: v.kbd ?? (v.key ? ["G", v.key] : []),
			cur: view ? s.view === v.id : s.drawer === v.id,
			action: isView(v.id)
				? { kind: "view", id: v.id }
				: { kind: "drawer", id: v.id as DrawerId },
			does:
				v.does ??
				(view
					? `Shows the ${v.label}, keeps any drawer open`
					: `Opens ${v.label}`),
			keys: [v.label.toLowerCase(), "open", "show"],
		}
	}

	settingItem(e: SettingEntry): PaletteItem {
		const where =
			e.place.kind === "settings"
				? "Settings"
				: e.place.id === "receiver"
					? "Receiver"
					: e.place.id === "listen"
						? "Listen"
						: "Tuner"
		const link = SETTING_LINK[e.id]
		return {
			id: `set:${e.id}`,
			title: `${e.label} — ${e.group}`,
			glyph: "settings",
			keys: e.keys,
			opens: `Open in ${where} ›`,
			action: { kind: "setting", entry: e },
			does: `Opens ${where} at ${e.label}`,
			...(link ? { link } : {}),
		}
	}

	settingItems(): PaletteItem[] {
		return SETTINGS_REGISTRY.map(e => this.settingItem(e))
	}

	scopeItems(scope: ScopeId, q = ""): PaletteItem[] {
		const c = this.#c
		switch (scope) {
			case "tune":
				return []
			case "mode":
				return MODES.map(m => this.modeItem(m.id))
			case "bw":
				return this.bandwidths().map(hz => this.bwItem(hz))
			case "step":
				return [this.stepItem(null), ...STEPS.map(hz => this.stepItem(hz))]
			case "gain":
				return c.receiver
					? [
							this.gainItem("auto"),
							...[...c.receiver.gainSteps].reverse().map(t => this.gainItem(t)),
						]
					: []
			case "rate":
				return (c.receiver?.rates ?? []).map(r => this.rateItem(r))
			case "sq":
				return [
					this.sqItem("auto"),
					this.sqItem("off"),
					...(c.config &&
					(c.config.modulation === "nfm" || c.config.modulation === "wfm")
						? [this.sqItem("noise")]
						: []),
					...[-110, -100, -90, -80, -70, -60, -50, -40].map(x =>
						this.sqItem(x),
					),
				]
			case "vol":
				return [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0].map(n =>
					this.volItem(n),
				)
			case "theme":
				return this.themeItems()
			case "ground":
				return this.groundItems()
			case "accent":
				return this.accentItems()
			case "waterfall":
				return this.waterfallItems()
			case "saved": {
				const here = this.savedHere()
				return [
					...(here || c.saved === null || c.tunedHz === null
						? []
						: [this.saveScopeItem()]),
					...(c.saved ?? []).map(f => this.savedItem(f)),
				]
			}
			case "save":
				return this.saveItems(q)
			case "go":
				return VIEWS.map(v => this.viewItem(v))
			case "scan":
				return [
					...c.presets.map(p => this.presetItem(p)),
					{
						id: "scan:custom",
						title: "Your own range…",
						sub: "Drag or type the edges",
						glyph: "scan",
						action: { kind: "scanPlan", presetId: null },
						does: "Opens Scan a band",
					},
				]
			case "set":
				return this.settingItems()
			case "keys":
				return this.rootCommands().filter(r => r.kbd && r.kbd.length > 0)
			case "decode":
				return DECODE_AS.map(p => this.decodeAsItem(p)).filter(
					(x): x is PaletteItem => x !== null,
				)
		}
	}

	presetItem(p: Preset): PaletteItem {
		const first = p.ranges[0]
		const last = p.ranges[p.ranges.length - 1]
		const range =
			first && last
				? `${formatMHz(first.startHz)}–${formatMHz(last.endHz)} MHz`
				: ""
		return {
			id: `scan:${p.id}`,
			title: p.label,
			sub: [
				p.user ? "Your preset" : null,
				range,
				p.name !== p.label ? p.name : null,
			]
				.filter(Boolean)
				.join(" · "),
			glyph: "scan",
			keys: [p.name, "scan", "sweep"],
			action: { kind: "scanPlan", presetId: p.id },
			does: `Opens Scan a band with ${p.label}`,
		}
	}

	savedHere(): SavedFrequency | null {
		const c = this.#c
		if (c.tunedHz === null) return null
		return c.saved?.find(f => f.frequencyHz === c.tunedHz) ?? null
	}

	defaultSaveName(): string {
		const c = this.#c
		if (c.tunedHz === null) return ""
		const band = bandAt(c.bandplan, c.tunedHz)
		return defaultSaveName(
			c.tunedHz,
			channelAt(band, c.tunedHz)?.name,
			band?.band.name,
		)
	}

	saveItems(q: string): PaletteItem[] {
		const c = this.#c
		const hz = c.tunedHz
		if (hz === null) return []
		const here = this.savedHere()
		if (here)
			return [
				{
					id: "info:saved",
					info: true,
					title: `Already saved as “${here.name}”`,
					sub: `${here.group ?? "No group"} · ${mhz(here.frequencyHz)}`,
					glyph: "bookmark",
				},
			]
		if (c.readOnly)
			return [
				{
					id: "info:readonly",
					info: true,
					title: "Read-only: sign in to this core to save frequencies",
					glyph: "alert",
				},
			]
		const name = q.trim() || this.defaultSaveName()
		const first = defaultGroup(bandAt(c.bandplan, hz)?.band.group)
		const groups = [first, ...SAVE_GROUPS.filter(g => g !== first)]
		const mode = c.config ? modeLabel(c.config.modulation) : null
		return groups.map(g => ({
			id: `save:${g}`,
			title: `Save as “${name}” in ${g}`,
			sub: [mhz(hz), mode, c.config ? formatWidth(c.config.bandwidth) : null]
				.filter(Boolean)
				.join(" · "),
			glyph: "bookmark",
			action: { kind: "save", hz, name, group: g },
			effects: [{ label: "Save", from: "", to: `“${name}” in ${g}` }],
			done: `Saved “${name}” in ${g}`,
		}))
	}

	// -- root rows

	tuneScopeItem(): PaletteItem {
		const c = this.#c
		return {
			id: "scope:tune",
			title: "Tune to a frequency…",
			sub: "Type or paste it: MHz, kHz, Hz, a channel or a step",
			glyph: "antenna",
			...(c.tunedHz !== null ? { value: formatMHz(c.tunedHz) } : {}),
			kbd: ["T"],
			scope: "tune",
			keys: ["frequency", "freq", "go to frequency", "paste"],
		}
	}

	saveScopeItem(): PaletteItem {
		const hz = this.#c.tunedHz
		return {
			id: "scope:save",
			title: hz === null ? "Save this frequency" : `Save ${mhz(hz)}`,
			sub: "Name it and file it in a group",
			glyph: "bookmark",
			kbd: ["S"],
			scope: "save",
			keys: ["bookmark", "save frequency", "remember"],
		}
	}

	identifyItem(): PaletteItem | null {
		const c = this.#c
		if (c.tunedHz === null || c.readOnly) return null
		return {
			id: "identify",
			title: "Identify this signal",
			sub: `Tries each decoder on ${mhz(c.tunedHz)} for up to 15 s · never moves the receiver`,
			glyph: "identify",
			kbd: ["I"],
			keys: ["what is this", "classify", "unknown signal"],
			action: { kind: "identify", hz: c.tunedHz },
			does: `Runs Identify in the tuned card on ${mhz(c.tunedHz)}`,
			done: `Identifying ${mhz(c.tunedHz)}`,
		}
	}

	decodeScopeItem(): PaletteItem | null {
		const c = this.#c
		if (c.tunedHz === null || c.readOnly) return null
		return {
			id: "scope:decode",
			title: "Decode as…",
			sub: `Try one decoder on ${mhz(c.tunedHz)} · never moves the receiver`,
			glyph: "identify",
			scope: "decode",
			keys: ["force decoder", "try protocol", "decode with"],
		}
	}

	decodeAsItem(p: (typeof DECODE_AS)[number]): PaletteItem | null {
		const c = this.#c
		if (c.tunedHz === null || c.readOnly) return null
		return {
			id: `decode:${p.id}`,
			title: p.label,
			sub: `With ${p.by} on ${mhz(c.tunedHz)}`,
			glyph: "identify",
			keys: [`decode as ${p.label}`],
			action: { kind: "identify", hz: c.tunedHz, protocols: [p.id] },
			does: `Tries ${p.label} in the tuned card on ${mhz(c.tunedHz)}`,
			done: `Trying ${p.label} on ${mhz(c.tunedHz)}`,
		}
	}

	scanControlItems(): PaletteItem[] {
		const sweep = this.#c.sweep
		if (!sweep) return []
		const s = sweep.state
		const out: PaletteItem[] = []
		const name = sweep.name ?? "Scan"
		if (s === "running" || s === "holding" || s === "starting")
			out.push({
				id: "scan:pause",
				title: "Pause scan",
				sub: name,
				glyph: "pause",
				keys: ["hold scan"],
				action: { kind: "scanJob", op: "pause" },
				does: "Keeps the receiver until you resume · never resumes on its own",
				done: "Scan paused",
			})
		if (s === "paused")
			out.push({
				id: "scan:resume",
				title: "Resume scan",
				sub: name,
				glyph: "play",
				keys: ["continue scan"],
				action: { kind: "scanJob", op: "resume" },
				does: "Gives the receiver back to the scan, where it left off",
				done: "Scan resumed",
			})
		out.push({
			id: "scan:stop",
			title: "Stop scan",
			sub: name,
			glyph: "stop",
			keys: ["end scan", "cancel scan", "give back the receiver"],
			action: { kind: "scanJob", op: "stop" },
			does: "Ends the scan · the receiver and decoders are yours again · discoveries stay",
			done: "Scan stopped",
		})
		return out
	}

	activityItem(
		tokens: readonly ActivityToken[],
		id: string,
		title: string,
		sub: string,
		glyph: GlyphName,
	): PaletteItem {
		return {
			id,
			title,
			sub,
			glyph,
			action: { kind: "activity", tokens, label: title },
			does: `Opens Activity: ${title.replace(/^Show /, "")}`,
			done: title.replace(/^Show /, "Showing "),
		}
	}

	frequencyActivityItem(): PaletteItem | null {
		const c = this.#c
		if (c.tunedHz === null) return null
		const bw = c.config?.bandwidth
		return this.activityItem(
			[
				{
					kind: "frequency",
					hz: c.tunedHz,
					...(bw ? { bandwidthHz: bw } : {}),
				},
			],
			"find:here",
			`Everything heard on ${mhz(c.tunedHz)}`,
			"Calls, messages and decodes on this frequency",
			"activity",
		)
	}

	rootCommands(): PaletteItem[] {
		const c = this.#c
		const rx = c.receiver
		const here = this.savedHere()
		const items: (PaletteItem | null)[] = [
			this.tuneScopeItem(),
			c.tunedHz === null
				? null
				: {
						id: "step:up",
						title: "Step up",
						sub: `By ${formatWidth(c.stepHz)} to ${formatMHz(c.tunedHz + c.stepHz)}`,
						glyph: "up",
						kbd: ["]"],
						keys: ["next channel", "up"],
						action: { kind: "tune", hz: c.tunedHz + c.stepHz },
						effects: [
							{
								label: "Frequency",
								from: mhz(c.tunedHz),
								to: mhz(c.tunedHz + c.stepHz),
							},
						],
						done: `Tuned to ${mhz(c.tunedHz + c.stepHz)}`,
					},
			c.tunedHz === null
				? null
				: {
						id: "step:down",
						title: "Step down",
						sub: `By ${formatWidth(c.stepHz)} to ${formatMHz(c.tunedHz - c.stepHz)}`,
						glyph: "down",
						kbd: ["["],
						keys: ["previous channel", "down"],
						action: { kind: "tune", hz: c.tunedHz - c.stepHz },
						effects: [
							{
								label: "Frequency",
								from: mhz(c.tunedHz),
								to: mhz(c.tunedHz - c.stepHz),
							},
						],
						done: `Tuned to ${mhz(c.tunedHz - c.stepHz)}`,
					},
			{
				id: "scope:mode",
				title: "Mode",
				glyph: "mode",
				...(c.config ? { value: modeLabel(c.config.modulation) } : {}),
				kbd: ["M"],
				keys: ["demodulation", "nfm", "am", "wfm", "usb", "lsb", "cw"],
				scope: "mode",
			},
			{
				id: "scope:bw",
				title: "Bandwidth",
				glyph: "bw",
				...(c.config
					? {
							value:
								c.config.modulation === "raw"
									? "Full span"
									: formatWidth(c.config.bandwidth),
						}
					: {}),
				keys: ["filter", "width"],
				scope: "bw",
			},
			{
				id: "scope:step",
				title: "Tuning step",
				glyph: "step",
				value:
					c.chosenStepHz === null
						? `Auto · ${formatWidth(c.stepHz)}`
						: formatWidth(c.chosenStepHz),
				keys: ["channel spacing"],
				scope: "step",
			},
			c.saved === null || c.tunedHz === null
				? null
				: here
					? {
							id: "scope:savedhere",
							title: `Saved as “${here.name}”`,
							glyph: "bookmark",
							value: here.group ?? "",
							kbd: ["B"],
							scope: "saved",
						}
					: this.saveScopeItem(),
			c.saved === null
				? null
				: {
						id: "scope:saved",
						title: "Saved frequencies",
						glyph: "bookmark",
						value: String(c.saved.length),
						kbd: ["B"],
						keys: ["bookmarks", "favourites", "favorites", "memories"],
						scope: "saved",
					},
			c.config === null
				? null
				: {
						id: "tog:listen",
						title: c.listening ? "Stop listening" : "Listen",
						glyph: "listen",
						toggle: c.listening,
						kbd: ["L"],
						keys: ["mute", "audio", "unmute", "play"],
						action: { kind: "listen", on: !c.listening },
						does: c.listening
							? "Stops the audio in this browser"
							: "Plays the tuned channel in this browser",
						done: c.listening ? "Stopped listening" : "Listening",
					},
			{
				id: "scope:sq",
				title: "Squelch",
				glyph: "squelch",
				value: squelchLabel(c.config),
				kbd: ["Q"],
				keys: ["threshold", "sql"],
				scope: "sq",
			},
			{
				id: "scope:vol",
				title: "Volume",
				glyph: "volume",
				value: `${Math.round(c.volume * 100)} %`,
				keys: ["loudness"],
				scope: "vol",
			},
			rx
				? {
						id: "scope:gain",
						title: "Gain",
						glyph: "gain",
						value: rx.gainAuto ? "Auto" : gainLabel(rx.gainTenthsDb),
						keys: ["rf gain", "lna"],
						scope: "gain",
					}
				: null,
			rx && rx.rates.length > 0
				? {
						id: "scope:rate",
						title: "Sample rate",
						glyph: "rate",
						value: formatRate(rx.sampleRateHz),
						keys: ["span", "bandwidth sdr"],
						scope: "rate",
					}
				: null,
			rx
				? {
						id: "tog:biasT",
						title: "Bias-T",
						glyph: "bolt",
						toggle: rx.biasTee,
						keys: ["lna power", "bias tee"],
						...(rx.lockReason
							? { info: true, sub: rx.lockReason }
							: {
									action: { kind: "biasTee", on: !rx.biasTee } as const,
									effects: [
										{
											label: "Bias-T",
											from: rx.biasTee ? "On" : "Off",
											to: rx.biasTee ? "Off" : "On",
										},
									],
									...(rx.biasTee
										? {}
										: {
												warn: "Puts 4.5 V on the antenna port. Only with an LNA or active antenna.",
											}),
									done: rx.biasTee ? "Bias-T off" : "Bias-T on",
								}),
					}
				: null,
			rx
				? {
						id: "tog:rtlAgc",
						title: "RTL AGC",
						glyph: "gain",
						toggle: rx.rtlAgc,
						keys: ["digital gain"],
						...(rx.lockReason
							? { info: true, sub: rx.lockReason }
							: {
									action: { kind: "rtlAgc", on: !rx.rtlAgc } as const,
									effects: [
										{
											label: "RTL AGC",
											from: rx.rtlAgc ? "On" : "Off",
											to: rx.rtlAgc ? "Off" : "On",
										},
									],
									done: rx.rtlAgc ? "RTL AGC off" : "RTL AGC on",
								}),
					}
				: null,
			{
				id: "scope:theme",
				title: "Theme",
				glyph: "theme",
				value: THEME_OPTS.find(o => o[0] === c.theme.theme)?.[1] ?? "",
				keys: [
					"dark mode",
					"light mode",
					"night",
					"day",
					"appearance",
					"colour scheme",
					"color scheme",
					"paper",
				],
				scope: "theme",
			},
			{
				id: "scope:ground",
				title: "Dark ground",
				glyph: "ground",
				value: GROUND_OPTS[c.theme.ground][0],
				keys: [
					"dark",
					"black",
					"true black",
					"oled",
					"amoled",
					"graphite",
					"grey",
					"gray",
					"ink",
					"background",
				],
				scope: "ground",
			},
			{
				id: "scope:accent",
				title: "Accent",
				glyph: "palette",
				value: ACCENT_LABEL[c.theme.accent],
				keys: ["colour", "color", "highlight", "tint"],
				scope: "accent",
			},
			{
				id: "scope:waterfall",
				title: "Waterfall colours",
				glyph: "waterfall",
				value: WATERFALL_OPTS[c.theme.waterfall][0],
				keys: ["palette", "colours", "colors", "heat", "ramp", "classic"],
				scope: "waterfall",
			},
			this.activityItem(
				[],
				"activity",
				"Search Activity",
				"Talkgroups, callsigns, messages, transcripts",
				"search",
			),
			this.identifyItem(),
			this.decodeScopeItem(),
			{
				id: "scope:scan",
				title: "Scan a band…",
				sub: "Pick bands or draw your own ranges",
				glyph: "scan",
				keys: ["scanner", "sweep", "discover", "find signals", "planner"],
				scope: "scan",
			},
			...this.scanControlItems(),
			{
				id: "scan:discoveries",
				title: "Show discoveries",
				sub: "Everything the scanner has found around you",
				glyph: "scan",
				keys: ["found", "band map", "what is around"],
				action: { kind: "drawer", id: "scanner" },
				does: "Opens Scanner on its discoveries",
			},
			...VIEWS.map(v => this.viewItem(v)),
			c.tunedHz === null
				? null
				: {
						id: "copy:freq",
						title: "Copy frequency",
						sub: mhz(c.tunedHz),
						glyph: "copy",
						action: {
							kind: "copy",
							text: mhz(c.tunedHz),
							label: `Copied ${mhz(c.tunedHz)}`,
						},
						does: `Copies “${mhz(c.tunedHz)}” to the clipboard`,
					},
			{
				id: "scope:set",
				title: "All settings",
				glyph: "settings",
				value: String(SETTINGS_REGISTRY.length),
				keys: ["settings", "preferences", "options", "configuration", "config"],
				scope: "set",
			},
			{
				id: "scope:keys",
				title: "Keyboard shortcuts",
				glyph: "keys",
				kbd: ["?"],
				keys: ["help", "hotkeys"],
				scope: "keys",
			},
		]
		const out = items.filter((x): x is PaletteItem => x !== null)
		// the Search Activity row focuses the search
		return out.map(x =>
			x.id === "activity"
				? {
						...x,
						kbd: ["/"],
						does: "Opens Activity with the search field focused",
						done: "Opened Activity",
					}
				: x,
		)
	}

	deepItems(): PaletteItem[] {
		return DEEP.flatMap(s =>
			this.scopeItems(s).map(it => ({
				...it,
				title: `${SCOPES[s].title} › ${it.title}`,
				aliases: [it.title],
			})),
		)
	}

	suggested(): PaletteItem[] {
		const c = this.#c
		const out: (PaletteItem | null)[] = [this.tuneScopeItem()]
		out.push(...this.scanControlItems().filter(x => x.id !== "scan:stop"))
		if (c.saved !== null && c.tunedHz !== null && !this.savedHere())
			out.push(this.saveScopeItem())
		if (c.tunedHz !== null && !this.savedHere()) out.push(this.identifyItem())
		out.push(this.frequencyActivityItem())
		return out.filter((x): x is PaletteItem => x !== null)
	}

	/** Every row an id can name, for the Recent group. */
	lookup(id: string): PaletteItem | null {
		const c = this.#c
		if (id.startsWith("tune:")) {
			const hz = Number(id.slice(5))
			return Number.isFinite(hz) && hz > 0 ? this.tuneItem(hz) : null
		}
		if (id.startsWith("saved:")) {
			const f = c.saved?.find(x => `saved:${x.id}` === id)
			return f ? this.savedItem(f) : null
		}
		if (id.startsWith("disc:")) {
			const d = c.discoveries.find(x => `disc:${x.id}` === id)
			return d ? this.discoveryItem(d) : null
		}
		if (id.startsWith("set:")) {
			const e = SETTINGS_REGISTRY.find(x => `set:${x.id}` === id)
			return e ? this.settingItem(e) : null
		}
		const root = this.rootCommands().find(x => x.id === id)
		if (root) return root
		for (const s of Object.keys(SCOPES) as ScopeId[]) {
			if (s === "save" || s === "keys" || s === "set" || s === "saved") continue
			const hit = this.scopeItems(s).find(x => x.id === id)
			if (hit) return { ...hit, title: `${SCOPES[s].title} › ${hit.title}` }
		}
		return null
	}

	// -- typed intents

	#command(intent: CommandIntent): PaletteItem | null {
		const c = this.#c
		switch (intent.kind) {
			case "gain": {
				const rx = c.receiver
				if (!rx) return null
				if (intent.db === "auto")
					return { ...this.gainItem("auto"), title: "Gain › Auto" }
				const want = Math.round(intent.db * 10)
				const steps = rx.gainSteps
				let best = steps[0] ?? want
				for (const s of steps)
					if (Math.abs(s - want) < Math.abs(best - want)) best = s
				const it = this.gainItem(best)
				return {
					...it,
					title: `Gain › ${it.title}`,
					...(best !== want
						? {
								sub: `Nearest step to ${intent.db} dB in this tuner's gain table`,
							}
						: {}),
				}
			}
			case "squelch": {
				const v = intent.value
				if (typeof v === "number" && (v < -120 || v > -20))
					return {
						id: "info:sq",
						info: true,
						title: "Squelch goes from −120 dB to −20 dB",
						glyph: "alert",
					}
				const it = this.sqItem(v)
				return { ...it, title: `Squelch › ${it.title}` }
			}
			case "bandwidth": {
				const cfg = c.config
				if (!cfg) return null
				const spec = modeSpec(cfg.modulation).bw
				if (!spec)
					return {
						id: "info:bw",
						info: true,
						title: "RAW mode uses the full span",
						sub: "Switch to a voice mode to set a bandwidth",
						glyph: "alert",
					}
				if (intent.hz < spec[0] || intent.hz > spec[1])
					return {
						id: "info:bw",
						info: true,
						title: `${modeLabel(cfg.modulation)} allows ${formatWidth(spec[0])} to ${formatWidth(spec[1])}`,
						glyph: "alert",
					}
				const it = this.bwItem(intent.hz)
				return { ...it, title: `Bandwidth › ${it.title}` }
			}
			case "step": {
				const it = this.stepItem(intent.hz)
				return { ...it, title: `Tuning step › ${it.title}` }
			}
			case "rate": {
				const rates = c.receiver?.rates ?? []
				if (rates.length === 0) return null
				const want = intent.msps * 1e6
				let best = rates[0] ?? want
				for (const r of rates)
					if (Math.abs(r - want) < Math.abs(best - want)) best = r
				const it = this.rateItem(best)
				return { ...it, title: `Sample rate › ${it.title}` }
			}
			case "volume": {
				const it = this.volItem(intent.percent)
				return { ...it, title: `Volume › ${it.title}` }
			}
			case "mode": {
				const it = this.modeItem(intent.mode)
				return { ...it, title: `Mode › ${it.title}` }
			}
		}
	}

	intents(q: string): {
		tune: PaletteItem[]
		cmd: PaletteItem[]
		act: PaletteItem[]
	} {
		const c = this.#c
		const s = q.trim().toLowerCase()
		const out = {
			tune: [] as PaletteItem[],
			cmd: [] as PaletteItem[],
			act: [] as PaletteItem[],
		}
		const p = parseFrequencyIntent(q, c.tunedHz ?? 0)
		if (p.kind === "ok" && !(p.relative && c.tunedHz === null)) {
			const spec = p.mode ? modeSpec(p.mode).bw : null
			const bw =
				p.bandwidthHz &&
				spec &&
				p.bandwidthHz >= spec[0] &&
				p.bandwidthHz <= spec[1]
					? p.bandwidthHz
					: null
			const it = this.tuneItem(p.hz, { mode: p.mode, bandwidthHz: bw })
			const band = bandName(c.bandplan, p.hz) ?? "no band plan entry"
			out.tune.push({
				...it,
				big: true,
				...(p.pasted
					? {
							sub: [
								"From pasted text",
								band,
								p.mode ? modeLabel(p.mode) : null,
								bw ? formatWidth(bw) : null,
							]
								.filter(Boolean)
								.join(" · "),
						}
					: p.relative
						? {
								title: `${q.trim().startsWith("-") ? "Step down" : "Step up"} to ${mhz(p.hz)}`,
								sub: `${p.hint ?? ""} · ${band}`,
							}
						: {}),
			})
		} else if (p.kind === "error" && /[.a-z]/.test(s))
			out.tune.push({
				id: "info:range",
				info: true,
				title: p.message,
				glyph: "alert",
			})
		const cmd = parseCommand(q)
		if (cmd) {
			const it = this.#command(cmd)
			if (it) out.cmd.push(it)
		}
		for (const id of parseIdentifiers(q)) {
			if (id.kind === "talkgroup")
				out.act.push(
					this.activityItem(
						[{ kind: "talkgroup", value: id.value }],
						`find:tg${id.value}`,
						`Show TG ${id.value} in Activity`,
						"Every call on this talkgroup",
						"cat-voice",
					),
				)
			else if (id.kind === "capcode")
				out.act.push(
					this.activityItem(
						[{ kind: "capcode", value: id.value }],
						`find:cap${id.value}`,
						`Show pages to capcode ${id.value}`,
						"POCSAG and FLEX messages",
						"cat-paging",
					),
				)
			else
				out.act.push(
					this.activityItem(
						[{ kind: "mmsi", value: id.value }],
						`find:mmsi${id.value}`,
						`Show vessel MMSI ${id.value}`,
						"AIS positions and voyage data",
						"cat-marine",
					),
				)
		}
		if (s.length >= 2)
			out.act.push(
				this.activityItem(
					[{ kind: "text", value: q.trim() }],
					`search:${s}`,
					`Search Activity for “${q.trim()}”`,
					"Messages, callsigns, transcripts",
					"search",
				),
			)
		return out
	}

	// -- the list

	build(scope: ScopeId | null, query: string): PaletteGroup[] {
		const c = this.#c
		const q = query.trim()
		const groups: { label: string; items: RankedItem[]; top: number }[] = []
		const seen = new Set<string>()
		const push = (
			label: string,
			items: readonly (PaletteItem | RankedItem)[],
			top?: number,
		) => {
			const list: RankedItem[] = []
			for (const it of items) {
				if (seen.has(it.id)) continue
				seen.add(it.id)
				list.push("score" in it ? it : { ...it, score: 0, idx: [] })
			}
			if (list.length > 0)
				groups.push({
					label,
					items: list,
					top: top ?? Math.max(...list.map(x => x.score)),
				})
		}
		const exact = (items: readonly PaletteItem[], score = 1000): RankedItem[] =>
			items.map(it => ({ ...it, score, idx: [] }))
		const ranked = (items: readonly PaletteItem[]) => rank(items, q, c.boost)
		if (scope === "tune") {
			if (!q) {
				push(
					"Recent",
					c.recent
						.filter(
							id =>
								id.startsWith("tune:") ||
								id.startsWith("saved:") ||
								id.startsWith("disc:"),
						)
						.map(id => this.lookup(id))
						.filter((x): x is PaletteItem => x !== null)
						.slice(0, 5),
					0,
				)
				push(
					"Saved frequencies",
					(c.saved ?? []).map(f => this.savedItem(f)),
					0,
				)
			} else {
				const it = this.intents(q).tune
				push("Tune", [
					...exact(it),
					...ranked([...this.channelItems(q), ...this.tuneTargets()]).slice(
						0,
						6,
					),
				])
			}
		} else if (scope) {
			const meta = SCOPES[scope]
			const items = this.scopeItems(scope, q)
			if (meta.raw || !q) push(meta.title, items, 0)
			else {
				if (meta.prefix) {
					const it = this.intents(`${meta.prefix} ${q}`).cmd
					push(
						"Set",
						exact(
							it.map(x => ({ ...x, title: x.title.replace(/^.* › /, "") })),
						),
					)
				}
				push(meta.title, ranked(items))
			}
		} else if (!q) {
			push("Suggested", this.suggested(), 4)
			push(
				"Recent",
				c.recent
					.map(id => this.lookup(id))
					.filter((x): x is PaletteItem => x !== null)
					.slice(0, 4),
				3,
			)
			push(
				"Saved frequencies",
				(c.saved ?? []).slice(0, 4).map(f => this.savedItem(f)),
				2,
			)
			push("All commands", this.rootCommands(), 1)
		} else {
			const it = this.intents(q)
			push("Tune", [
				...exact(it.tune),
				...ranked([...this.channelItems(q), ...this.tuneTargets()]).slice(0, 4),
			])
			const all = ranked([
				...this.rootCommands(),
				...(q.length >= 2 ? this.deepItems() : []),
				...this.settingItems(),
			])
			// a setting with an inline scope or switch: the inline row first, its "Open in …" row right after it
			const tied = all.filter(x => x.link && all.some(y => y.id === x.link))
			const list = all.filter(x => !tied.includes(x))
			for (const x of tied) {
				const i = list.findIndex(y => y.id === x.link)
				const anchor = list[i]
				if (anchor) list.splice(i + 1, 0, { ...x, score: anchor.score })
			}
			push("Commands", [...exact(it.cmd), ...list.slice(0, 12)])
			push(
				"Activity",
				it.act.map((x, i) => ({
					...x,
					score: x.id.startsWith("search:") ? 1 : 1000 - i,
					idx: [],
				})),
			)
			groups.sort((a, b) => b.top - a.top)
		}
		return groups.map(g => ({ label: g.label, items: g.items }))
	}
}

/** Settings that also have an inline scope or switch here: the inline row ranks first. */
const SETTING_LINK: Readonly<Record<string, string>> = {
	"dev.theme": "scope:theme",
	"dev.ground": "scope:ground",
	"dev.accent": "scope:accent",
	"dev.waterfall": "scope:waterfall",
	"rx.gain": "scope:gain",
	"rx.rate": "scope:rate",
	"rx.biasT": "tog:biasT",
	"rx.rtlAgc": "tog:rtlAgc",
	"au.squelch": "scope:sq",
	"au.volume": "scope:vol",
	"tn.step": "scope:step",
	"tn.saved": "scope:saved",
}

/** The rows in display order (the listbox's option order). */
export function flatten(groups: readonly PaletteGroup[]): RankedItem[] {
	return groups.flatMap(g => g.items)
}

/** Scopes that choose one value: the cursor starts on the current one. */
const VALUE_SCOPES: ReadonlySet<ScopeId> = new Set<ScopeId>([
	"mode",
	"bw",
	"step",
	"gain",
	"rate",
	"sq",
	"vol",
	"theme",
	"ground",
	"accent",
	"waterfall",
])

/** Where the cursor starts in a scope: on the current value of a value scope, else on the first row. */
export function initialIndex(
	groups: readonly PaletteGroup[],
	scope: ScopeId | null,
): number {
	if (!scope || !VALUE_SCOPES.has(scope)) return 0
	const i = flatten(groups).findIndex(x => x.cur)
	return Math.max(0, i)
}

// The Settings drawer's model (docs/web/DESIGN.md "Settings, first pass" and "Settings polish"): eight groups, rows
// with one widget each, changed marks against a known default, locks, effects that wait for Apply, and the search
// with its typed filters. Pure: the drawer builds rows from the stores (rows.ts) and renders them; tests run here.
import type { SettingWriteResult } from "../../data/index.ts"

export type SettingGroupId =
	| "station"
	| "receiver"
	| "audio"
	| "decoders"
	| "storage"
	| "map"
	| "display"
	| "system"

export interface SettingGroup {
	readonly id: SettingGroupId
	readonly label: string
	/** Rail name when the label is long. */
	readonly short?: string
	readonly desc: string
}

export const SETTING_GROUPS: readonly SettingGroup[] = [
	{
		id: "station",
		label: "Station",
		desc: "Who and where this receiver is. Set once, used everywhere.",
	},
	{
		id: "receiver",
		label: "Receiver",
		desc: "The dongle and how WaveKit talks to it.",
	},
	{ id: "audio", label: "Audio", desc: "How what you listen to sounds." },
	{
		id: "decoders",
		label: "Decoders",
		desc: "What WaveKit decodes. Open one for its settings.",
	},
	{
		id: "storage",
		label: "Recording & storage",
		short: "Storage",
		desc: "What is recorded, and for how long.",
	},
	{ id: "map", label: "Map", desc: "Map tiles, trails and coverage." },
	{
		id: "display",
		label: "Display",
		desc: "Theme, spectrum, units, time and language.",
	},
	{
		id: "system",
		label: "System",
		desc: "Access, updates and the machine underneath.",
	},
]

export const groupOf = (id: SettingGroupId): SettingGroup =>
	SETTING_GROUPS.find(g => g.id === id) ?? (SETTING_GROUPS[0] as SettingGroup)

export type SettingValue =
	| string
	| number
	| boolean
	| readonly string[]
	| readonly number[]
	| null

export interface SettingOption {
	readonly value: string
	readonly label: string
	/** Why it cannot be picked. */
	readonly disabled?: string
}

/** Option values are strings so one Seg / select fits every type; rows map them back. */
export interface SwitchWidget {
	readonly kind: "switch"
}
export interface SegWidget {
	readonly kind: "seg"
	readonly options: readonly SettingOption[]
}
/** Waterfall colours: one tile per ramp, a strip from weak to strong signal over the current ground. */
export interface RampWidget {
	readonly kind: "ramp"
	readonly options: readonly SettingOption[]
}
export interface SelectWidget {
	readonly kind: "select"
	readonly options: readonly SettingOption[]
}
export interface StepperWidget {
	readonly kind: "stepper"
	readonly min: number
	readonly max: number
	readonly step: number
	/** Shown after the number (" dB"). */
	readonly unit?: string
}
export interface SliderWidget {
	readonly kind: "slider"
	readonly min: number
	readonly max: number
	readonly step: number
	readonly format: (value: number) => string
}
export interface TextWidget {
	readonly kind: "text"
	readonly placeholder?: string
	readonly inputMode?: "text" | "decimal"
	/** Text to value, or an error shown under the field (nothing is saved). */
	readonly parse: (text: string) => { value: SettingValue } | { error: string }
	/** Value to the field's text. */
	readonly format: (value: SettingValue) => string
	readonly secret?: boolean
}
export interface ChipsWidget {
	readonly kind: "chips"
	readonly options: readonly SettingOption[]
}
export interface ReadWidget {
	readonly kind: "read"
}
export interface LinkWidget {
	readonly kind: "link"
	readonly text: string
	readonly action: () => void
}
export interface ButtonsWidget {
	readonly kind: "buttons"
	readonly buttons: readonly {
		readonly label: string
		readonly action: () => void
		readonly href?: string
	}[]
}
/** A decoder in the Decoders group: opens its page; the value is whether it is enabled. */
export interface PageWidget {
	readonly kind: "page"
	readonly page: string
	readonly tool: string
	readonly status: string
	readonly tone: "run" | "idle" | "fault" | "off"
}
export type SettingWidget =
	| PageWidget
	| SwitchWidget
	| SegWidget
	| RampWidget
	| SelectWidget
	| StepperWidget
	| SliderWidget
	| TextWidget
	| ChipsWidget
	| ReadWidget
	| LinkWidget
	| ButtonsWidget

/** What a change does beyond itself: restarts something, or touches the hardware. It waits for Apply. */
export interface SettingEffect {
	readonly kind: "restart" | "hardware"
	/** The tooltip and the waiting note: "Restarts every decoder". */
	readonly text: string
	/** The Apply bar's list: "restarts every decoder". */
	readonly short: string
}

export interface SettingRow {
	readonly id: string
	readonly group: SettingGroupId
	/** A decoder page id: the row lives on that page, not in the group. */
	readonly page?: string
	readonly label: string
	readonly help?: string
	/** Words people search with. */
	readonly keys: readonly string[]
	/** Under the section's "More" fold. */
	readonly more?: boolean
	/** Kept by this browser only (Display › On this device). */
	readonly device?: boolean
	readonly effect?: SettingEffect
	readonly widget: SettingWidget
	readonly value: SettingValue
	/** The value as words ("2.4 MS/s"), for read rows, search and copy. */
	readonly text: string
	/** The default, when known: a row differing from it is changed and offers "Reset to …". */
	readonly def?: { readonly value: SettingValue; readonly text: string }
	/** Set where the UI cannot change it: "Set by WAVEKIT_COUNTRY · change it in the environment". */
	readonly lock?: string
	/** The control is off for a reason the row shows. */
	readonly disabled?: string
	readonly warn?: (value: SettingValue) => string | null
	/** The core's last error for this setting. */
	readonly error?: string
	/** A write for this setting is in flight. */
	readonly busy?: boolean
	/** Absent: read-only. */
	readonly write?: (value: SettingValue) => Promise<SettingWriteResult>
}

export const same = (a: SettingValue, b: SettingValue): boolean => {
	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
	return Object.is(a, b)
}

export const isChanged = (row: SettingRow): boolean =>
	row.def !== undefined &&
	row.lock === undefined &&
	!same(row.value, row.def.value)

export const isEditable = (row: SettingRow): boolean =>
	row.write !== undefined &&
	row.lock === undefined &&
	row.disabled === undefined &&
	row.widget.kind !== "read" &&
	row.widget.kind !== "link" &&
	row.widget.kind !== "buttons"

/** The option label for a value, else the value itself. */
export function optionText(
	options: readonly SettingOption[],
	value: SettingValue,
): string {
	if (Array.isArray(value))
		return value
			.map(v => options.find(o => o.value === String(v))?.label ?? String(v))
			.join(", ")
	return (
		options.find(o => o.value === String(value))?.label ??
		(value === null ? "—" : String(value))
	)
}

// ---- search

export type SettingFilter = "changed" | "restart" | "hardware" | "locked"

export const FILTERS: readonly {
	readonly id: SettingFilter
	readonly label: string
	readonly words: readonly string[]
}[] = [
	{ id: "changed", label: "Changed", words: ["changed", "modified", "edited"] },
	{
		id: "restart",
		label: "Restarts something",
		words: ["restarts", "restart", "restarts something"],
	},
	{
		id: "hardware",
		label: "Touches hardware",
		words: ["hardware", "touches hardware", "dongle"],
	},
	{ id: "locked", label: "Locked", words: ["locked", "lock", "env"] },
]

export function passes(row: SettingRow, filter: SettingFilter): boolean {
	switch (filter) {
		case "changed":
			return isChanged(row)
		case "restart":
			return row.effect?.kind === "restart"
		case "hardware":
			return row.effect?.kind === "hardware"
		case "locked":
			return row.lock !== undefined
	}
}

const fold = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[‑–—-]/g, " ")

/** The words a row is found by: name, help, aliases, its value and its option names. */
export function haystack(row: SettingRow, crumb: string): string {
	const w = row.widget
	const opts =
		w.kind === "seg" ||
		w.kind === "ramp" ||
		w.kind === "select" ||
		w.kind === "chips"
			? w.options.map(o => o.label).join(" ")
			: ""
	return fold(
		[row.label, row.help ?? "", row.keys.join(" "), row.text, opts, crumb].join(
			" ",
		),
	)
}

/** Every word of the query appears in the row (prefix of a word in the haystack). */
export function matches(hay: string, query: string): boolean {
	const q = fold(query).trim()
	if (!q) return true
	const words = hay.split(/\s+/)
	return q
		.split(/\s+/)
		.every(part => words.some(w => w.startsWith(part)) || hay.includes(part))
}

/** A filter the query names exactly ("changed"): offered as "Show only …". */
export function filterSuggestion(
	query: string,
	active: readonly SettingFilter[],
): SettingFilter | null {
	const q = fold(query).trim()
	if (q.length < 3) return null
	const hit = FILTERS.find(
		f => !active.includes(f.id) && f.words.some(w => w.startsWith(q)),
	)
	return hit?.id ?? null
}

// ---- pending (Apply)

export interface PendingChange {
	readonly id: string
	readonly value: SettingValue
}

/** "2 changes waiting" and "Restarts every decoder, turns on antenna power". */
export function pendingSummary(
	pending: readonly PendingChange[],
	rows: readonly SettingRow[],
): { title: string; sub: string } {
	const effects: string[] = []
	for (const p of pending) {
		const short = rows.find(r => r.id === p.id)?.effect?.short
		if (short && !effects.includes(short)) effects.push(short)
	}
	const n = pending.length
	const sub = effects.join(", ")
	return {
		title: `${n} change${n === 1 ? "" : "s"} waiting`,
		sub: sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : "",
	}
}

/** One line of YAML for "Copy as YAML": `receiver.ppm: 3`. */
export function yamlLine(row: SettingRow): string {
	const v = row.value
	const scalar = (x: string | number | boolean | null) =>
		typeof x === "string" ? JSON.stringify(x) : String(x)
	const text = Array.isArray(v)
		? `[${(v as readonly (string | number)[]).map(scalar).join(", ")}]`
		: scalar(v as string | number | boolean | null)
	return `${row.id}: ${text}`
}

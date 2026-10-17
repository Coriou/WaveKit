// The band editor's rows (Settings.dc.html bpDefs): one settings row per band field, so the editor reads like any
// other Settings page, with the pack's value as the default ("Reset to …") and each change saved at once.
import type { Band, BandEditFields } from "@wavekit/api-types"
import { DISPLAY_GROUPS } from "@wavekit/api-types"
import type { SettingWriteResult } from "../../../data/setting-write.ts"
import { formatMHz, formatWidth } from "../../format.ts"
import { groupName } from "../../tuner/band.ts"
import type {
	SettingOption,
	SettingRow,
	SettingValue,
	TextWidget,
} from "../model.ts"
import { optionText } from "../model.ts"
import type { BandEntry } from "./model.ts"

/** The tuner reaches about 24–1766 MHz (DESIGN.md "can we scan any band"). */
export const TUNER_MIN_HZ = 24_000_000
export const TUNER_MAX_HZ = 1_766_000_000

const MODES: readonly SettingOption[] = [
	{ value: "", label: "Not set" },
	{ value: "nfm", label: "NFM" },
	{ value: "am", label: "AM" },
	{ value: "wfm", label: "Wide FM" },
	{ value: "usb", label: "USB" },
	{ value: "lsb", label: "LSB" },
	{ value: "dsb", label: "DSB" },
	{ value: "cw", label: "CW" },
	{ value: "raw", label: "Raw IQ" },
]
const WIDTHS = [6250, 8330, 10000, 12500, 25000, 40000, 200000]
const STEPS = [5000, 6250, 8330, 10000, 12500, 25000, 100000, 1712000]

const hzOptions = (
	list: readonly number[],
	current: number | null,
): SettingOption[] => {
	const values =
		current !== null && !list.includes(current)
			? [...list, current].sort((a, b) => a - b)
			: list
	return [
		{ value: "", label: "Not set" },
		...values.map(v => ({ value: String(v), label: formatWidth(v) })),
	]
}

/** "156.000 – 162.025" or "156 162.025": both edges in MHz, inside what the tuner reaches. */
export function parseEdges(
	text: string,
): { value: SettingValue } | { error: string } {
	const parts = text
		.replace(/mhz/gi, "")
		.split(/\s*(?:[–—-]|to|\s)\s*/)
		.map(s => s.trim().replace(",", "."))
		.filter(Boolean)
	const [a, b] = parts.map(Number)
	if (
		parts.length !== 2 ||
		!(a !== undefined && a > 0) ||
		!(b !== undefined && b > 0)
	)
		return { error: "Type both edges in MHz, like 156.000 – 162.025" }
	const lo = Math.round(a * 1e6)
	const hi = Math.round(b * 1e6)
	if (lo >= hi) return { error: "The lower edge must be below the upper edge" }
	if (lo < TUNER_MIN_HZ || hi > TUNER_MAX_HZ)
		return { error: "Outside what the dongle tunes, 24 to 1766 MHz" }
	return { value: [lo, hi] }
}

export const edgesValue = (b: Band): readonly number[] => [b.startHz, b.endHz]
export const edgesLabel = (v: SettingValue): string =>
	Array.isArray(v) && v.length === 2
		? `${formatMHz(Number(v[0]))} – ${formatMHz(Number(v[1]))}`
		: ""

const text = (
	placeholder: string,
	parse: TextWidget["parse"],
	format: TextWidget["format"] = v => (v === null ? "" : String(v)),
	inputMode: "text" | "decimal" = "text",
): TextWidget => ({ kind: "text", placeholder, inputMode, parse, format })

export interface EditorRowsInput {
	readonly entry: BandEntry
	/** Bands of the same plan, for the parent list. */
	readonly siblings: readonly BandEntry[]
	readonly readOnly: string | undefined
	/** Saves fields of the band; `label` names the change in the toast. */
	readonly save: (
		set: BandEditFields,
		label: string,
	) => Promise<SettingWriteResult>
}

/** Name, edges, group, mode, bandwidth and step; then More: skip, its reason, parent band and hide. */
export function editorRows(input: EditorRowsInput): {
	main: SettingRow[]
	more: SettingRow[]
} {
	const { entry, siblings, readOnly, save } = input
	const b = entry.band
	const o = entry.original
	const page = `bandplans:${entry.key}`
	const row = (
		field: string,
		label: string,
		r: Omit<SettingRow, "id" | "group" | "page" | "label" | "keys"> & {
			keys?: readonly string[]
		},
	): SettingRow => ({
		id: `bandplans.${entry.key}.${field}`,
		group: "station",
		page,
		label,
		keys: r.keys ?? [],
		...r,
		...(readOnly ? { lock: readOnly } : {}),
	})
	const def = (value: SettingValue, words: string) =>
		o ? { def: { value, text: words } } : {}
	const groups = DISPLAY_GROUPS.map(g => ({ value: g, label: groupName(g) }))
	const modeValue = (m: Band["mode"]) => m ?? ""
	const widths = hzOptions(WIDTHS, b.bandwidthHz)
	const steps = hzOptions(STEPS, b.stepHz)
	const hzOf = (v: SettingValue) => (v === "" || v === null ? null : Number(v))
	const parents = siblings.filter(
		s =>
			s.key !== entry.key &&
			s.band.startHz <= b.startHz &&
			b.endHz <= s.band.endHz &&
			s.band.endHz - s.band.startHz > b.endHz - b.startHz,
	)
	const parentOpts: SettingOption[] = [
		{ value: "", label: "None" },
		...parents.map(p => ({ value: p.band.id, label: p.band.name })),
	]
	if (b.parentId && !parents.some(p => p.band.id === b.parentId))
		parentOpts.push({ value: b.parentId, label: b.parentId })

	const main: SettingRow[] = [
		row("name", "Name", {
			widget: text("Band name", t =>
				t.trim()
					? { value: t.trim().slice(0, 80) }
					: { error: "Give the band a name" },
			),
			value: b.name,
			text: b.name,
			...def(o?.name ?? null, o?.name ?? ""),
			write: v => save({ name: String(v) }, "Name"),
		}),
		row("edges", "Edges", {
			help: "Lower and upper edge, in MHz",
			widget: text("156.000 – 162.025", parseEdges, edgesLabel, "decimal"),
			value: edgesValue(b),
			text: edgesLabel(edgesValue(b)),
			...(o ? def(edgesValue(o), edgesLabel(edgesValue(o))) : {}),
			write: v => {
				const [lo, hi] = v as readonly number[]
				return save({ startHz: lo ?? 0, endHz: hi ?? 0 }, "Edges")
			},
		}),
		row("group", "Group", {
			help: "Sets the colour of its lane on the spectrum",
			widget: { kind: "select", options: groups },
			value: b.group,
			text: groupName(b.group),
			...(o ? def(o.group, groupName(o.group)) : {}),
			write: v => save({ group: String(v) as Band["group"] }, "Group"),
		}),
		row("mode", "Mode", {
			help: "Used when you tune into the band",
			widget: { kind: "select", options: MODES },
			value: modeValue(b.mode),
			text: optionText(MODES, modeValue(b.mode)),
			...(o
				? def(modeValue(o.mode), optionText(MODES, modeValue(o.mode)))
				: {}),
			write: v =>
				save({ mode: v === "" ? null : (String(v) as Band["mode"]) }, "Mode"),
		}),
		row("bandwidth", "Bandwidth", {
			widget: { kind: "select", options: widths },
			value: b.bandwidthHz === null ? "" : String(b.bandwidthHz),
			text: b.bandwidthHz === null ? "Not set" : formatWidth(b.bandwidthHz),
			...(o
				? def(
						o.bandwidthHz === null ? "" : String(o.bandwidthHz),
						o.bandwidthHz === null ? "Not set" : formatWidth(o.bandwidthHz),
					)
				: {}),
			write: v => save({ bandwidthHz: hzOf(v) }, "Bandwidth"),
		}),
		row("step", "Tuning step", {
			widget: { kind: "select", options: steps },
			value: b.stepHz === null ? "" : String(b.stepHz),
			text: b.stepHz === null ? "Not set" : formatWidth(b.stepHz),
			...(o
				? def(
						o.stepHz === null ? "" : String(o.stepHz),
						o.stepHz === null ? "Not set" : formatWidth(o.stepHz),
					)
				: {}),
			write: v => save({ stepHz: hzOf(v) }, "Tuning step"),
		}),
	]
	const skipOn = b.skip !== null
	const more: SettingRow[] = [
		row("skip", "Skip by default", {
			help: "Scan a band leaves it out unless you add it",
			more: true,
			widget: { kind: "switch" },
			value: skipOn,
			text: skipOn ? "On" : "Off",
			...(o ? def(o.skip !== null, o.skip !== null ? "On" : "Off") : {}),
			write: v =>
				save(
					{
						skip:
							v === true
								? { reason: o?.skip?.reason ?? "Skipped by you" }
								: null,
					},
					"Skip by default",
				),
		}),
		...(skipOn
			? [
					row("reason", "Reason", {
						help: "Shown beside the band in Scan a band",
						more: true,
						widget: text("Why scans skip it", t =>
							t.trim()
								? { value: t.trim().slice(0, 80) }
								: { error: "Say why scans skip it" },
						),
						value: b.skip?.reason ?? "",
						text: b.skip?.reason ?? "",
						...(o?.skip ? def(o.skip.reason, o.skip.reason) : {}),
						write: v => save({ skip: { reason: String(v) } }, "Reason"),
					}),
				]
			: []),
		row("parent", "Parent band", {
			help: "A narrower band names its part of a wider one",
			more: true,
			widget: { kind: "select", options: parentOpts },
			value: b.parentId ?? "",
			text: optionText(parentOpts, b.parentId ?? ""),
			...(o
				? def(o.parentId ?? "", optionText(parentOpts, o.parentId ?? ""))
				: {}),
			write: v =>
				save({ parentId: v === "" ? null : String(v) }, "Parent band"),
		}),
		...(o
			? [
					row("hidden", "Hide this band", {
						help: "Leaves the spectrum lanes, presets and ⌘K. Stays listed here.",
						more: true,
						widget: { kind: "switch" },
						value: entry.hidden,
						text: entry.hidden ? "On" : "Off",
						def: { value: false, text: "Off" },
						write: v => save({ hidden: v === true }, "Hide this band"),
					}),
				]
			: []),
	]
	return { main, more }
}

/** "Name, then aliases after commas" to a channel: name and up to 8 aliases. */
export function parseChannelName(
	text: string,
	hz: number,
): { name: string; aliases: string[] } {
	const parts = text
		.split(",")
		.map(x => x.trim())
		.filter(Boolean)
	return {
		name: (parts[0] ?? `${formatMHz(hz)} MHz`).slice(0, 40),
		aliases: parts.slice(1, 9).map(a => a.slice(0, 40)),
	}
}

/** A channel id the core accepts (a slug), unique in the band. */
export function channelId(name: string, taken: readonly string[]): string {
	const base =
		name
			.toLowerCase()
			.normalize("NFD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "ch"
	let id = base
	for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
	return id
}

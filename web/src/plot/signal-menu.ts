// The spectrum's right-click menu on a signal (DESIGN.md open question "Right-click menus on signals", Scanner
// decisions: Identify first). Its rows are palette actions (features/palette/actions.ts) so both run the same code:
// a row is the actions it runs in order (tune there first, then identify, listen or decode).
import type { ResolvedBandPlanView, SavedFrequency } from "@wavekit/api-types"

import { bandAt, channelAt } from "../data/bandplan-store.ts"
import { formatMHz } from "../features/format.ts"
import type { PaletteAction } from "../features/palette/model.ts"
import { DECODE_AS } from "../features/tuned/identify-view.ts"
import { defaultGroup, defaultSaveName } from "../features/tuner/saved.ts"
import type { IconName } from "../ui/Icon.tsx"

export interface SignalMenuContext {
	/** The frequency the menu acts on (snapped to the signal under the cursor). */
	hz: number
	tunedHz: number | null
	readOnly: boolean
	listening: boolean
	plan: ResolvedBandPlanView | null
	saved: readonly SavedFrequency[]
}

export interface SignalStep {
	readonly action: PaletteAction
	/** The toast after this step; null shows none. */
	readonly done: string | null
}

export interface SignalMenuRow {
	readonly id: string
	readonly label: string
	readonly icon: IconName
	readonly key?: string
	readonly hint?: string
	/** Opens the Decode as… list instead of running. */
	readonly submenu?: "decode"
	readonly steps: readonly SignalStep[]
}

const mhz = (hz: number) => `${formatMHz(hz)} MHz`

/** The menu's first line: the frequency, then the plan's channel or band, or the saved name. */
export function signalMenuHead(c: SignalMenuContext): string {
	const saved = savedAt(c)
	const band = bandAt(c.plan, c.hz)
	const name =
		saved?.name ?? channelAt(band, c.hz)?.name ?? band?.band.name ?? null
	const freq = `${formatMHz(c.hz)} MHz`
	return name ? `${freq} · ${name}` : freq
}

function savedAt(c: SignalMenuContext): SavedFrequency | null {
	return c.saved.find(f => f.frequencyHz === Math.round(c.hz)) ?? null
}

export function signalMenuRows(c: SignalMenuContext): SignalMenuRow[] {
	const here = c.tunedHz !== null && Math.round(c.tunedHz) === Math.round(c.hz)
	const tune: SignalStep[] =
		here || c.readOnly
			? []
			: [{ action: { kind: "tune", hz: c.hz }, done: null }]
	const rows: SignalMenuRow[] = []
	if (!c.readOnly) {
		rows.push({
			id: "identify",
			label: "Identify",
			icon: "scanner",
			key: "I",
			steps: [
				...tune,
				{
					action: { kind: "identify", hz: c.hz },
					done: `Identifying ${mhz(c.hz)}`,
				},
			],
		})
		rows.push({
			id: "decode",
			label: "Decode as…",
			icon: "scanner",
			submenu: "decode",
			steps: [],
		})
	}
	if (!here && !c.readOnly) {
		rows.push({
			id: "listen",
			label: c.listening ? "Tune here" : "Listen here",
			icon: c.listening ? "tune" : "headphones",
			steps: [
				...tune,
				...(c.listening
					? []
					: [{ action: { kind: "listen", on: true } as const, done: null }]),
			],
		})
	} else if (here && !c.listening) {
		rows.push({
			id: "listen",
			label: "Listen",
			icon: "headphones",
			steps: [{ action: { kind: "listen", on: true }, done: null }],
		})
	}
	if (!c.readOnly && !savedAt(c)) {
		const band = bandAt(c.plan, c.hz)
		const name = defaultSaveName(
			c.hz,
			channelAt(band, c.hz)?.name,
			band?.band.name,
		)
		const group = defaultGroup(band?.band.group)
		rows.push({
			id: "save",
			label: "Save frequency",
			icon: "bookmark",
			hint: group,
			steps: [
				{
					action: {
						kind: "save",
						hz: Math.round(c.hz),
						name,
						group,
						...(here ? {} : { fromBand: true }),
					},
					done: `Saved “${name}” in ${group}`,
				},
			],
		})
	}
	rows.push({
		id: "activity",
		label: "Show in Activity",
		icon: "activity",
		steps: [
			{
				action: {
					kind: "activity",
					tokens: [{ kind: "frequency", hz: c.hz }],
					label: mhz(c.hz),
				},
				done: null,
			},
		],
	})
	rows.push({
		id: "copy",
		label: "Copy frequency",
		icon: "copy",
		steps: [
			{
				action: {
					kind: "copy",
					text: formatMHz(c.hz),
					label: `Copied ${formatMHz(c.hz)}`,
				},
				done: null,
			},
		],
	})
	return rows
}

/** Decode as…: one row per protocol the core can probe, each tuning there first. */
export function decodeAsRows(c: SignalMenuContext): SignalMenuRow[] {
	const here = c.tunedHz !== null && Math.round(c.tunedHz) === Math.round(c.hz)
	const tune: SignalStep[] = here
		? []
		: [{ action: { kind: "tune", hz: c.hz }, done: null }]
	return DECODE_AS.map(p => ({
		id: `decode:${p.id}`,
		label: p.label,
		icon: "scanner",
		hint: p.by,
		steps: [
			...tune,
			{
				action: { kind: "identify", hz: c.hz, protocols: [p.id] },
				done: `Trying ${p.label} on ${mhz(c.hz)}`,
			},
		],
	}))
}

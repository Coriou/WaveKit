// Saved frequencies in the Tuner (docs/web/canvas/Tuner.dc.html "Saved"; DESIGN.md "Frequency entry": typed entry
// accepts saved names). Pure: what to save from the live state, how to recall one, and the typed-entry matches.
import type {
	DisplayGroup,
	LiveAudioConfig,
	ResolvedBandPlanView,
	SavedFrequency,
	SavedFrequencyInput,
} from "@wavekit/api-types"
import { formatMHz, formatWidth } from "../format.ts"
import { squelchForModulation } from "../listen/audio.ts"
import { channelSuggestions, type ChannelSuggestion } from "./band.ts"
import type { ParsedFrequency } from "./frequency.ts"
import { modeSpec, type Modulation } from "./modes.ts"

/** The board's group chips. Core takes any short text; these are the ones offered. */
export const SAVE_GROUPS = ["Local", "Marine", "Aviation", "Utility"] as const

/** The group a new saved frequency starts in, from the band it sits in. */
export function defaultGroup(group: DisplayGroup | null | undefined): string {
	return group === "marine" ? "Marine" : group === "air" ? "Aviation" : "Local"
}

/** The name a new saved frequency starts with: the plan channel, else the band, else "Saved 161.150". */
export function defaultSaveName(
	hz: number,
	channel: string | null | undefined,
	band: string | null | undefined,
): string {
	return channel || band || `Saved ${formatMHz(hz)}`
}

export interface SaveContext {
	hz: number
	config: LiveAudioConfig | null
	/** The band plan's mode here, used when live audio is unavailable. */
	bandMode: Modulation | null
}

/** What "Save this frequency" stores: the tuned frequency with the live mode, bandwidth and tone. */
export function saveInput(
	ctx: SaveContext,
	name: string,
	group: string | null,
): SavedFrequencyInput {
	const mode: Modulation = ctx.config?.modulation ?? ctx.bandMode ?? "nfm"
	const spec = modeSpec(mode)
	let bandwidthHz = 0
	if (mode !== "raw") {
		const live = Math.round(ctx.config?.bandwidth ?? 0)
		bandwidthHz = live > 0 ? live : (spec.bw?.[3] ?? 12_500)
	}
	const tone =
		mode === "nfm" && ctx.config?.toneSquelch
			? ctx.config.toneSquelch
			: ({ kind: "none" } as const)
	const input: SavedFrequencyInput = {
		name,
		frequencyHz: Math.round(ctx.hz),
		mode,
		bandwidthHz,
		tone,
	}
	if (group) input.group = group
	return input
}

/** "12.5 kHz" etc. without the trailing unit noise for RAW. */
function widthText(f: Pick<SavedFrequency, "mode" | "bandwidthHz">): string {
	return f.mode === "raw" ? "no filter" : formatWidth(f.bandwidthHz)
}

/** "CTCSS 77.0" / "DCS 023N", or null. */
export function toneText(tone: SavedFrequency["tone"]): string | null {
	if (tone.kind === "ctcss")
		return `CTCSS ${(tone.frequencyTenthsHz / 10).toFixed(1)}`
	if (tone.kind === "dcs")
		return `DCS ${tone.code}${tone.polarity === "inverted" ? "I" : "N"}`
	return null
}

/** The row's second line: "Marine · NFM · 25 kHz · CTCSS 77.0". */
export function savedMeta(f: SavedFrequency): string {
	return [f.group, modeSpec(f.mode).label, widthText(f), toneText(f.tone)]
		.filter(Boolean)
		.join(" · ")
}

/** "Saves 161.150 MHz · NFM · 12.5 kHz". */
export function saveSummary(input: SavedFrequencyInput): string {
	return [
		`${formatMHz(input.frequencyHz)} MHz`,
		modeSpec(input.mode).label,
		widthText(input),
		toneText(input.tone),
	]
		.filter(Boolean)
		.join(" · ")
}

function sameTone(
	a: LiveAudioConfig["toneSquelch"],
	b: SavedFrequency["tone"],
): boolean {
	return JSON.stringify(a ?? { kind: "none" }) === JSON.stringify(b)
}

/**
 * The live-audio change that recalls a saved frequency's mode, bandwidth and tone (empty when it
 * already matches). The squelch is kept valid for the new mode, as a mode change from the panel does.
 */
export function recallPatch(
	config: LiveAudioConfig | null | undefined,
	f: Pick<SavedFrequency, "mode" | "bandwidthHz" | "tone">,
): Partial<LiveAudioConfig> {
	if (!config) return {}
	const patch: Partial<LiveAudioConfig> = {}
	if (config.modulation !== f.mode) {
		Object.assign(patch, squelchForModulation(config, f.mode))
		patch.modulation = f.mode
	}
	if (
		f.mode !== "raw" &&
		f.bandwidthHz > 0 &&
		config.bandwidth !== f.bandwidthHz
	)
		patch.bandwidth = f.bandwidthHz
	if (f.mode === "nfm" && !sameTone(config.toneSquelch, f.tone))
		patch.toneSquelch = f.tone
	return patch
}

export interface RecallPorts {
	config(): LiveAudioConfig | null | undefined
	setConfig(patch: Partial<LiveAudioConfig>): Promise<unknown>
	tune(hz: number): Promise<unknown>
}

/**
 * Recalls a saved frequency: mode, bandwidth and tone first (the tuning rule keeps the channel clear of
 * the capture edge by its bandwidth), then the frequency. A refused mode change still tunes.
 */
export async function recallSaved(
	ports: RecallPorts,
	f: Pick<SavedFrequency, "frequencyHz" | "mode" | "bandwidthHz" | "tone">,
): Promise<void> {
	const patch = recallPatch(ports.config(), f)
	if (Object.keys(patch).length > 0)
		await ports.setConfig(patch).catch(() => undefined)
	await ports.tune(f.frequencyHz)
}

// ---- typed entry

export interface SavedSuggestion {
	key: string
	saved: SavedFrequency
}

function matchScore(f: SavedFrequency, q: string): number {
	const name = f.name.toLowerCase()
	const group = (f.group ?? "").toLowerCase()
	if (name === q) return 0
	if (name.startsWith(q)) return 1
	if (name.split(/[\s·/-]+/).some(w => w.startsWith(q))) return 2
	if (name.includes(q)) return 3
	if (group.startsWith(q)) return 4
	return -1
}

/**
 * Saved frequencies matching what was typed (the board's suggestions): every one for an empty entry,
 * names (then groups) for text, and MHz digit prefixes ("161", "161.9") for numbers.
 */
export function savedSuggestions(
	items: readonly SavedFrequency[],
	query: string,
	limit = 6,
): SavedSuggestion[] {
	const q = query.trim().toLowerCase().replace(/\s+/g, " ")
	const wrap = (saved: SavedFrequency): SavedSuggestion => ({
		key: `saved/${saved.id}`,
		saved,
	})
	if (!q) return items.slice(0, limit).map(wrap)
	if (/[a-z]/.test(q))
		return items
			.map(f => ({ f, score: matchScore(f, q) }))
			.filter(x => x.score >= 0)
			.sort((a, b) => a.score - b.score || a.f.frequencyHz - b.f.frequencyHz)
			.slice(0, limit)
			.map(x => wrap(x.f))
	const digits = q.replace(/[^0-9.,]/g, "").replace(",", ".")
	const bare = digits.replace(/\./g, "")
	if (bare.length < 2 || /^[+-]/.test(q)) return []
	return items
		.filter(f => formatMHz(f.frequencyHz).replace(".", "").startsWith(bare))
		.slice(0, limit)
		.map(wrap)
}

interface SuggestionRow {
	key: string
	label: string
	hz: number
	/** Group of a saved frequency, band of a channel. */
	sub: string
}

export interface SavedEntrySuggestion extends SuggestionRow {
	kind: "saved"
	saved: SavedFrequency
}

export interface ChannelEntrySuggestion extends SuggestionRow {
	kind: "channel"
	channel: ChannelSuggestion
}

export type EntrySuggestion = SavedEntrySuggestion | ChannelEntrySuggestion

/** The typed-entry list: saved frequencies first (the board's accent dot), then plan channels not already saved. */
export function entrySuggestions(
	view: ResolvedBandPlanView | null,
	saved: readonly SavedFrequency[],
	query: string,
	limit = 6,
): EntrySuggestion[] {
	const fromSaved: EntrySuggestion[] = savedSuggestions(
		saved,
		query,
		limit,
	).map(s => ({
		kind: "saved",
		key: s.key,
		label: s.saved.name,
		hz: s.saved.frequencyHz,
		sub: s.saved.group ?? "Saved",
		saved: s.saved,
	}))
	const savedHz = new Set(fromSaved.map(s => s.hz))
	const fromPlan: EntrySuggestion[] = channelSuggestions(view, query, limit)
		.filter(c => !savedHz.has(c.hz))
		.map(c => ({
			kind: "channel",
			key: c.key,
			label: c.label,
			hz: c.hz,
			sub: c.band,
			channel: c,
		}))
	return [...fromSaved, ...fromPlan].slice(0, limit)
}

export type EntryTarget =
	| { kind: "hz"; hz: number }
	| { kind: "saved"; saved: SavedFrequency }
	| { kind: "channel"; hz: number }

/**
 * What Enter does: a typed number wins unless the operator chose a suggestion with the arrows; text
 * ("ais", "harbour") takes the highlighted suggestion.
 */
export function entryTarget(
	parsed: ParsedFrequency,
	list: readonly EntrySuggestion[],
	sel: number,
	navigated: boolean,
): EntryTarget | null {
	if (parsed.kind === "ok" && !navigated) return { kind: "hz", hz: parsed.hz }
	const picked = list[sel]
	if (picked)
		return picked.kind === "saved"
			? { kind: "saved", saved: picked.saved }
			: { kind: "channel", hz: picked.hz }
	return parsed.kind === "ok" ? { kind: "hz", hz: parsed.hz } : null
}

/** The highlighted row: none while a typed number is what Enter will tune. */
export function activeSuggestion(
	parsed: ParsedFrequency,
	sel: number,
	navigated: boolean,
): number {
	return parsed.kind === "ok" && !navigated ? -1 : sel
}

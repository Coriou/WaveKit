import type { WriteIntent } from "../data/types.js"
import type { Group } from "./line.js"
import { VIEW_ORDER, type ViewId } from "./actions.js"

export type PresetName = "all" | "aircraft" | "voice" | "pager" | "data"
export const PRESET_ORDER: readonly PresetName[] = [
	"all",
	"aircraft",
	"voice",
	"pager",
	"data",
]

export type EditField =
	| "frequency"
	| "sampleRate"
	| "gain"
	| "ppm"
	| "gainMode"
	| "agc"
	| "biasTee"
	| "directSampling"
	| "offsetTuning"

export interface TunerDraft {
	frequency: number
	sampleRate: number
	/** 0.1 dB units, 0–500. */
	gainTenthsDb: number
	ppm: number
	gainMode: "manual" | "agc"
	agc: boolean
	biasTee: boolean
	directSampling: "off" | "i" | "q"
	offsetTuning: boolean
}
export interface TunerEditState {
	sourceId: string
	original: TunerDraft
	draft: TunerDraft
	field: EditField
	/** Frequency cursor: power of ten under the cursor (0 = 1 Hz digit). */
	digit: number
}

export type ConfirmKind = "decoder" | "tuner" | "control" | "preset"
export interface ConfirmRequest {
	kind: ConfirmKind
	/** Text after the ▶ glyph, e.g. "restart readsb · up 51s · pid 1531". */
	prompt: string
	yes: string
	no: string
	/** Extra clause appended to the prompt after " · ", e.g. the bias-t warning. */
	extra?: string
	intent: WriteIntent
	presetIndex?: number
	/**
	 * The prompt as priority groups (R71): when present the confirm bar fits these to
	 * the width (spec §4.2) instead of cutting `prompt · extra` at the tail.
	 */
	groups?: Group[]
}

export interface MessagesUi {
	following: boolean
	/** Newest seq visible when the feed was paused; null while following. */
	pausedAtSeq: number | null
	/** When the feed was paused (local ms); absent while following (R73, M5). */
	pausedAt?: number
	filterText: string
	/** Non-null while the filter input row is open. */
	draft: string | null
	preset: PresetName
}

export interface DetailUi {
	open: boolean
	scroll: number
}

export interface UiState {
	view: ViewId
	help: boolean
	confirm: ConfirmRequest | null
	/** Selected row id per view (decoder id, or message seq as a string). */
	selected: Record<ViewId, string | null>
	detail: Record<ViewId, DetailUi>
	messages: MessagesUi
	edit: TunerEditState | null
	/** A key notice; `ms` overrides how long it shows (default NOTICE_MS). */
	notice: { text: string; at: number; ms?: number } | null
	quit: boolean
	/** Bumped by `r` after a render error to remount the tree. */
	epoch: number
}

function perView<T>(make: () => T): Record<ViewId, T> {
	const out = {} as Record<ViewId, T>
	for (const v of VIEW_ORDER) out[v] = make()
	return out
}

export function initialUi(view: ViewId): UiState {
	return {
		view,
		help: false,
		confirm: null,
		selected: perView(() => null),
		detail: perView(() => ({ open: false, scroll: 0 })),
		messages: {
			following: true,
			pausedAtSeq: null,
			filterText: "",
			draft: null,
			preset: "all",
		},
		edit: null,
		notice: null,
		quit: false,
		epoch: 0,
	}
}

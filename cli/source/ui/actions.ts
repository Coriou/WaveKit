import type { DecoderOp } from "../data/types.js"

export type ViewId =
	| "overview"
	| "decoders"
	| "messages"
	| "receiver"
	| "system"
export const VIEW_ORDER: readonly ViewId[] = [
	"overview",
	"decoders",
	"messages",
	"receiver",
	"system",
]
export const VIEW_TITLES: Readonly<Record<ViewId, string>> = {
	overview: "Overview",
	decoders: "Decoders",
	messages: "Messages",
	receiver: "Receiver",
	system: "System",
}

export type EditKey =
	| "left"
	| "right"
	| "up"
	| "down"
	| "tab"
	| "space"
	| "backspace"
	| "0"
	| "1"
	| "2"
	| "3"
	| "4"
	| "5"
	| "6"
	| "7"
	| "8"
	| "9"

export type Action =
	| { type: "view"; view: ViewId }
	| { type: "view-step"; delta: 1 | -1 }
	| { type: "help-open" }
	| { type: "help-close" }
	| { type: "quit" }
	| { type: "reconnect" }
	| { type: "move"; delta: 1 | -1 }
	| { type: "page"; delta: 1 | -1 }
	| { type: "top" }
	| { type: "newest" }
	| { type: "open" }
	| { type: "escape" }
	| { type: "detail-scroll"; delta: 1 | -1 }
	| { type: "filter-open" }
	| { type: "filter-type"; text: string }
	| { type: "filter-backspace" }
	| { type: "filter-apply" }
	| { type: "filter-cancel" }
	| { type: "pause-toggle" }
	| { type: "preset-cycle" }
	| { type: "copy-json" }
	| { type: "decoder-op"; op: DecoderOp }
	| { type: "edit-open" }
	| { type: "edit-key"; key: EditKey }
	| { type: "edit-review" }
	| { type: "edit-discard" }
	| { type: "control-toggle" }
	| { type: "audio-toggle" }
	| { type: "preset-open" }
	| { type: "preset-next" }
	| { type: "confirm-yes" }
	| { type: "confirm-no" }
	| { type: "notice"; text: string }

/** The only actions that cause network writes (spec T9, P20). */
export function isWrite(action: Action): boolean {
	return action.type === "confirm-yes" || action.type === "audio-toggle"
}

/** Per-view facts the keymap's `when` predicates read (filled by each view's keyInfo). */
export interface ViewKeyCtx {
	hasSelection: boolean
	decoderRunning: boolean | null
	control: "internal" | "external" | null
	audioRunning: boolean | null
	paused: boolean
}

export const EMPTY_VIEW_CTX: ViewKeyCtx = {
	hasSelection: false,
	decoderRunning: null,
	control: null,
	audioRunning: null,
	paused: false,
}

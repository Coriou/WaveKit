// Single-key shortcuts (DESIGN.md "Shortcuts shown on rows"), only when no text field has the focus: `[` `]` step,
// T tune, M mode, Q squelch, B saved, S save, L listen, / search Activity, ? the shortcut list, and G then a letter
// for the views (S Spectrum, A Activity, M Map, D Messages, C Scanner, R Recordings). I (Identify) belongs to the tuned card.
import type { DrawerId, ViewId } from "../../shell/store.ts"
import type { ScopeId } from "./model.ts"

export type Shortcut =
	| { readonly kind: "scope"; readonly scope: ScopeId }
	| { readonly kind: "step"; readonly dir: 1 | -1 }
	| { readonly kind: "listen" }
	| { readonly kind: "searchActivity" }
	| { readonly kind: "view"; readonly id: ViewId }
	| { readonly kind: "drawer"; readonly id: DrawerId }
	/** G was pressed: the next key picks a view. */
	| { readonly kind: "goPrefix" }

/** How long a G waits for its letter. */
export const GO_WINDOW_MS = 1500

const GO: Readonly<Record<string, Shortcut>> = {
	s: { kind: "view", id: "spectrum" },
	m: { kind: "view", id: "map" },
	d: { kind: "view", id: "messages" },
	a: { kind: "drawer", id: "activity" },
	c: { kind: "drawer", id: "scanner" },
	r: { kind: "drawer", id: "recordings" },
}

const SINGLE: Readonly<Record<string, Shortcut>> = {
	t: { kind: "scope", scope: "tune" },
	m: { kind: "scope", scope: "mode" },
	q: { kind: "scope", scope: "sq" },
	b: { kind: "scope", scope: "saved" },
	s: { kind: "scope", scope: "save" },
	"?": { kind: "scope", scope: "keys" },
	"[": { kind: "step", dir: -1 },
	"]": { kind: "step", dir: 1 },
	l: { kind: "listen" },
	"/": { kind: "searchActivity" },
	g: { kind: "goPrefix" },
}

export interface KeyInput {
	readonly key: string
	readonly meta: boolean
	readonly ctrl: boolean
	readonly alt: boolean
	/** The focus is in a text field (input, textarea, select, contenteditable). */
	readonly typing: boolean
}

/** The shortcut for one key press; `goPending` when a G came just before. */
export function shortcutFor(e: KeyInput, goPending: boolean): Shortcut | null {
	if (e.typing || e.meta || e.ctrl || e.alt) return null
	const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
	if (goPending) return GO[k] ?? null
	return SINGLE[k] ?? null
}

/** Whether keys typed at `target` belong to a text field. */
export function isTypingTarget(target: EventTarget | null): boolean {
	const t = target as HTMLElement | null
	if (!t || typeof t.tagName !== "string") return false
	return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
}

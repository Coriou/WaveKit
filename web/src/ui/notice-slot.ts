// The notice slot under a drawer's header (docs/web/DESIGN.md, "Notices in a covering drawer"): an empty box in the
// drawer's column that the shell's notice region (src/shell/notices/NoticeRegion.tsx) fills while the drawer covers
// the free plot (a phone, or any window below 1100 px). Filled, it takes layout height and pushes the drawer body
// down, so a notice never covers the drawer's controls. Drawers register their slot element here; the kit imports
// nothing from the shell.

const slots = new Set<HTMLElement>()
const listeners = new Set<() => void>()
let version = 0

const changed = () => {
	version++
	for (const l of listeners) l()
}

/** A ref callback for a drawer's notice slot element (React 19: it returns its cleanup). */
export function noticeSlotRef(
	el: HTMLElement | null,
): (() => void) | undefined {
	if (!el) return undefined
	slots.add(el)
	changed()
	return () => {
		slots.delete(el)
		changed()
	}
}

/** The registered slots, for useSyncExternalStore (`version` changes on every add and remove). */
export const noticeSlots = {
	subscribe(l: () => void): () => void {
		listeners.add(l)
		return () => listeners.delete(l)
	},
	version: (): number => version,
	/** Every slot now, newest last. */
	all: (): HTMLElement[] => [...slots],
}

/** The slot element's class (ui.css): put it directly under the drawer's header. */
export const NOTICE_SLOT_CLASS = "wk-drawer-notices"

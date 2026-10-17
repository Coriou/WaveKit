// The tuned card's move handle (docs/web/canvas/Tuned.dc.html .wk-tc-grab, Immersive.dc.html grabCard / cardKey): wraps
// the card's type tile. Drag to move (the card follows the pointer inside the free plot area and glides to the nearest
// anchor on release, remembered per browser); Escape or a cancelled pointer puts it back; arrow keys step to the anchor
// that way. Reads the frame the shell laid out from the card-place store in context.
import {
	createContext,
	useContext,
	useEffect,
	useId,
	useRef,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react"

import { useStore } from "../data/store.ts"
import { cardPlace, type CardPlaceStore } from "./card-place.ts"
import { anchorInDirection, type CardDirection } from "./layout.ts"

/** The card-place store the shell lays the card out from (the app's one by default). */
export const CardPlaceContext = createContext<CardPlaceStore>(cardPlace)

const ARROWS: ReadonlySet<string> = new Set([
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
])

export interface CardHandleProps {
	/** The 34 px type tile; the handle gives it a 44 px hit area. */
	children: ReactNode
}

export function CardHandle({ children }: CardHandleProps) {
	const store = useContext(CardPlaceContext)
	const dragging = useStore(store, s => s.drag !== null)
	const tipId = useId()
	const stop = useRef<(() => void) | null>(null)
	useEffect(
		() => () => {
			stop.current?.()
		},
		[],
	)

	const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
		if (e.button !== 0 || !e.isPrimary) return
		stop.current?.()
		if (!store.startDrag(e.clientX, e.clientY)) return
		e.preventDefault()
		e.currentTarget.focus({ preventScroll: true })
		const id = e.pointerId
		const move = (ev: PointerEvent) => {
			if (ev.pointerId === id) store.moveDrag(ev.clientX, ev.clientY)
		}
		const up = (ev: PointerEvent) => {
			if (ev.pointerId !== id) return
			done()
			store.endDrag()
		}
		const cancel = () => {
			done()
			store.cancelDrag()
		}
		const onCancel = (ev: PointerEvent) => {
			if (ev.pointerId === id) cancel()
		}
		// capture phase: the shell's Escape (close the topmost layer) must not also run
		const esc = (ev: KeyboardEvent) => {
			if (ev.key !== "Escape") return
			ev.preventDefault()
			ev.stopPropagation()
			cancel()
		}
		const done = () => {
			window.removeEventListener("pointermove", move)
			window.removeEventListener("pointerup", up)
			window.removeEventListener("pointercancel", onCancel)
			window.removeEventListener("keydown", esc, true)
			stop.current = null
		}
		window.addEventListener("pointermove", move)
		window.addEventListener("pointerup", up)
		window.addEventListener("pointercancel", onCancel)
		window.addEventListener("keydown", esc, true)
		stop.current = cancel
	}

	const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
		if (!ARROWS.has(e.key) || e.altKey || e.metaKey || e.ctrlKey) return
		// the app's one-key shortcuts and the spectrum must not also take the arrow
		e.preventDefault()
		e.stopPropagation()
		if (store.dragging) return
		const f = store.frame
		if (!f.card) return
		const a = anchorInDirection(f.anchors, f.card, e.key as CardDirection)
		if (a) store.setAt(a.id, a.name)
	}

	return (
		<button
			type="button"
			className="wk-shell-grab"
			data-dragging={dragging || undefined}
			aria-label="Move card"
			aria-describedby={tipId}
			aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
		>
			{children}
			<span id={tipId} className="wk-tip wk-shell-grab-tip" role="tooltip">
				Drag to move · arrow keys snap
			</span>
		</button>
	)
}

/** Speaks card moves ("Card moved to top left") in a visually hidden polite live region. */
export function CardAnnouncer() {
	const store = useContext(CardPlaceContext)
	const said = useStore(store, s => s.announce)
	// a fresh node per announcement, so the same text twice is spoken twice
	return (
		<div className="wk-sr" role="status" aria-live="polite">
			{said.text && <span key={said.n}>{said.text}</span>}
		</div>
	)
}

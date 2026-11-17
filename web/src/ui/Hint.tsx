// Hints (docs/web/DESIGN.md, Hints): a small info mark after a label, one sentence behind it, and for the few
// deep concepts a learn card (the same bubble, pinned). Hover or keyboard focus shows the sentence; a click,
// Enter, Space or a tap pins it. The explained control and the mark always carry the sentence for screen
// readers (`aria-describedby` on an always-mounted `hidden` copy, out of the reading flow), open or not; a
// pinned learn card adds its rows to the mark's description. The bubble opens inside the surface that holds
// the mark, never over the row it explains.
import "./hint.css"

import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	type ReactNode,
} from "react"
import { createPortal } from "react-dom"

import { useStore } from "../data/store.ts"
import { Icon } from "./Icon.tsx"
import {
	hintBubbleEvents,
	hintMarkEvents,
	hints,
	type HintController,
} from "./hint-controller.ts"
import {
	hintLayoutChanged,
	hintRoom,
	placeHint,
	type HintRect,
} from "./hint-place.ts"

/** One hint: the sentence, and optionally the learn card shown when it is pinned. */
export interface HintContent {
	/** One sentence (two at most), see the writing rules. Plain text. */
	readonly text: string
	readonly learn?: {
		readonly rows: ReadonlyArray<{
			readonly term: string
			readonly text: ReactNode
		}>
		readonly foot?: string
	}
}

export interface HintMarkProps {
	/** The hint's id (the bubble is `<id>-bubble`). */
	readonly id: string
	/** The explained control's name: the mark is "About <label>". */
	readonly label: string
	readonly content: HintContent
	/** Id of the hidden copy of the sentence; the explained control and the mark point `aria-describedby` at it. */
	readonly describedBy: string
	/** The label text, rendered before the mark: label and mark are one hover anchor. */
	readonly children?: ReactNode
	readonly className?: string
	/** For tests: the controller (default: the app's one). */
	readonly controller?: HintController
}

/** The selector of a hint's host surface: the bubble stays inside it. */
export const HINT_HOST =
	"[data-wk-hint-host], .wk-island[data-expanded], .wk-drawer"

/** Marks the row that must stay readable while the hint is open (default: the label and its mark). */
export const hintRow: { readonly "data-wk-hint-row": "" } = Object.freeze({
	"data-wk-hint-row": "",
})

/** Wires one hint to its control: `describedBy` goes on the control, `mark` on <HintMark>. */
export function useHint(
	label: string,
	content: HintContent,
): { readonly describedBy: string; readonly mark: HintMarkProps } {
	const raw = useId()
	const id = `wk-hint-${raw.replace(/[^\w-]/g, "")}`
	const describedBy = `${id}-d`
	return { describedBy, mark: { id, label, content, describedBy } }
}

/** The info mark (and the label before it), the hidden sentence, and the bubble while it is open. */
export function HintMark({
	id,
	label,
	content,
	describedBy,
	children,
	className,
	controller = hints,
}: HintMarkProps) {
	const anchor = useRef<HTMLSpanElement>(null)
	const mark = useRef<HTMLButtonElement>(null)
	const state = useStore(controller.state)
	const open = state.open === id
	const events = hintMarkEvents(controller, id)
	const bubbleId = `${id}-bubble`
	const learnShown = open && state.pinned && content.learn !== undefined
	useEffect(() => () => controller.forget(id), [controller, id])
	return (
		<span
			ref={anchor}
			className={className ? `wk-hint-anchor ${className}` : "wk-hint-anchor"}
			onPointerEnter={e => events.onPointerEnter(e.pointerType)}
			onPointerLeave={e => events.onPointerLeave(e.pointerType)}
		>
			{children}
			<button
				ref={mark}
				type="button"
				className="wk-hint-mark"
				aria-label={`About ${label}`}
				aria-expanded={open}
				aria-controls={open ? bubbleId : undefined}
				aria-describedby={
					learnShown
						? `${describedBy} ${learnIds(bubbleId, Boolean(content.learn?.foot))}`
						: describedBy
				}
				data-wk-hint-mark={id}
				onFocus={e => events.onFocus(focusVisible(e.currentTarget))}
				onBlur={e =>
					events.onBlur(
						e.relatedTarget instanceof Node &&
							document.getElementById(bubbleId)?.contains(e.relatedTarget) ===
								true,
					)
				}
				onClick={() => events.onClick()}
			>
				<Icon name="info" size={14} />
			</button>
			<span id={describedBy} hidden>
				{content.text}
			</span>
			{open && (
				<HintBubble
					id={bubbleId}
					hintId={id}
					label={label}
					content={content}
					pinned={state.pinned}
					anchor={anchor}
					mark={mark}
					controller={controller}
				/>
			)}
		</span>
	)
}

/** The ids of a learn card's rows and foot, which the mark's description adds while it is pinned. */
const learnIds = (bubbleId: string, foot: boolean) =>
	foot ? `${bubbleId}-terms ${bubbleId}-foot` : `${bubbleId}-terms`

function focusVisible(el: Element): boolean {
	try {
		return el.matches(":focus-visible")
	} catch {
		return true
	}
}

const rectOf = (el: Element): HintRect => {
	const r = el.getBoundingClientRect()
	return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

const NO_RECT: HintRect = Object.freeze({
	left: 0,
	top: 0,
	right: 0,
	bottom: 0,
})

/** A scroll this soon after opening is the browser bringing the focused mark into view: re-place, keep open. */
const SETTLE_MS = 250

function HintBubble({
	id,
	hintId,
	label,
	content,
	pinned,
	anchor,
	mark,
	controller,
}: {
	id: string
	hintId: string
	label: string
	content: HintContent
	pinned: boolean
	anchor: { readonly current: HTMLSpanElement | null }
	mark: { readonly current: HTMLButtonElement | null }
	controller: HintController
}) {
	const bubble = useRef<HTMLDivElement>(null)
	const learn = pinned && content.learn !== undefined
	const pointer = hintBubbleEvents(controller, hintId)

	// place before paint: inside the host, above the kept row, else below it; while open, again whenever the
	// layout under it changes (another island moves or grows, the row or host resizes)
	useLayoutEffect(() => {
		const layout = () => {
			const m = mark.current
			if (!m) return null
			const keepEl = m.closest("[data-wk-hint-row]") ?? anchor.current ?? m
			const hostEl = m.closest(HINT_HOST)
			// other islands a layout lays over the host are not the host's room
			const otherEls = [...document.querySelectorAll(".wk-island")].filter(
				o => o !== hostEl && !hostEl?.contains(o) && !o.contains(m),
			)
			return { keepEl, hostEl, otherEls }
		}
		/** The rectangles the placement depends on, in a fixed order: kept row, host, other islands. */
		const rectsOf = (l: NonNullable<ReturnType<typeof layout>>) => [
			rectOf(l.keepEl),
			l.hostEl ? rectOf(l.hostEl) : NO_RECT,
			...l.otherEls.map(rectOf),
		]
		let placedOn: HintRect[] = []
		const place = () => {
			const el = bubble.current
			const l = layout()
			if (!el || !l) return
			const viewport = { width: innerWidth, height: innerHeight }
			const rects = rectsOf(l)
			placedOn = rects
			const [keep = NO_RECT, hostRect = NO_RECT, ...otherRects] = rects
			const others = otherRects.filter(
				o => o.right > o.left && o.bottom > o.top,
			)
			const host = hintRoom(
				l.hostEl
					? hostRect
					: { left: 0, top: 0, right: viewport.width, bottom: viewport.height },
				keep,
				others,
			)
			el.style.width = ""
			const max = parseFloat(getComputedStyle(el).maxWidth) || 280
			const room =
				Math.min(host.right, viewport.width) - Math.max(host.left, 0) - 24
			el.style.width = `${Math.max(120, Math.min(max, room))}px`
			const r = el.getBoundingClientRect()
			const at = placeHint({
				keep,
				host,
				viewport,
				size: { width: r.width, height: r.height },
			})
			el.style.left = `${at.x}px`
			el.style.top = `${at.y}px`
			el.dataset["side"] = at.side
		}
		place()
		const el = bubble.current
		// placing read the layout, so the closed style is computed: the fade starts from it, no frame needed
		el?.setAttribute("data-open", "")
		const opened = performance.now()
		const onScroll = (e: Event) => {
			// a scroll inside the bubble (a long card) is reading, not leaving
			if (e.target instanceof Node && el?.contains(e.target)) return
			if (performance.now() - opened < SETTLE_MS) place()
			else controller.dismiss()
		}
		const onResize = () => controller.dismiss()
		document.addEventListener("scroll", onScroll, true)
		addEventListener("resize", onResize)
		// a size change (the host, the kept row, the bubble, another island) marks the layout stale; a move by
		// transform is invisible to ResizeObserver, so each frame also compares the rectangles placed against
		let stale = false
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(() => {
						stale = true
					})
		const l = layout()
		if (observer && l) {
			observer.observe(l.keepEl)
			if (l.hostEl) observer.observe(l.hostEl)
			if (el) observer.observe(el)
			for (const o of l.otherEls) observer.observe(o)
		}
		let frame: number | null = null
		const watch = () => {
			frame = null
			const now = layout()
			if (stale || (now && hintLayoutChanged(placedOn, rectsOf(now)))) {
				stale = false
				place()
			}
			frame = requestAnimationFrame(watch)
		}
		if (typeof requestAnimationFrame !== "undefined")
			frame = requestAnimationFrame(watch)
		return () => {
			document.removeEventListener("scroll", onScroll, true)
			removeEventListener("resize", onResize)
			observer?.disconnect()
			if (frame !== null) cancelAnimationFrame(frame)
		}
	}, [anchor, mark, controller, learn])

	// a click or tap elsewhere closes it (and still does its own job); Escape closes the hint only
	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			const t = e.target
			if (!(t instanceof Node)) return
			if (anchor.current?.contains(t) || bubble.current?.contains(t)) return
			controller.dismiss()
		}
		const events = hintMarkEvents(controller, hintId)
		const onKey = (e: KeyboardEvent) => {
			if (!events.onKeyDown(e.key)) return
			e.preventDefault()
			e.stopPropagation()
		}
		document.addEventListener("pointerdown", onDown, true)
		addEventListener("keydown", onKey, true)
		return () => {
			document.removeEventListener("pointerdown", onDown, true)
			removeEventListener("keydown", onKey, true)
		}
	}, [anchor, controller, hintId])

	const body = (
		<div
			ref={bubble}
			id={id}
			className="wk-hint"
			role={learn ? "group" : "tooltip"}
			aria-label={learn ? `About ${label}` : undefined}
			data-learn={learn || undefined}
			data-wk-hint-bubble={hintId}
			onPointerEnter={e => pointer.onPointerEnter(e.pointerType)}
			// focus that went from the mark to More and leaves again: the hint closes once it is out of both
			onBlur={e => {
				const to = e.relatedTarget
				pointer.onBlur(
					to instanceof Node &&
						(bubble.current?.contains(to) === true ||
							mark.current?.contains(to) === true),
				)
			}}
			onPointerLeave={e =>
				pointer.onPointerLeave(
					e.pointerType,
					// back onto the mark or its label: React treats the portalled bubble as the anchor's child, so
					// the anchor sees no enter, and leaving here must not start the close
					e.relatedTarget instanceof Node &&
						anchor.current?.contains(e.relatedTarget) === true,
				)
			}
		>
			{learn && content.learn ? (
				<>
					<p className="wk-hint-lead">{content.text}</p>
					<dl className="wk-hint-terms" id={`${id}-terms`}>
						{content.learn.rows.map(row => (
							<div key={row.term}>
								<dt>{row.term}</dt>
								<dd>{row.text}</dd>
							</div>
						))}
					</dl>
					{content.learn.foot && (
						<p className="wk-hint-foot" id={`${id}-foot`}>
							{content.learn.foot}
						</p>
					)}
				</>
			) : (
				<p>
					{content.text}
					{content.learn && (
						<button
							type="button"
							className="wk-hint-more"
							tabIndex={-1}
							// keep focus where it is (a mark keyboard focus opened): a browser that does not focus
							// buttons on a click would otherwise blur the mark, and the hint, before the click
							onMouseDown={e => e.preventDefault()}
							onClick={() => controller.press(hintId)}
						>
							More
						</button>
					)}
				</p>
			)}
		</div>
	)
	return typeof document === "undefined"
		? body
		: createPortal(body, document.body)
}

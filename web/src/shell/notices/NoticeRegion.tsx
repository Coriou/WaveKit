// The notice region (./service.ts): top centre of the free plot area (`--wk-free-cx`), 8 px under the top island
// row and under anything already at the top centre (./top-centre.ts). At most one condition toast, then one
// receipt. It never takes focus; hovering it or focusing inside a toast pauses both timers (until that toast goes).
import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { useStore } from "../../data/store.ts"
import { Icon } from "../../ui/Icon.tsx"
import {
	notices,
	type NoticeService,
	type Receipt,
	type ShownCondition,
} from "./service.ts"
import {
	REGION_MAX_W,
	TOP_CENTRE_SELECTOR,
	regionTop,
	type Box,
} from "./top-centre.ts"

/** How often the region re-reads what sits at the top centre while it shows something (ms). */
const MEASURE_MS = 500

export interface NoticeRegionProps {
	/** Bottom of the top island row (the shell layout's top row, its gutter excluded). */
	readonly topRowBottom: number
	/** The ⌘K palette is open: the region hides and its timers wait. */
	readonly palette: boolean
	/** The Receiver panel is open: it lists the link conditions, so no floating link toast. */
	readonly receiverOpen: boolean
	readonly service?: NoticeService
}

export function NoticeRegion({
	topRowBottom,
	palette,
	receiverOpen,
	service = notices,
}: NoticeRegionProps) {
	const shown = useStore(service.shown)
	const receipt = useStore(service.receipt)
	const box = useRef<HTMLDivElement | null>(null)
	const [top, setTop] = useState(topRowBottom + 8)

	useEffect(() => {
		service.setPaused("palette", palette)
		// the region unmounting never leaves its palette pause behind
		return () => service.setPaused("palette", false)
	}, [service, palette])
	useEffect(
		() => service.setLinkToastsHidden(receiverOpen),
		[service, receiverOpen],
	)
	const occupied = shown !== null || receipt !== null
	// the region going away (palette, or its last toast closed under the pointer: no pointerleave or blur then)
	// never leaves a hover or focus pause behind
	useEffect(() => {
		if (palette || !occupied) {
			service.setPaused("hover", false)
			service.setFocusedToast(null)
		}
	}, [service, palette, occupied])
	useLayoutEffect(() => {
		const measure = () => {
			// shell coordinates: the region is placed in the shell root
			const root = box.current?.parentElement
			const r = root?.getBoundingClientRect() ?? { left: 0, top: 0 }
			const cx = root ? freeCentre(root) : window.innerWidth / 2
			const boxes: Box[] = [...document.querySelectorAll(TOP_CENTRE_SELECTOR)]
				.filter(el => !box.current?.contains(el))
				.map(el => {
					const b = el.getBoundingClientRect()
					return {
						top: b.top - r.top,
						bottom: b.bottom - r.top,
						left: b.left - r.left,
						right: b.right - r.left,
					}
				})
			const next = regionTop(topRowBottom, boxes, cx, REGION_MAX_W)
			setTop(t => (t === next ? t : next))
		}
		measure()
		if (!occupied) return
		const id = setInterval(measure, MEASURE_MS)
		return () => clearInterval(id)
	}, [topRowBottom, occupied])

	if (palette || !occupied) return null
	return (
		<div
			ref={box}
			className="wk-notices"
			data-wk-notice-region=""
			style={{ top }}
			onPointerEnter={() => service.setPaused("hover", true)}
			onPointerLeave={() => service.setPaused("hover", false)}
			onBlur={e => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null))
					service.setFocusedToast(null)
			}}
		>
			{/* a new element per toast, so a fresh one is announced and animates in */}
			{shown && (
				<ConditionToast key={shown.id} shown={shown} service={service} />
			)}
			{receipt && (
				<ReceiptToast key={receipt.id} receipt={receipt} service={service} />
			)}
		</div>
	)
}

/** The free plot's centre in shell px: `--wk-free-cx` on the shell root, else its middle. */
function freeCentre(root: HTMLElement): number {
	const v = parseFloat(getComputedStyle(root).getPropertyValue("--wk-free-cx"))
	return Number.isFinite(v) ? v : root.clientWidth / 2
}

// Each toast owns the focus pause it starts: it ends when that toast goes, even with no blur (a focused ✕ or
// Undo unmounting fires none in Chrome).
function ConditionToast({
	shown,
	service,
}: {
	shown: ShownCondition
	service: NoticeService
}) {
	return (
		<div
			role="status"
			className="wk-toast wk-notice"
			data-class="condition"
			data-key={shown.key}
			data-tone={shown.tone}
			onFocus={() => service.setFocusedToast(shown.id)}
		>
			{shown.tone === "warn" && <WarnGlyph />}
			<span className="wk-notice-text">{shown.text}</span>
			{shown.action && (
				<button
					type="button"
					className="wk-btn"
					data-variant="tonal"
					data-size="sm"
					onClick={() => service.runShownAction()}
				>
					{shown.action.label}
				</button>
			)}
			<button
				type="button"
				className="wk-icon-btn"
				data-size="sm"
				aria-label="Dismiss"
				onClick={() => service.dismissShown()}
			>
				<Icon name="close" size={14} />
			</button>
		</div>
	)
}

function ReceiptToast({
	receipt,
	service,
}: {
	receipt: Receipt
	service: NoticeService
}) {
	const button = receipt.action !== undefined || receipt.undo !== undefined
	return (
		<div
			role="status"
			className="wk-toast wk-notice"
			data-class="receipt"
			data-tone={receipt.tone}
			onFocus={() => service.setFocusedToast(receipt.id)}
		>
			{receipt.tone === "warn" && <WarnGlyph />}
			<span className="wk-notice-text">{receipt.text}</span>
			{button ? (
				<button
					type="button"
					className="wk-btn"
					data-variant="tonal"
					data-size="sm"
					onClick={() => {
						if (receipt.action) receipt.action.run()
						else receipt.undo?.()
						service.dismissReceipt()
					}}
				>
					{receipt.action?.label ?? "Undo"}
				</button>
			) : (
				<button
					type="button"
					className="wk-icon-btn"
					data-size="sm"
					aria-label="Dismiss"
					onClick={() => service.dismissReceipt()}
				>
					<Icon name="close" size={14} />
				</button>
			)}
		</div>
	)
}

/** A warning triangle: a warn notice reads by shape and words, not by colour alone. */
export function WarnGlyph({ size = 16 }: { size?: number }) {
	return (
		<svg
			className="wk-notice-glyph"
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M8 2.2 14.4 13.5H1.6Z" />
			<path d="M8 6.5v3.2M8 11.6v.1" />
		</svg>
	)
}

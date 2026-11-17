// The notice region (./service.ts): top centre of the free plot area (`--wk-free-cx`), 8 px under the top island
// row and under anything already at the top centre; while Activity is expanded (no free plot), the widest empty
// gap of the top row, else of the drawer's header (./top-centre.ts `regionPlacement`); while a drawer covers that place
// (a phone, or below 1100 px), portalled into the drawer's notice slot under its header (ui/notice-slot.ts), which
// pushes the drawer body down. At most one condition toast, then one receipt. It never takes focus; hovering it or focusing inside a toast pauses both timers (until that toast goes).
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from "react"
import { createPortal } from "react-dom"

import { useStore } from "../../data/store.ts"
import { Icon } from "../../ui/Icon.tsx"
import { noticeSlots } from "../../ui/notice-slot.ts"
import {
	notices,
	type NoticeService,
	type Receipt,
	type ShownCondition,
} from "./service.ts"
import {
	TOP_CENTRE_SELECTOR,
	regionPlacement,
	type Box,
	type ExpandedDrawer,
	type Placement,
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
	// the shell root: the region's own parent while it floats, found again while it sits in a drawer's slot
	const home = useRef<HTMLElement | null>(null)
	const slotVersion = useSyncExternalStore(
		noticeSlots.subscribe,
		noticeSlots.version,
		noticeSlots.version,
	)
	const [slot, setSlot] = useState<HTMLElement | null>(null)
	const [place, setPlace] = useState<Placement>({
		where: "free-plot",
		cx: 0,
		maxW: 0,
		top: topRowBottom + 8,
	})

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
			const el = box.current
			if (el && !el.parentElement?.classList.contains("wk-drawer-notices"))
				home.current = el.parentElement
			const root = home.current?.isConnected ? home.current : null
			const r = root?.getBoundingClientRect() ?? { left: 0, top: 0 }
			const cx = root ? freeCentre(root) : window.innerWidth / 2
			const inShell = (el: Element): Box => {
				const b = el.getBoundingClientRect()
				return {
					top: b.top - r.top,
					bottom: b.bottom - r.top,
					left: b.left - r.left,
					right: b.right - r.left,
				}
			}
			const boxes: Box[] = [...document.querySelectorAll(TOP_CENTRE_SELECTOR)]
				.filter(el => !box.current?.contains(el))
				.map(inShell)
			const drawer = root?.querySelector(".wk-shell-drawer") ?? null
			// the open drawer's slot: the newest connected one inside it (a loading skeleton's slot is replaced)
			const drawerSlot =
				(drawer &&
					noticeSlots
						.all()
						.filter(s => s.isConnected && drawer.contains(s))
						.at(-1)) ??
				null
			const next = regionPlacement({
				W: root?.clientWidth ?? window.innerWidth,
				topRowBottom,
				freeCx: cx,
				boxes,
				expanded: root ? expandedDrawer(root, inShell) : null,
				drawer: drawer ? inShell(drawer) : null,
				slot: drawerSlot !== null,
				height: box.current?.offsetHeight ?? 0,
			})
			setPlace(p => (samePlace(p, next) ? p : next))
			setSlot(drawerSlot)
		}
		measure()
		if (!occupied) return
		const id = setInterval(measure, MEASURE_MS)
		window.addEventListener("resize", measure)
		return () => {
			clearInterval(id)
			window.removeEventListener("resize", measure)
		}
	}, [topRowBottom, occupied, slotVersion])
	// moving between the plot and a drawer's slot remounts the toasts: no pointerleave or blur comes then, so the
	// hover and focus pauses never stay behind
	const docked = place.where === "drawer-slot" && slot !== null
	useEffect(() => {
		service.setPaused("hover", false)
		service.setFocusedToast(null)
	}, [service, docked])

	if (palette || !occupied) return null
	const region: ReactNode = (
		<div
			ref={box}
			className="wk-notices"
			data-wk-notice-region=""
			data-where={place.where}
			// the free plot's top centre comes from shell.css (`--wk-free-cx`); elsewhere the measured room
			// in a drawer's slot the drawer lays it out (shell.css)
			style={
				docked
					? undefined
					: place.where === "free-plot" || place.where === "drawer-slot"
						? { top: place.top }
						: { top: place.top, left: place.cx, maxWidth: place.maxW }
			}
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
	return docked ? createPortal(region, slot) : region
}

const samePlace = (a: Placement, b: Placement) =>
	a.where === b.where && a.cx === b.cx && a.maxW === b.maxW && a.top === b.top

/** The expanded Activity drawer's row and header (shell px), or null while Activity is not expanded. */
function expandedDrawer(
	root: HTMLElement,
	inShell: (el: Element) => Box,
): ExpandedDrawer | null {
	const drawer = root.querySelector(".wk-shell-drawer[data-expanded]")
	if (!drawer) return null
	const header = drawer.querySelector(".wk-drawer-head")
	return {
		drawer: inShell(drawer),
		topRow: [
			...root.querySelectorAll(
				'.wk-shell-island[data-island="tuner"], .wk-shell-island[data-island="receiver"]',
			),
		].map(inShell),
		header: header ? inShell(header) : null,
		headerControls: header
			? [...header.children]
					.filter(el => !el.classList.contains("wk-drawer-gap"))
					.map(inShell)
			: [],
	}
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

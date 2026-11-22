// The notice region (./service.ts): at most one condition toast, then one receipt, each a status item of the shell
// layout (../layout/compute.ts, "Status slot"). Each toast reports its forms (its natural one-line width, then a
// compact line and an icon for a condition) and takes the rectangle and form the layout gives it: in the top rail's
// slot (the condition against the Receiver, the receipt against the Tuner, nothing slides), in the strip under the
// top rail on a phone, or docked in a covering drawer's notice slot under its header (ui/notice-slot.ts), which
// pushes the drawer body down. It never takes focus, except to give a moved toast's button back the focus it had;
// hovering a toast or focusing inside one pauses both timers (until that toast goes). A toast the layout places
// nowhere (waiting for room, not placed yet, held while the tuned card glides past, or yielded under an open panel)
// is unseen: its own timer waits until it shows (service `setUnseen`) and goes on with the time it had left. One
// predicate of the layout (`statusState`) decides the toast's render, its `inert`, its focus and its timer.
import {
	useEffect,
	useLayoutEffect,
	useRef,
	type HTMLAttributes,
	type ReactNode,
} from "react"
import { createPortal } from "react-dom"

import { useStore, type Store } from "../../data/store.ts"
import { Icon } from "../../ui/Icon.tsx"
import {
	statusSeen,
	statusState,
	type Layout,
	type StatusForm,
	type StatusItem,
	type StatusPlaced,
	type StatusState,
} from "../layout/compute.ts"
import { naturalRowWidth, slotAttrs, topLeft } from "../layout/slot.ts"
import {
	dockedSlot as defaultDockedSlot,
	statusReports as defaultReports,
	type StatusReports,
} from "../layout/stores.ts"
import {
	notices,
	type NoticeService,
	type Receipt,
	type ShownCondition,
} from "./service.ts"

/** A toast's height: one touch row (ui.css `.wk-toast`). */
export const TOAST_H = 44
/** The condition's compact line ("Samples lost…" beside its ✕) and its glyph alone. */
export const CONDITION_COMPACT_W = 168
export const CONDITION_ICON_W = 44

export interface NoticeRegionProps {
	/** Where the shell layout put the status items. */
	readonly status: Layout["status"]
	/** Slots the layout holds out of sight while the tuned card glides through them ("status:<id>"). */
	readonly held?: readonly string[]
	/** Slots out of sight under an open panel's room (the layout's `yielded`, "status:<id>" among them). */
	readonly yielded?: Layout["yielded"]
	/** The ⌘K palette is open: the region hides and its timers wait. */
	readonly palette: boolean
	/** The Receiver panel is open: it lists the link conditions, so no floating link toast. */
	readonly receiverOpen: boolean
	readonly service?: NoticeService
	readonly reports?: StatusReports
	readonly docked?: Store<HTMLElement | null>
}

/** The status item a toast reports, from its natural width. */
export function toastItem(
	id: "condition" | "receipt",
	naturalW: number,
): StatusItem {
	const full = { w: naturalW, h: TOAST_H }
	return id === "condition"
		? {
				id,
				kind: "condition",
				forms: {
					full,
					compact: { w: Math.min(naturalW, CONDITION_COMPACT_W), h: TOAST_H },
					icon: { w: CONDITION_ICON_W, h: TOAST_H },
				},
			}
		: { id, kind: "receipt", forms: { full } }
}

export function NoticeRegion({
	status,
	held = [],
	yielded = [],
	palette,
	receiverOpen,
	service = notices,
	reports = defaultReports,
	docked: dockedStore = defaultDockedSlot,
}: NoticeRegionProps) {
	const shown = useStore(service.shown)
	const receipt = useStore(service.receipt)
	const slot = useStore(dockedStore)
	const box = useRef<HTMLDivElement | null>(null)
	// the toast control last focused inside the region (until the focus leaves it): restored when a move remounts it
	const lastFocus = useRef<{ id: string; control: string } | null>(null)
	// each toast's natural one-line width, measured while it shows in its full form
	const natural = useRef(new Map<string, { content: string; w: number }>())

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
	const visible = occupied && !palette
	// the region going away (palette, or its last toast closed under the pointer: no pointerleave or blur then)
	// never leaves a hover or focus pause behind
	useEffect(() => {
		if (palette || !occupied) {
			service.setPaused("hover", false)
			service.setFocusedToast(null)
		}
	}, [service, palette, occupied])

	// report each toast's forms; withdraw what no longer shows
	const conditionKey = shown
		? `${shown.id}|${shown.text}|${shown.action?.label ?? ""}`
		: null
	const receiptKey = receipt
		? `${receipt.id}|${receipt.text}|${receipt.action?.label ?? (receipt.undo ? "undo" : "")}`
		: null
	useLayoutEffect(() => {
		const report = (id: "condition" | "receipt", key: string | null) => {
			if (key === null || !visible) {
				reports.withdraw(id)
				natural.current.delete(id)
				return
			}
			const el = box.current?.querySelector<HTMLElement>(
				`[data-wk-slot="status:${id}"]`,
			)
			const had = natural.current.get(id)
			// measured in its full form only (a compact or icon form hides some of its parts)
			if (el && (el.dataset["form"] ?? "full") === "full") {
				const w = naturalRowWidth(el)
				if (!had || had.content !== key || Math.abs(had.w - w) > 1)
					natural.current.set(id, { content: key, w })
			}
			const n = natural.current.get(id)
			if (n && n.content === key) reports.report(toastItem(id, n.w))
		}
		report("condition", conditionKey)
		report("receipt", receiptKey)
	})
	useEffect(
		() => () => {
			reports.withdraw("condition")
			reports.withdraw("receipt")
		},
		[reports],
	)

	const docked = status.where === "drawer-slot" && slot !== null
	// a toast's timer runs only while the reader can see it and reach its controls (LY rules §1.2): placed and not
	// held or yielded, or docked in a shown host whose notice slot exists
	const stateOf = (id: "condition" | "receipt"): StatusState =>
		visible
			? statusState({ status, held, yielded }, id, slot !== null)
			: "absent"
	const receiptState = stateOf("receipt")
	const conditionState = stateOf("condition")
	const receiptSeen = statusSeen(receiptState)
	const conditionSeen = statusSeen(conditionState)
	useLayoutEffect(() => {
		service.setUnseen("receipt", !receiptSeen)
		service.setUnseen("condition", !conditionSeen)
	}, [service, receiptSeen, conditionSeen])
	useEffect(
		() => () => {
			service.setUnseen("receipt", false)
			service.setUnseen("condition", false)
		},
		[service],
	)
	// moving between the rail and a drawer's slot remounts the toasts: no pointerleave or blur comes then, so the
	// hover pause never stays behind; a toast button that had the focus gets it back on its new element (same
	// toast, same control), so the focus pause stays only then
	useLayoutEffect(() => {
		service.setPaused("hover", false)
		const f = lastFocus.current
		const active = document.activeElement
		const lost = active === null || active === document.body
		const el =
			f && lost
				? box.current?.querySelector(
						`[data-toast-id="${f.id}"] [data-control="${f.control}"]`,
					)
				: null
		if (el instanceof HTMLElement) {
			el.focus({ preventScroll: true })
			service.setFocusedToast(Number(f?.id))
		} else service.setFocusedToast(null)
	}, [service, docked])

	if (!visible) return null
	const placed = new Map<string, StatusPlaced>(status.items.map(i => [i.id, i]))
	const at = (id: string) => (docked ? null : (placed.get(id) ?? null))
	const region: ReactNode = (
		<div
			ref={box}
			className={docked ? "wk-notices" : "wk-status-layer"}
			data-wk-notice-region=""
			data-where={docked ? "drawer-slot" : status.where}
			onFocus={e => {
				const control = e.target.closest("[data-control]")
				const toast = e.target.closest("[data-toast-id]")
				const id = toast?.getAttribute("data-toast-id")
				const name = control?.getAttribute("data-control")
				lastFocus.current = id && name ? { id, control: name } : null
			}}
			onBlur={e => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
					lastFocus.current = null
					service.setFocusedToast(null)
				}
			}}
		>
			{/* a new element per toast, so a fresh one is announced and animates in */}
			{shown && (
				<ConditionToast
					key={shown.id}
					shown={shown}
					service={service}
					place={at("condition")}
					docked={docked}
					state={conditionState}
				/>
			)}
			{receipt && (
				<ReceiptToast
					key={receipt.id}
					receipt={receipt}
					service={service}
					place={at("receipt")}
					docked={docked}
					state={receiptState}
				/>
			)}
		</div>
	)
	return docked ? createPortal(region, slot) : region
}

/** A toast's slot: its rectangle and form from the layout, or measured out of sight until it has one. Its state
 * (`statusState`) is on the element; a toast the reader cannot see is `inert` (out of the focus order). */
function placement(
	id: "condition" | "receipt",
	place: StatusPlaced | null,
	docked: boolean,
	service: NoticeService,
	state: StatusState,
): HTMLAttributes<HTMLDivElement> & {
	readonly [data: `data-${string}`]: string | number | undefined
} {
	const hover = {
		onPointerEnter: () => service.setPaused("hover", true),
		onPointerLeave: () => service.setPaused("hover", false),
	}
	const vis = {
		"data-wk-state": state,
		"data-yielded": state === "yielded" ? "" : undefined,
		inert: !statusSeen(state),
	}
	if (docked) return { ...slotAttrs(`status:${id}`, null), ...vis, ...hover }
	const form: StatusForm = place?.form ?? "full"
	return {
		...slotAttrs(`status:${id}`, place),
		...vis,
		"data-form": form,
		"data-lines": place?.lines ?? 1,
		"data-pending": place ? undefined : "",
		"data-held": state === "held" ? "" : undefined,
		style: place
			? topLeft(place, true)
			: { left: 0, top: 0, width: "max-content", height: TOAST_H },
		...hover,
	}
}

// Each toast owns the focus pause it starts: it ends when that toast goes, even with no blur (a focused ✕ or
// Undo unmounting fires none in Chrome).
function ConditionToast({
	shown,
	service,
	place,
	docked,
	state,
}: {
	shown: ShownCondition
	service: NoticeService
	place: StatusPlaced | null
	docked: boolean
	state: StatusState
}) {
	return (
		<div
			role="status"
			className="wk-toast wk-notice"
			data-class="condition"
			data-toast-id={shown.id}
			data-key={shown.key}
			data-tone={shown.tone}
			title={place && place.form !== "full" ? shown.text : undefined}
			{...placement("condition", place, docked, service, state)}
			onFocus={() => service.setFocusedToast(shown.id)}
		>
			{shown.tone === "warn" && <WarnGlyph />}
			<span className="wk-notice-text" data-measure-text="">
				{shown.text}
			</span>
			{shown.action && (
				<button
					type="button"
					className="wk-btn"
					data-variant="tonal"
					data-size="sm"
					data-control="action"
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
				data-control="dismiss"
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
	place,
	docked,
	state,
}: {
	receipt: Receipt
	service: NoticeService
	place: StatusPlaced | null
	docked: boolean
	state: StatusState
}) {
	const button = receipt.action !== undefined || receipt.undo !== undefined
	return (
		<div
			role="status"
			className="wk-toast wk-notice"
			data-class="receipt"
			data-toast-id={receipt.id}
			data-tone={receipt.tone}
			title={place && place.lines === 2 ? receipt.text : undefined}
			{...placement("receipt", place, docked, service, state)}
			onFocus={() => service.setFocusedToast(receipt.id)}
		>
			{receipt.tone === "warn" && <WarnGlyph />}
			<span className="wk-notice-text" data-measure-text="">
				{receipt.text}
			</span>
			{button ? (
				<button
					type="button"
					className="wk-btn"
					data-variant="tonal"
					data-size="sm"
					data-control={receipt.action ? "action" : "undo"}
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
					data-control="dismiss"
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

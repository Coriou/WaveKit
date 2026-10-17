// The Immersive shell (docs/web/DESIGN.md, "Shell: direction C"): a full-bleed plot with floating glass islands.
// Tuner top-left, Receiver top-right, Listen bottom-left, the nav dock bottom-centre, the tuned card above Listen and
// the right drawer. One island panel open at a time; Escape closes the topmost layer and returns focus to its trigger.
// Glass budget: the three island heads, the dock, the card and one open panel (6); drawers and the palette are solid.
import "../styles/shell.css"

import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type ComponentType,
	type CSSProperties,
	type ReactNode,
	type Ref,
} from "react"

import { useStore } from "../data/store.ts"
import { CardAnnouncer, CardPlaceContext } from "./CardHandle.tsx"
import {
	cardPlace as defaultCardPlace,
	type CardPlaceStore,
} from "./card-place.ts"
import { Drawer } from "../ui/Drawer.tsx"
import { Icon } from "../ui/Icon.tsx"
import type { DrawerContentProps } from "./drawers/types.ts"
import { useShell } from "./hooks.ts"
import {
	CARD_W,
	DEFAULT_GEOMETRY,
	nearestAnchor,
	shellLayout,
	type CardAnchor,
	type Point,
	type ShellGeometry,
} from "./layout.ts"
import { ShellIsland, type IslandSlot } from "./ShellIsland.tsx"
import { Dock } from "./Dock.tsx"
import { PaneSlot } from "./PaneSlot.tsx"
import { DRAWER_PANES, paneOf } from "./panes.ts"
import { appToast, dismissAppToast } from "./toast.ts"
import {
	shellStore,
	type Closed,
	type DrawerId,
	type IslandId,
	type ShellStore,
} from "./store.ts"

// Drawers, the Map view and the palette are code-split: the first paint is the plot and the islands.
const DRAWER_CONTENT: Readonly<
	Record<DrawerId, ComponentType<DrawerContentProps>>
> = {
	activity: lazy(() => import("./drawers/ActivityDrawer.tsx")),
	scanner: lazy(() => import("./drawers/ScannerDrawer.tsx")),
	recordings: lazy(() => import("./drawers/RecordingsDrawer.tsx")),
	settings: lazy(() => import("./drawers/SettingsDrawer.tsx")),
}
const DRAWER_TITLE: Readonly<Record<DrawerId, string>> = {
	activity: "Activity",
	scanner: "Scanner",
	recordings: "Recordings",
	settings: "Settings",
}
const MapView = lazy(() => import("./drawers/MapView.tsx"))
const Palette = lazy(() => import("./drawers/Palette.tsx"))

export interface ShellProps {
	/** Full-bleed plot (spectrum + waterfall). Defaults to an empty plot background. */
	plot?: ReactNode
	tuner: IslandSlot
	receiver: IslandSlot
	listen: IslandSlot
	/** The tuned card's content (a floating Island), shown on its anchor (above Listen by default) on wide windows.
	 * Its type tile goes in a CardHandle to make it movable. */
	card?: ReactNode
	store?: ShellStore
	/** Where the tuned card sits (wanted anchor, remembered per browser, and the live drag). */
	cardStore?: CardPlaceStore
}

const keyOf = (c: Closed): string =>
	c.kind === "palette" ? "palette" : `${c.kind}:${c.id}`

function sameGeometry(a: ShellGeometry, b: ShellGeometry): boolean {
	return (
		a.W === b.W &&
		a.H === b.H &&
		a.tuner.w === b.tuner.w &&
		a.tuner.h === b.tuner.h &&
		a.rx.w === b.rx.w &&
		a.rx.h === b.rx.h &&
		a.listen.w === b.listen.w &&
		a.listen.h === b.listen.h &&
		a.listenLiveH === b.listenLiveH &&
		a.listenLiveW === b.listenLiveW &&
		a.tunerLive.w === b.tunerLive.w &&
		a.tunerLive.h === b.tunerLive.h &&
		a.rxLive.w === b.rxLive.w &&
		a.rxLive.h === b.rxLive.h &&
		a.dockW === b.dockW &&
		a.cardH === b.cardH
	)
}

export function Shell({
	plot,
	tuner,
	receiver,
	listen,
	card,
	store = shellStore,
	cardStore = defaultCardPlace,
}: ShellProps) {
	const state = useShell(store)
	// the shell re-renders when the wanted anchor changes or a drag starts or ends, never on pointer moves
	const cardAt = useStore(cardStore, s => s.at)
	const dragging = useStore(cardStore, s => s.drag !== null)

	// ---- focus return: each panel, drawer and the palette remembers the control that opens it
	const triggers = useRef(new Map<string, HTMLElement>())
	const refCache = useRef(new Map<string, Ref<HTMLButtonElement>>())
	const triggerRef = useCallback((key: string): Ref<HTMLButtonElement> => {
		let r = refCache.current.get(key)
		if (!r) {
			r = (el: HTMLButtonElement | null) => {
				if (el) triggers.current.set(key, el)
				else triggers.current.delete(key)
			}
			refCache.current.set(key, r)
		}
		return r
	}, [])
	const refocus = useCallback(
		(key: string) => triggers.current.get(key)?.focus(),
		[],
	)

	// ---- geometry: measured island sizes feed the board's grid
	const root = useRef<HTMLDivElement>(null)
	const els = useRef<Record<string, HTMLElement | null>>({})
	const elRef = useCallback(
		(k: string) => (el: HTMLElement | null) => void (els.current[k] = el),
		[],
	)
	const refs = useRef({
		tunerHead: elRef("tunerHead"),
		tunerBox: elRef("tunerBox"),
		rxHead: elRef("rxHead"),
		rxBox: elRef("rxBox"),
		listenHead: elRef("listenHead"),
		listenBox: elRef("listenBox"),
		dock: elRef("dock"),
		card: elRef("card"),
	}).current
	const [geo, setGeo] = useState<ShellGeometry>(DEFAULT_GEOMETRY)
	const measure = useCallback(() => {
		const e = els.current
		const r = root.current
		if (!r) return
		const sz = (
			el: HTMLElement | null | undefined,
			d: { w: number; h: number },
		) =>
			el && el.offsetWidth && el.offsetHeight
				? { w: el.offsetWidth, h: el.offsetHeight }
				: d
		setGeo(prev => {
			const tunerHead = sz(e["tunerHead"], DEFAULT_GEOMETRY.tuner)
			const rxHead = sz(e["rxHead"], DEFAULT_GEOMETRY.rx)
			const listenHead = sz(e["listenHead"], DEFAULT_GEOMETRY.listen)
			const next: ShellGeometry = {
				W: r.clientWidth,
				H: r.clientHeight,
				tuner: tunerHead,
				rx: rxHead,
				listen: listenHead,
				listenLiveH:
					e["listenBox"]?.offsetHeight || DEFAULT_GEOMETRY.listenLiveH,
				listenLiveW: e["listenBox"]?.offsetWidth || listenHead.w,
				// live sizes, open panel included: the card keeps clear of these
				tunerLive: sz(e["tunerBox"], tunerHead),
				rxLive: sz(e["rxBox"], rxHead),
				dockW: e["dock"]?.offsetWidth ?? 0,
				// a hidden card keeps its last height: falling back to the default would show it again when it is
				// taller than the default, and the card would flip between shown and hidden
				cardH: e["card"]?.offsetHeight || prev.cardH,
			}
			return sameGeometry(prev, next) ? prev : next
		})
	}, [])
	// the open drawer's attached pane (src/shell/panes.ts): wanted now, attached when the layout has room for it
	const paneDecl = paneOf(state.drawer)
	const paneWanted = useSyncExternalStore(
		paneDecl.subscribe,
		paneDecl.wanted,
		paneDecl.wanted,
	)
	const pane = paneDecl.pane
	const L = shellLayout(
		geo,
		state.drawer,
		pane ? { want: paneWanted, pushIn: pane.pushIn } : null,
		{ at: cardAt, rxOpen: state.panel === "receiver" },
	)
	// the card's handle reads this frame on pointer and key events
	useLayoutEffect(() => {
		cardStore.frame = {
			anchors: L.anchors,
			card: L.card,
			freeW: L.freeW,
			H: geo.H,
			cardH: geo.cardH,
		}
		if (!L.card && cardStore.dragging) cardStore.cancelDrag()
	})
	useLayoutEffect(() => {
		measure()
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", measure)
			return () => window.removeEventListener("resize", measure)
		}
		const ro = new ResizeObserver(measure)
		if (root.current) ro.observe(root.current)
		for (const el of Object.values(els.current)) if (el) ro.observe(el)
		return () => ro.disconnect()
		// re-observe when slots mount or unmount (card, dock)
	}, [
		measure,
		state.panel,
		state.drawer,
		state.view,
		L.card !== null,
		L.dockHidden,
		L.pane !== null,
	])

	// a between-rows drawer shares the right side with the Receiver panel: the open panel wins (board)
	const drawerShown =
		state.drawer !== null && (L.full || state.panel !== "receiver")

	// ---- panes: a task pane opened from elsewhere (⌘K, Shift-drag, the Tuner's scan row) opens its drawer; another
	// drawer, or none, drops it (the drawer's × closes both)
	useEffect(() => {
		const offs: (() => void)[] = []
		for (const [id, decl] of Object.entries(DRAWER_PANES) as [
			DrawerId,
			NonNullable<(typeof DRAWER_PANES)[DrawerId]>,
		][]) {
			if (!decl.task) continue
			let was = decl.wanted()
			offs.push(
				decl.subscribe(() => {
					const now = decl.wanted()
					if (now && !was && store.getState().drawer !== id)
						store.openDrawer(id)
					was = now
				}),
				store.subscribe(() => {
					if (store.getState().drawer !== id && decl.wanted()) decl.hide()
				}),
			)
		}
		return () => {
			for (const off of offs) off()
		}
	}, [store])

	// ---- keyboard: Escape closes the topmost layer; ⌘K / Ctrl+K the palette; ⌘, / Ctrl+, Settings
	const paneShownRef = useRef<(() => void) | null>(null)
	paneShownRef.current =
		pane && paneWanted && (L.pane !== null || L.pushed) ? pane.hide : null
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented) return
			if (e.key === "Escape") {
				// an open pane goes before its drawer (the palette and an island panel are above both)
				const s = store.getState()
				const hidePane = paneShownRef.current
				if (!s.palette && !s.panel && hidePane) {
					e.preventDefault()
					hidePane()
					drawerBox.current?.focus({ preventScroll: true })
					return
				}
				const closed = store.escape()
				if (closed) {
					e.preventDefault()
					refocus(keyOf(closed))
				}
				return
			}
			if (!(e.metaKey || e.ctrlKey) || e.altKey) return
			if (e.key === "k" || e.key === "K") {
				e.preventDefault()
				if (store.getState().palette) store.closePalette()
				else store.openPalette()
			} else if (e.key === ",") {
				e.preventDefault()
				store.toggleDrawer("settings")
			}
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [store, refocus])

	// move focus into a drawer when it opens, so the keyboard lands where the content is
	const drawerBox = useRef<HTMLDivElement>(null)
	const lastDrawer = useRef<DrawerId | null>(null)
	useEffect(() => {
		if (state.drawer && state.drawer !== lastDrawer.current)
			drawerBox.current?.focus({ preventScroll: true })
		lastDrawer.current = state.drawer
	}, [state.drawer])

	// move focus into the pane when it attaches (the push-in screen lands in the drawer box)
	const paneBox = useRef<HTMLDivElement>(null)
	const paneOn = drawerShown && L.pane !== null && pane !== null && paneWanted
	useEffect(() => {
		if (paneOn) paneBox.current?.focus({ preventScroll: true })
	}, [paneOn])
	const pushedOn = drawerShown && L.pushed && pane !== null
	useEffect(() => {
		if (pushedOn) drawerBox.current?.focus({ preventScroll: true })
	}, [pushedOn])

	const hidePane = useCallback(() => {
		pane?.hide()
		drawerBox.current?.focus({ preventScroll: true })
	}, [pane])

	const closeDrawer = useCallback(() => {
		const id = store.getState().drawer
		store.closeDrawer()
		if (id) refocus(`drawer:${id}`)
	}, [store, refocus])
	const closePalette = useCallback(() => {
		store.closePalette()
		refocus("palette")
	}, [store, refocus])

	const island = (
		id: IslandId,
		slot: IslandSlot,
		headRef: Ref<HTMLDivElement>,
		boxRef: Ref<HTMLDivElement> | undefined,
		style: CSSProperties,
		direction?: "up",
	) => (
		<ShellIsland
			name={id}
			slot={slot}
			open={state.panel === id}
			onToggle={() => store.togglePanel(id)}
			direction={direction ?? "down"}
			triggerRef={triggerRef(`panel:${id}`)}
			headRef={headRef}
			boxRef={boxRef}
			style={{ ...style, zIndex: state.panel === id ? 6 : 3 }}
		/>
	)

	const DrawerContent = state.drawer ? DRAWER_CONTENT[state.drawer] : null
	const PaneContent = pane?.Content ?? null
	const d = L.drawer
	return (
		<div ref={root} className="wk-shell" data-view={state.view}>
			<div className="wk-shell-plot">
				{plot ?? <div className="wk-plot-placeholder" aria-hidden="true" />}
			</div>
			{state.view === "map" && (
				<Suspense fallback={null}>
					<MapView
						insets={{ top: L.topRow, right: L.rxRight, phone: L.dockHidden }}
					/>
				</Suspense>
			)}

			{island("tuner", tuner, refs.tunerHead, refs.tunerBox, {
				top: 16,
				left: 16,
			})}
			{island("receiver", receiver, refs.rxHead, refs.rxBox, {
				top: L.rxTop,
				right: L.rxRight,
			})}
			{card && L.card && dragging && (
				<CardTargets
					store={cardStore}
					anchors={L.anchors}
					home={L.card}
					cardH={geo.cardH}
				/>
			)}
			{card && L.card && (
				<CardPlaceContext.Provider value={cardStore}>
					<CardSlot store={cardStore} at={L.card} slotRef={refs.card}>
						{card}
					</CardSlot>
				</CardPlaceContext.Provider>
			)}
			{island(
				"listen",
				listen,
				refs.listenHead,
				refs.listenBox,
				{ left: 16, bottom: 16 },
				"up",
			)}

			{!L.dockHidden && (
				<Dock
					ref={refs.dock}
					state={state}
					compact={L.compact}
					x={L.dockX}
					onView={v => store.setView(v)}
					onDrawer={id => store.toggleDrawer(id)}
					onPalette={() => store.openPalette()}
					triggerRef={triggerRef}
				/>
			)}

			{drawerShown && d && DrawerContent && state.drawer && (
				<div
					ref={drawerBox}
					tabIndex={-1}
					data-wk-region=""
					className="wk-shell-drawer"
					data-full={d.full || undefined}
					data-pane={paneOn || pushedOn || undefined}
					style={{
						top: d.top,
						bottom: d.bottom,
						right: d.right,
						...(d.width === null ? { left: 16 } : { width: d.width }),
					}}
				>
					<Suspense
						fallback={
							<Drawer
								title={DRAWER_TITLE[state.drawer]}
								onClose={closeDrawer}
								aria-busy="true"
							>
								<span
									className="wk-spinner"
									role="status"
									aria-label="Loading"
								/>
							</Drawer>
						}
					>
						{pushedOn && PaneContent ? (
							<PaneContent mode="screen" onHide={hidePane} />
						) : (
							<DrawerContent onClose={closeDrawer} />
						)}
					</Suspense>
				</div>
			)}

			{paneOn && L.pane && pane && PaneContent && (
				<PaneSlot ref={paneBox} rect={L.pane} label={pane.label}>
					<Suspense
						fallback={
							<span
								className="wk-spinner wk-shell-pane-wait"
								role="status"
								aria-label="Loading"
							/>
						}
					>
						<PaneContent mode="pane" onHide={hidePane} />
					</Suspense>
				</PaneSlot>
			)}

			{L.dockHidden && (
				<button
					ref={triggerRef("palette")}
					type="button"
					className="wk-island wk-icon-btn wk-shell-find"
					data-size="touch"
					aria-label="Search and go to"
					aria-haspopup="dialog"
					aria-expanded={state.palette}
					onClick={() => store.openPalette()}
				>
					<Icon name="search" />
				</button>
			)}

			<CardPlaceContext.Provider value={cardStore}>
				<CardAnnouncer />
			</CardPlaceContext.Provider>

			{!state.palette && <ShellToast lifted={!L.dockHidden} />}

			{state.palette && (
				<Suspense fallback={null}>
					<Palette onClose={closePalette} />
				</Suspense>
			)}
		</div>
	)
}

/** The tuned card's slot: on its anchor (gliding there), or under the pointer while dragged. Only this re-renders
 * on pointer moves; the card element itself is the same and React skips it. */
function CardSlot({
	store,
	at,
	slotRef,
	children,
}: {
	store: CardPlaceStore
	at: Point
	slotRef: Ref<HTMLDivElement>
	children: ReactNode
}) {
	const drag = useStore(store, s => s.drag)
	const p = drag ?? at
	return (
		<div
			ref={slotRef}
			className="wk-shell-cardslot"
			data-dragging={drag ? "" : undefined}
			style={{
				transform: `translate(${p.x}px, ${p.y}px)${drag ? " scale(1.02)" : ""}`,
			}}
		>
			{children}
		</div>
	)
}

/** While the card is dragged: a quiet dot on each free anchor (the one it will snap to stronger) and a dashed
 * outline where it lands. No blur (glass budget). */
function CardTargets({
	store,
	anchors,
	home,
	cardH,
}: {
	store: CardPlaceStore
	anchors: readonly CardAnchor[]
	home: Point
	cardH: number
}) {
	const drag = useStore(store, s => s.drag)
	const snap = (drag && nearestAnchor(anchors, drag.x, drag.y)) ?? null
	const land = snap ?? home
	return (
		<div className="wk-shell-targets" aria-hidden="true">
			{anchors.map(a => (
				<span
					key={a.id}
					className="wk-shell-target"
					data-on={snap?.id === a.id || undefined}
					style={{ left: a.x + CARD_W / 2, top: a.y + cardH / 2 }}
				/>
			))}
			<span
				className="wk-shell-target-ghost"
				style={{
					height: cardH,
					transform: `translate(${land.x}px, ${land.y}px)`,
				}}
			/>
		</div>
	)
}

/** The app toast (src/shell/toast.ts): bottom centre, above the dock. */
function ShellToast({ lifted }: { lifted: boolean }) {
	const toast = useStore(appToast)
	if (!toast) return null
	return (
		<div
			role="status"
			className="wk-toast wk-shell-toast"
			data-tone={toast.tone}
			data-lifted={lifted || undefined}
		>
			<span className="wk-shell-toast-text">{toast.text}</span>
			{toast.undo ? (
				<button
					type="button"
					className="wk-btn"
					data-variant="tonal"
					data-size="sm"
					onClick={() => {
						toast.undo?.()
						dismissAppToast()
					}}
				>
					Undo
				</button>
			) : (
				<button
					type="button"
					className="wk-icon-btn"
					data-size="sm"
					aria-label="Dismiss"
					onClick={dismissAppToast}
				>
					<Icon name="close" size={14} />
				</button>
			)}
		</div>
	)
}

// The Immersive shell (docs/web/DESIGN.md, "Shell: direction C"): a full-bleed plot with floating glass islands.
// Tuner top-left, Receiver top-right, Listen bottom-left, the nav dock bottom-centre, the player and the tuned card
// above Listen, notices in the status slot between the Tuner and the Receiver, and the right drawer under the
// Receiver. Every rectangle comes from one pure layout (./layout/compute.ts, "rails and stage"): the shell measures
// intrinsic sizes, computes the layout and applies each rectangle; nothing places itself. One island panel open at a
// time; Escape closes the topmost layer and returns focus to its trigger.
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
import {
	activityExpanded,
	activityLayout,
	isActivityExpanded,
} from "../features/activity/layout.ts"
import { CardAnnouncer, CardPlaceContext } from "./CardHandle.tsx"
import {
	cardPlace as defaultCardPlace,
	type CardPlaceStore,
} from "./card-place.ts"
import { DrawerGrip } from "./DrawerGrip.tsx"
import {
	drawerWidths as defaultDrawerWidths,
	wantedDrawerW,
	type DrawerWidthStore,
} from "./drawer-width.ts"
import { Drawer } from "../ui/Drawer.tsx"
import { Icon } from "../ui/Icon.tsx"
import { Skeleton } from "../ui/Skeleton.tsx"
import type { DrawerContentProps } from "./drawers/types.ts"
import { useShell } from "./hooks.ts"
import {
	CARD_W,
	FULL_MIN_VW,
	nearestAnchor,
	type CardAnchor,
	type Point,
} from "./layout.ts"
import {
	computeLayout,
	DEFAULT_SIZES,
	PLAYER_STOREY_W,
	stablePlot,
	type Layout,
	type LayoutInput,
	type Rect,
	type Size,
} from "./layout/compute.ts"
import { bottomLeft, slotAttrs, topLeft } from "./layout/slot.ts"
import {
	cardLineForced,
	cardMinimised,
	dockedSlot,
	guestLayer,
	PlotLayoutContext,
	publishedLayout,
	statusReports,
} from "./layout/stores.ts"
import "./layout/slots.css"
import { ShellIsland, type IslandSlot } from "./ShellIsland.tsx"
import { Dock } from "./Dock.tsx"
import { PaneSlot } from "./PaneSlot.tsx"
import { PlayerDock } from "../features/playback/PlayerDock.tsx"
import { DRAWER_PANES, paneOf } from "./panes.ts"
import { NoticeRegion } from "./notices/NoticeRegion.tsx"
import { noticeSlots } from "../ui/notice-slot.ts"
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
	/** Each drawer's wanted width (resized from its left edge, remembered per browser). */
	drawerWidthStore?: DrawerWidthStore
}

const keyOf = (c: Closed): string =>
	c.kind === "palette" ? "palette" : `${c.kind}:${c.id}`

/** What the shell measures for the layout: the window and each island's intrinsic size. */
interface Measured {
	readonly W: number
	readonly H: number
	readonly tuner: Size
	readonly receiver: Size
	readonly listen: Size
	readonly dock: { readonly wide: Size; readonly compact: Size }
	readonly player: Size | null
	readonly cardExpanded: Size
	readonly cardLine: Size
	/** Open island panels' sizes (the plot keeps its labels off them). */
	readonly panels: LayoutInput["panels"]
	/** The open drawer has a notice slot under its header. */
	readonly drawerSlot: boolean
}

const INITIAL: Measured = {
	W: 1440,
	H: 900,
	tuner: DEFAULT_SIZES.tuner,
	receiver: DEFAULT_SIZES.receiver,
	listen: DEFAULT_SIZES.listen,
	dock: DEFAULT_SIZES.dock,
	player: null,
	cardExpanded: DEFAULT_SIZES.cardExpanded,
	cardLine: DEFAULT_SIZES.cardLine,
	panels: [],
	drawerSlot: false,
}

const sameSize = (a: Size | null, b: Size | null) =>
	a === b || (a !== null && b !== null && a.w === b.w && a.h === b.h)

function sameMeasured(a: Measured, b: Measured): boolean {
	return (
		a.W === b.W &&
		a.H === b.H &&
		sameSize(a.tuner, b.tuner) &&
		sameSize(a.receiver, b.receiver) &&
		sameSize(a.listen, b.listen) &&
		sameSize(a.dock.wide, b.dock.wide) &&
		sameSize(a.dock.compact, b.dock.compact) &&
		sameSize(a.player, b.player) &&
		sameSize(a.cardExpanded, b.cardExpanded) &&
		sameSize(a.cardLine, b.cardLine) &&
		a.drawerSlot === b.drawerSlot &&
		a.panels.length === b.panels.length &&
		a.panels.every(
			(p, i) =>
				p.island === b.panels[i]?.island && sameSize(p.size, b.panels[i].size),
		)
	)
}

const sizeOf = (el: HTMLElement | null | undefined): Size | null =>
	el && el.offsetWidth && el.offsetHeight
		? { w: el.offsetWidth, h: el.offsetHeight }
		: null

/** The shell's status guest layer element, shared with the guests through `guestLayer`. */
const setGuestLayer = (el: HTMLDivElement | null) => {
	if (guestLayer.get() !== el) guestLayer.set(el)
}

/** The open drawer's notice slot: the newest connected one inside it (a loading skeleton's slot is replaced). */
function drawerNoticeSlot(drawer: HTMLElement | null): HTMLElement | null {
	if (!drawer) return null
	return (
		noticeSlots
			.all()
			.filter(s => s.isConnected && drawer.contains(s))
			.at(-1) ?? null
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
	drawerWidthStore = defaultDrawerWidths,
}: ShellProps) {
	const state = useShell(store)
	const widths = useStore(drawerWidthStore)
	const [resizing, setResizing] = useState(false)
	// the shell re-renders when the wanted anchor changes or a drag starts or ends, never on pointer moves
	const cardAt = useStore(cardStore, s => s.at)
	const dragging = useStore(cardStore, s => s.drag !== null)
	const reports = useStore(statusReports)
	const cardMin = useStore(cardMinimised)
	const slotVersion = useSyncExternalStore(
		noticeSlots.subscribe,
		noticeSlots.version,
		noticeSlots.version,
	)

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

	// ---- intrinsic sizes: the one place the shell measures (ResizeObserver on each slot's content)
	const root = useRef<HTMLDivElement>(null)
	const drawerBox = useRef<HTMLDivElement>(null)
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
		player: elRef("player"),
	}).current
	const [geo, setGeo] = useState<Measured>(INITIAL)
	const panelRef = useRef(state.panel)
	panelRef.current = state.panel
	const measure = useCallback(() => {
		const e = els.current
		const r = root.current
		if (!r) return
		setGeo(prev => {
			const open = panelRef.current
			const head = (k: string, d: Size) => sizeOf(e[k]) ?? d
			// Listen widens while its options are open (a popover): the frame keeps its closed size
			const listenHead =
				open === "listen" ? prev.listen : head("listenHead", prev.listen)
			const dockEl = e["dock"]
			const dockSize = sizeOf(dockEl)
			const dockCompact = dockEl?.hasAttribute("data-compact") ?? false
			const cardEl = e["card"]?.firstElementChild ?? null
			const cardSize = sizeOf(cardEl instanceof HTMLElement ? cardEl : null)
			const cardShownLine = cardEl?.hasAttribute("data-min") ?? false
			const playerEl = e["player"]?.firstElementChild ?? null
			const playerH =
				playerEl instanceof HTMLElement ? playerEl.offsetHeight : 0
			const panels: { island: IslandId; size: Size }[] = []
			if (open) {
				const box = sizeOf(e[`${open === "receiver" ? "rx" : open}Box`])
				const h = sizeOf(e[`${open === "receiver" ? "rx" : open}Head`])
				if (box && h && box.h > h.h + 8)
					panels.push({ island: open, size: { w: box.w, h: box.h - h.h - 8 } })
			}
			const next: Measured = {
				W: r.clientWidth,
				H: r.clientHeight,
				tuner: head("tunerHead", prev.tuner),
				receiver: head("rxHead", prev.receiver),
				listen: listenHead,
				dock: dockSize
					? dockCompact
						? { ...prev.dock, compact: dockSize }
						: { ...prev.dock, wide: dockSize }
					: prev.dock,
				player: playerH > 0 ? { w: PLAYER_STOREY_W, h: playerH } : null,
				// a hidden card keeps its last sizes: falling back to the default would show it again when it is
				// taller than the default, and the card would flip between shown and hidden
				cardExpanded: cardSize && !cardShownLine ? cardSize : prev.cardExpanded,
				cardLine: cardSize && cardShownLine ? cardSize : prev.cardLine,
				panels,
				drawerSlot: drawerNoticeSlot(drawerBox.current) !== null,
			}
			return sameMeasured(prev, next) ? prev : next
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
	// Activity in Cards layout, expanded: the drawer covers the stage between the rails, with no pane beside it
	const cardsLayout = useStore(activityLayout, s => s.layout)
	const cardsExpanded = useStore(activityExpanded, s => s.expanded)
	const expanded =
		state.drawer === "activity" &&
		isActivityExpanded(cardsLayout, cardsExpanded)
	// a sheet between the rails shares the top of the stage with the Receiver panel: the open panel wins (board)
	const drawerShown =
		state.drawer !== null &&
		((geo.W >= FULL_MIN_VW && !expanded) || state.panel !== "receiver")

	const input: LayoutInput = {
		viewport: { w: geo.W, h: geo.H },
		tuner: geo.tuner,
		receiver: geo.receiver,
		listen: geo.listen,
		dock: geo.dock,
		player: geo.player,
		card: card
			? {
					expanded: geo.cardExpanded,
					line: geo.cardLine,
					minimised: cardMin,
					anchor: cardAt,
				}
			: null,
		status: [...reports.values()],
		drawer:
			drawerShown && state.drawer
				? {
						id: state.drawer,
						wantedW: wantedDrawerW(widths, state.drawer),
						expanded,
						pane:
							pane && !expanded
								? { want: paneWanted, pushIn: pane.pushIn }
								: null,
						hasNoticeSlot: geo.drawerSlot,
					}
				: null,
		panels: geo.panels,
	}
	const L: Layout = computeLayout(input)
	const lineForced = L.card !== null && L.card.form === "line" && !cardMin

	// publish what elements outside the shell's tree read (the connection chip, status guests, the card)
	useLayoutEffect(() => {
		publishedLayout.set(L)
		if (cardLineForced.get() !== lineForced) cardLineForced.set(lineForced)
		const slot =
			L.status.where === "drawer-slot"
				? drawerNoticeSlot(drawerBox.current)
				: null
		if (dockedSlot.get() !== slot) dockedSlot.set(slot)
		// the card's handle reads this frame on pointer and key events
		cardStore.frame = {
			anchors: L.cardAnchors,
			card: L.card ? { x: L.card.x, y: L.card.y } : null,
			freeW: L.cardFreeW,
			H: geo.H,
			cardH: L.card?.h ?? 0,
		}
		if (!L.card && cardStore.dragging) cardStore.cancelDrag()
	})
	useEffect(
		() => () => {
			publishedLayout.set(null)
			dockedSlot.set(null)
			cardLineForced.set(false)
		},
		[],
	)
	useLayoutEffect(() => {
		measure()
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", measure)
			return () => window.removeEventListener("resize", measure)
		}
		const ro = new ResizeObserver(measure)
		if (root.current) ro.observe(root.current)
		for (const el of Object.values(els.current)) {
			if (!el) continue
			ro.observe(el)
			if (el.firstElementChild) ro.observe(el.firstElementChild)
		}
		return () => ro.disconnect()
		// re-observe when slots mount or unmount (card, dock, player) and when a notice slot comes or goes
	}, [
		measure,
		state.panel,
		state.drawer,
		state.view,
		L.card !== null,
		L.card?.form,
		L.dock === null,
		L.pane !== null,
		geo.player === null,
		slotVersion,
	])

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

	const d = L.drawer
	const pushed = d?.pushed ?? false
	// ---- keyboard: Escape closes the topmost layer; ⌘K / Ctrl+K the palette; ⌘, / Ctrl+, Settings
	const paneShownRef = useRef<(() => void) | null>(null)
	paneShownRef.current =
		pane && paneWanted && (L.pane !== null || pushed) ? pane.hide : null
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
	const pushedOn = drawerShown && pushed && pane !== null
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
		rect: Rect,
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
			rect={rect}
			style={{ ...style, zIndex: state.panel === id ? 6 : 3 }}
		/>
	)

	const DrawerContent = state.drawer ? DRAWER_CONTENT[state.drawer] : null
	const PaneContent = pane?.Content ?? null
	// the plot's part keeps its identity while its contents hold (a grip move or a resize tick that leaves the plot's
	// numbers alone does not re-render the plot)
	const plotPart = useRef<Layout["plot"] | null>(null)
	plotPart.current = stablePlot(plotPart.current, L.plot)
	const P = plotPart.current
	return (
		<div
			ref={root}
			className="wk-shell"
			data-view={state.view}
			data-resizing={resizing || undefined}
			// the plot body's top and its status notes' centre come from the layout (plot.css, band-ruler.css)
			style={
				{
					"--wk-plot-inset-top": `${P.insetTop}px`,
					"--wk-plot-note-cx": `${P.noteCx}px`,
				} as CSSProperties
			}
		>
			<PlotLayoutContext value={P}>
				<div className="wk-shell-plot">
					{plot ?? <div className="wk-plot-placeholder" aria-hidden="true" />}
				</div>
			</PlotLayoutContext>
			{state.view === "map" && (
				<Suspense fallback={null}>
					<MapView
						insets={{
							top: L.map.top,
							right: L.map.right,
							phone: L.dock === null,
						}}
					/>
				</Suspense>
			)}

			{island(
				"tuner",
				tuner,
				L.tuner,
				refs.tunerHead,
				refs.tunerBox,
				topLeft(L.tuner),
			)}
			{island(
				"receiver",
				receiver,
				L.receiver,
				refs.rxHead,
				refs.rxBox,
				topLeft(L.receiver),
			)}
			{card && L.card && dragging && (
				<CardTargets
					store={cardStore}
					anchors={L.cardAnchors}
					home={L.card}
					cardH={L.card.h}
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
				L.listen,
				refs.listenHead,
				refs.listenBox,
				bottomLeft(L.listen, geo.H),
				"up",
			)}

			{L.dock && (
				<Dock
					ref={refs.dock}
					state={state}
					compact={L.dock.compact}
					rect={L.dock}
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
					data-shape={d.shape}
					data-full={d.shape === "column" || undefined}
					data-pane={paneOn || pushedOn || undefined}
					data-expanded={expanded || undefined}
					{...slotAttrs("drawer", d)}
					style={topLeft(d, true)}
				>
					<Suspense
						fallback={
							<Drawer
								title={DRAWER_TITLE[state.drawer]}
								onClose={closeDrawer}
								aria-busy="true"
							>
								<Skeleton
									toolbar
									shape={state.drawer === "settings" ? "settings" : "list"}
									round={state.drawer === "recordings"}
									label={DRAWER_TITLE[state.drawer]}
								/>
							</Drawer>
						}
					>
						{pushedOn && PaneContent ? (
							<PaneContent mode="screen" onHide={hidePane} />
						) : (
							<DrawerContent
								onClose={closeDrawer}
								paneRoom={d.shape === "column"}
							/>
						)}
					</Suspense>
				</div>
			)}

			{paneOn && L.pane && pane && PaneContent && (
				<PaneSlot ref={paneBox} rect={L.pane} label={pane.label}>
					<Suspense
						fallback={
							<div className="wk-shell-pane-wait">
								<Skeleton rows={6} label={pane.label} />
							</div>
						}
					>
						<PaneContent mode="pane" onHide={hidePane} />
					</Suspense>
				</PaneSlot>
			)}

			{drawerShown && d && L.grip && !pushedOn && state.drawer && (
				<DrawerGrip
					id={state.drawer}
					name={DRAWER_TITLE[state.drawer]}
					store={drawerWidthStore}
					width={d.w}
					maxW={d.maxW}
					rect={L.grip}
					onResizing={setResizing}
				/>
			)}

			{L.find && (
				<button
					ref={triggerRef("palette")}
					type="button"
					className="wk-island wk-icon-btn wk-shell-find"
					data-size="touch"
					aria-label="Search and go to"
					aria-haspopup="dialog"
					aria-expanded={state.palette}
					{...slotAttrs("find", L.find)}
					style={topLeft(L.find)}
					onClick={() => store.openPalette()}
				>
					<Icon name="search" />
				</button>
			)}

			{/* the one recording player, the storey above Listen; empty while nothing plays */}
			<div
				ref={refs.player}
				className="wk-shell-player"
				{...slotAttrs("player", L.player)}
				style={{
					...bottomLeft(
						L.player ?? {
							x: L.listen.x,
							y: L.listen.y - 16,
							w: 0,
							h: 0,
						},
						geo.H,
					),
					width: L.player?.w ?? Math.min(PLAYER_STOREY_W, geo.W - 32),
				}}
			>
				<PlayerDock />
			</div>

			<CardPlaceContext.Provider value={cardStore}>
				<CardAnnouncer />
			</CardPlaceContext.Provider>

			<NoticeRegion
				status={L.status}
				palette={state.palette}
				receiverOpen={state.panel === "receiver"}
			/>
			{/* status guests (the connection chip, the paused label) render here, under the island panels and the
			    palette; gone while the palette is open, like the notice region */}
			{!state.palette && (
				<div
					ref={setGuestLayer}
					className="wk-status-layer"
					data-wk-status-guests=""
				/>
			)}

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
	at: Rect
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
			{...slotAttrs("card", at)}
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

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
	type ComponentType,
	type CSSProperties,
	type ReactNode,
	type Ref,
} from "react"

import { Drawer } from "../ui/Drawer.tsx"
import type { DrawerContentProps } from "./drawers/types.ts"
import { useShell } from "./hooks.ts"
import { DEFAULT_GEOMETRY, shellLayout, type ShellGeometry } from "./layout.ts"
import { ShellIsland, type IslandSlot } from "./ShellIsland.tsx"
import { Dock } from "./Dock.tsx"
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
	/** The tuned card's content (a floating Island), shown at its home above Listen on wide windows. */
	card?: ReactNode
	store?: ShellStore
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
}: ShellProps) {
	const state = useShell(store)

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
		rxHead: elRef("rxHead"),
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
			const next: ShellGeometry = {
				W: r.clientWidth,
				H: r.clientHeight,
				tuner: sz(e["tunerHead"], DEFAULT_GEOMETRY.tuner),
				rx: sz(e["rxHead"], DEFAULT_GEOMETRY.rx),
				listen: sz(e["listenHead"], DEFAULT_GEOMETRY.listen),
				listenLiveH:
					e["listenBox"]?.offsetHeight || DEFAULT_GEOMETRY.listenLiveH,
				dockW: e["dock"]?.offsetWidth ?? 0,
				// a hidden card keeps its last height: falling back to the default would show it again when it is
				// taller than the default, and the card would flip between shown and hidden
				cardH: e["card"]?.offsetHeight || prev.cardH,
			}
			return sameGeometry(prev, next) ? prev : next
		})
	}, [])
	const L = shellLayout(geo, state.drawer)
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
	])

	// a between-rows drawer shares the right side with the Receiver panel: the open panel wins (board)
	const drawerShown =
		state.drawer !== null && (L.full || state.panel !== "receiver")

	// ---- keyboard: Escape closes the topmost layer; ⌘K / Ctrl+K the palette; ⌘, / Ctrl+, Settings
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented) return
			if (e.key === "Escape") {
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
	const d = L.drawer
	return (
		<div ref={root} className="wk-shell" data-view={state.view}>
			<div className="wk-shell-plot">
				{plot ?? <div className="wk-plot-placeholder" aria-hidden="true" />}
			</div>
			{state.view === "map" && (
				<Suspense fallback={null}>
					<MapView />
				</Suspense>
			)}

			{island("tuner", tuner, refs.tunerHead, undefined, { top: 16, left: 16 })}
			{island("receiver", receiver, refs.rxHead, undefined, {
				top: L.rxTop,
				right: L.rxRight,
			})}
			{card && L.card && (
				<div
					ref={refs.card}
					className="wk-shell-cardslot"
					style={{ transform: `translate(${L.card.x}px, ${L.card.y}px)` }}
				>
					{card}
				</div>
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
						<DrawerContent onClose={closeDrawer} />
					</Suspense>
				</div>
			)}

			{state.palette && (
				<Suspense fallback={null}>
					<Palette onClose={closePalette} />
				</Suspense>
			)}
		</div>
	)
}

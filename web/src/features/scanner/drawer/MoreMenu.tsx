// The open discovery's ⋯ menu (Keep, Ignore, Copy frequency, Delete), drawn at the drawer root so the list's
// scroller never clips it; placed under its button, or above when there is no room, inside the drawer.
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react"

import { useReadOnly, useServices } from "../../../app/context.ts"
import { Store, useStore } from "../../../data/index.ts"
import { formatMHz } from "../../format.ts"
import {
	copyFrequency,
	deleteDiscovery,
	setIgnored,
	setKeep,
} from "./actions.ts"
import { openDiscovery } from "../ui-store.ts"

export interface MenuState {
	discoveryId: string
	/** The ⋯ button, to place the menu and give focus back. */
	anchor: HTMLElement
}

export const moreMenu = new Store<MenuState | null>(null)

export function closeMoreMenu(focusBack = false): void {
	const m = moreMenu.get()
	moreMenu.set(null)
	if (focusBack) m?.anchor.focus()
}

const WIDTH = 260

export function MoreMenu({ root }: { root: RefObject<HTMLElement | null> }) {
	const services = useServices()
	const readOnly = useReadOnly()
	const menu = useStore(moreMenu)
	const d = useStore(services.data.scanner, s =>
		menu ? s.discoveries.byId.get(menu.discoveryId) : undefined,
	)
	const box = useRef<HTMLDivElement>(null)
	const [confirm, setConfirm] = useState(false)
	const [pos, setPos] = useState<{
		top: number
		right: number
		maxH: number
	} | null>(null)

	const menuId = menu?.discoveryId ?? null
	useEffect(() => setConfirm(false), [menuId])

	useLayoutEffect(() => {
		const r = root.current
		if (!menu || !r) {
			setPos(null)
			return
		}
		const host = r.getBoundingClientRect()
		const a = menu.anchor.getBoundingClientRect()
		const h = box.current?.offsetHeight ?? 200
		const below = host.bottom - a.bottom - 8
		const above = a.top - host.top - 8
		const right = Math.max(8, host.right - a.right)
		const top =
			below >= h || below >= above
				? a.bottom - host.top + 4
				: Math.max(8, a.top - host.top - 4 - Math.min(h, above))
		setPos({ top, right, maxH: Math.max(120, Math.max(below, above)) })
	}, [menu, root, confirm])

	useEffect(() => {
		if (!menu) return
		box.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus()
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault()
				e.stopPropagation()
				closeMoreMenu(true)
			}
		}
		document.addEventListener("keydown", onKey, true)
		return () => document.removeEventListener("keydown", onKey, true)
	}, [menuId, confirm])

	if (!menu || !d) return null
	const f = formatMHz(d.frequencyHz)
	const kept = d.operator?.keep === true
	const ignored = d.operator?.lockout === true
	const run = (fn: () => Promise<void>) => {
		closeMoreMenu(true)
		void fn()
	}
	const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
		e.preventDefault()
		const items = [
			...(box.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ??
				[]),
		]
		const at = items.indexOf(document.activeElement as HTMLButtonElement)
		const next =
			items[
				(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
			]
		next?.focus()
	}

	return (
		<>
			<div
				className="wks-menu-scrim"
				aria-hidden="true"
				onPointerDown={() => closeMoreMenu()}
			/>
			<div
				ref={box}
				role="menu"
				aria-label={`More actions for ${f}`}
				className="wk-menu wk-scroll wks-menu"
				style={{
					top: pos?.top ?? -9999,
					right: pos?.right ?? 8,
					width: WIDTH,
					maxHeight: pos?.maxH,
				}}
				onKeyDown={onMenuKey}
			>
				{confirm ? (
					<>
						<p className="wks-menu-confirm">
							Delete {f}? It forgets it and its history. It comes back if it is
							heard again.
						</p>
						<button
							type="button"
							role="menuitem"
							className="wk-option wks-danger"
							onClick={() => {
								openDiscovery(null)
								run(() => deleteDiscovery(services, d))
							}}
						>
							Delete
						</button>
						<button
							type="button"
							role="menuitem"
							className="wk-option"
							onClick={() => setConfirm(false)}
						>
							Cancel
						</button>
					</>
				) : (
					<>
						{!readOnly && (
							<>
								<button
									type="button"
									role="menuitem"
									className="wk-option wks-option2"
									onClick={() => run(() => setKeep(services, d, !kept))}
								>
									<span>{kept ? "Stop keeping" : "Keep"}</span>
									<span className="wks-option-hint">
										{kept
											? "Ages out like the rest"
											: "Never aged out · marked with a star"}
									</span>
								</button>
								<button
									type="button"
									role="menuitem"
									className="wk-option wks-option2"
									onClick={() => {
										if (!ignored) openDiscovery(null)
										run(() => setIgnored(services, d, !ignored))
									}}
								>
									<span>{ignored ? "Stop ignoring" : "Ignore"}</span>
									<span className="wks-option-hint">
										{ignored
											? "Back in probes and scans"
											: "Never probed, recorded or scanned again"}
									</span>
								</button>
							</>
						)}
						<button
							type="button"
							role="menuitem"
							className="wk-option wks-option-split"
							onClick={() => run(() => copyFrequency(d))}
						>
							Copy frequency
							<span className="wks-option-hint">
								{(d.frequencyHz / 1e6).toFixed(6)}
							</span>
						</button>
						{!readOnly && (
							<>
								<div className="wk-menu-sep" />
								<button
									type="button"
									role="menuitem"
									className="wk-option wks-danger"
									onClick={() => setConfirm(true)}
								>
									Delete…
								</button>
							</>
						)}
					</>
				)}
			</div>
		</>
	)
}

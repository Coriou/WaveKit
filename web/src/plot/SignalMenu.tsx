// The spectrum's right-click menu (signal-menu.ts): opened by a right-click (or a long press, or the menu key on the
// focused plot) at the signal under the pointer. Its rows run palette actions and confirm with the app toast. Its
// own tiny store, so opening it re-renders this only.
import { useState } from "react"

import { useReadOnly, useServices } from "../app/context.ts"
import type { Store } from "../data/index.ts"
import { useStore } from "../data/index.ts"
import { ActionMenu, type ActionMenuItem } from "../features/ActionMenu.tsx"
import { runAction } from "../features/palette/actions.ts"
import { showAppToast } from "../shell/toast.ts"
import {
	decodeAsRows,
	signalMenuHead,
	signalMenuRows,
	withWhatIsThis,
	type SignalMenuContext,
	type SignalMenuRow,
} from "./signal-menu.ts"

/** The menu's root, which the plot's pointer handler leaves alone. */
export const SIGNAL_MENU_CLASS = "wk-plot-sigmenu"

/** Where the menu is open: the frequency and the pointer, in px inside the plot body. */
export interface SignalMenuAt {
	readonly hz: number
	readonly x: number
	readonly y: number
}

const MENU_W = 248
const MENU_H = 300

export function SignalMenu({
	menu,
	tunedHz,
	widthPx,
	heightPx,
	onClose,
}: {
	menu: Store<SignalMenuAt | null>
	tunedHz: number | null
	widthPx: number
	heightPx: number
	/** The menu closed; `refocus` when from the keyboard (focus goes back to the plot). */
	onClose: (refocus: boolean) => void
}) {
	const at = useStore(menu)
	const services = useServices()
	const { data, listen } = services
	const readOnly = useReadOnly()
	const listening = useStore(listen, s => s.wanted)
	const plan = useStore(data.bandplan, s => s.view)
	const saved = useStore(data.savedFrequencies, s => s.items)
	const discoveries = useStore(data.scanner, s => s.discoveries.byId)
	const [decode, setDecode] = useState<number | null>(null)
	if (!at) return null
	const c: SignalMenuContext = {
		hz: at.hz,
		tunedHz,
		readOnly,
		listening,
		plan,
		saved,
	}
	// the Decode as… list belongs to the menu it was opened from
	const inDecode = decode === at.hz
	const close = (refocus: boolean) => {
		setDecode(null)
		menu.set(null)
		onClose(refocus)
	}
	const item = (r: SignalMenuRow): ActionMenuItem => ({
		label: r.label,
		icon: r.icon,
		...(r.key ? { key: r.key } : {}),
		...(r.hint ? { hint: r.hint } : {}),
		...(r.submenu ? { stay: true } : {}),
		pick: () => {
			if (r.submenu) setDecode(at.hz)
			else void runRow(services, r)
		},
	})
	const items: ActionMenuItem[] = inDecode
		? [
				{
					label: "Back",
					icon: "chevron-left",
					stay: true,
					pick: () => setDecode(null),
				},
				...decodeAsRows(c).map(item),
			]
		: signalMenuRows(c).map(item)
	// open towards the room left in the plot
	const left = at.x + MENU_W > widthPx && at.x >= MENU_W
	const up = at.y + MENU_H > heightPx && at.y >= heightPx / 2
	return (
		<div className={SIGNAL_MENU_CLASS} style={{ left: at.x, top: at.y }}>
			<ActionMenu
				items={items}
				label={inDecode ? "Decode as" : "Signal actions"}
				head={withWhatIsThis(signalMenuHead(c), discoveries.values(), at.hz)}
				className="wk-plot-sigmenu-list"
				style={{
					...(left ? { right: 0 } : { left: 0 }),
					...(up ? { bottom: 0 } : { top: 0 }),
					maxHeight: Math.max(160, (up ? at.y : heightPx - at.y) - 8),
				}}
				onClose={close}
			/>
		</div>
	)
}

/** Runs a row's actions in order; the first refusal stops it. The last step's toast (and Undo) confirms. */
async function runRow(
	services: Parameters<typeof runAction>[0],
	row: SignalMenuRow,
): Promise<void> {
	for (const [i, step] of row.steps.entries()) {
		const r = await runAction(services, step.action, step.done)
		const last = i === row.steps.length - 1
		if (r.tone === "warn" || (last && r.text)) {
			if (r.text)
				showAppToast(r.text, {
					...(r.undo && last ? { undo: r.undo } : {}),
					...(r.tone ? { tone: r.tone } : {}),
				})
			if (r.tone === "warn") return
		}
	}
}

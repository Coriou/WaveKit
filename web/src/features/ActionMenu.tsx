// The small action menu of the tuned card's ⋯ and the spectrum's right-click (ui.css `wk-menu` of `wk-option`
// rows): focus starts on the first row, arrows move, Esc closes, a press outside the menu's parent closes it.
import { useEffect, useRef, type CSSProperties } from "react"

import { Icon, type IconName } from "../ui/Icon.tsx"
import { Kbd } from "../ui/Kbd.tsx"

export interface ActionMenuItem {
	label: string
	icon: IconName
	key?: string
	/** Quiet text after the label (the decoder a protocol runs on). */
	hint?: string
	/** Picking it keeps the menu open (a submenu). */
	stay?: boolean
	pick: () => void
}

export function ActionMenu({
	items,
	label = "More actions",
	head,
	className = "wkf-card-menu",
	style,
	onClose,
}: {
	items: readonly ActionMenuItem[]
	label?: string
	/** A quiet first line naming what the menu acts on. */
	head?: string
	className?: string
	style?: CSSProperties
	onClose: (refocus: boolean) => void
}) {
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		ref.current?.querySelector<HTMLButtonElement>("button")?.focus()
	}, [label])
	useEffect(() => {
		const away = (e: PointerEvent) => {
			if (!ref.current?.parentElement?.contains(e.target as Node))
				onClose(false)
		}
		document.addEventListener("pointerdown", away)
		return () => document.removeEventListener("pointerdown", away)
	}, [onClose])
	return (
		<div
			ref={ref}
			role="menu"
			aria-label={label}
			className={`wk-menu ${className}`}
			style={style}
			onKeyDown={e => {
				const list = [
					...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
				]
				const at = list.indexOf(document.activeElement as HTMLButtonElement)
				if (e.key === "Escape") {
					e.preventDefault()
					e.stopPropagation()
					onClose(true)
				} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					e.preventDefault()
					const next =
						(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length
					list[next]?.focus()
				}
			}}
		>
			{head && (
				<div className="wkf-menu-head" aria-hidden="true">
					{head}
				</div>
			)}
			{items.map(m => (
				<button
					key={m.label}
					type="button"
					role="menuitem"
					className="wk-option"
					onClick={() => {
						if (!m.stay) onClose(true)
						m.pick()
					}}
				>
					<Icon name={m.icon} size={16} />
					<span className="wkf-grow">{m.label}</span>
					{m.hint && <span className="wkf-menu-hint">{m.hint}</span>}
					{m.key && <Kbd>{m.key}</Kbd>}
				</button>
			))}
		</div>
	)
}

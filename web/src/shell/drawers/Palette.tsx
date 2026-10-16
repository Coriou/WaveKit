import { useEffect, useRef } from "react"

import { Field } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Kbd } from "../../ui/Kbd.tsx"
import type { DrawerContentProps } from "./types.ts"

// Placeholder ⌘K palette: a solid sheet with its search field. Escape is handled by the shell.
export default function Palette({ onClose }: DrawerContentProps) {
	const input = useRef<HTMLInputElement>(null)
	useEffect(() => input.current?.focus(), [])
	return (
		<div
			className="wk-shell-scrim"
			onClick={e => e.target === e.currentTarget && onClose()}
		>
			<div
				className="wk-shell-palette wk-drawer"
				role="dialog"
				aria-modal="true"
				aria-label="Search"
			>
				<Field
					ref={input}
					label="Search commands, frequencies and settings"
					placeholder="Tune, open, set…"
					leading={<Icon name="search" size={16} />}
				/>
				<p className="wk-shell-empty">
					Commands arrive with the palette feature. <Kbd>Esc</Kbd> closes.
				</p>
			</div>
		</div>
	)
}

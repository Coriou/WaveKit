import { useState } from "react"

import { Chip } from "../../ui/Chip.tsx"
import { Drawer } from "../../ui/Drawer.tsx"
import { Field } from "../../ui/Field.tsx"
import { Icon } from "../../ui/Icon.tsx"
import type { DrawerContentProps } from "./types.ts"

const CATEGORIES = [
	"All",
	"Voice",
	"Pagers",
	"Aircraft",
	"Marine",
	"Sensors",
] as const

// Placeholder until the Activity feature lands: the drawer's search and category row, no data.
export default function ActivityDrawer({ onClose }: DrawerContentProps) {
	const [cat, setCat] = useState<string>("All")
	return (
		<Drawer title="Activity" onClose={onClose}>
			<Field
				label="Search activity"
				placeholder="Talkgroup, capcode, MMSI, frequency…"
				leading={<Icon name="search" size={16} />}
			/>
			<div className="wk-shell-row" role="group" aria-label="Category">
				{CATEGORIES.map(c => (
					<Chip key={c} size="sm" pressed={cat === c} onClick={() => setCat(c)}>
						{c}
					</Chip>
				))}
			</div>
			<p className="wk-shell-empty">
				Nothing heard yet. Decoded messages and calls appear here as they
				arrive.
			</p>
		</Drawer>
	)
}

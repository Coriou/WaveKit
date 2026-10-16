import { Drawer } from "../../ui/Drawer.tsx"
import type { DrawerContentProps } from "./types.ts"

// Placeholder until the Recordings feature lands.
export default function RecordingsDrawer({ onClose }: DrawerContentProps) {
	return (
		<Drawer title="Recordings" onClose={onClose}>
			<p className="wk-shell-empty">
				No recordings yet. Calls and captures you record appear here.
			</p>
		</Drawer>
	)
}

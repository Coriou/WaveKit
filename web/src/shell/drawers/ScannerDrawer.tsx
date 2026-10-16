import { Button } from "../../ui/Button.tsx"
import { Drawer } from "../../ui/Drawer.tsx"
import { Label } from "../../ui/Label.tsx"
import type { DrawerContentProps } from "./types.ts"

// Placeholder until the Scanner feature lands.
export default function ScannerDrawer({ onClose }: DrawerContentProps) {
	return (
		<Drawer title="Scanner" onClose={onClose}>
			<Label>Watching</Label>
			<p className="wk-shell-empty">
				This span · the scanner lists what it finds in the capture window.
			</p>
			<div className="wk-shell-row">
				<Button variant="primary">Scan a band</Button>
				<Button variant="outline">Identify</Button>
			</div>
		</Drawer>
	)
}

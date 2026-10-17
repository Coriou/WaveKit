import { ScannerDrawer as ScannerDrawerView } from "../../features/scanner/drawer/ScannerDrawer.tsx"
import type { DrawerContentProps } from "./types.ts"

// The Scanner drawer lives in features/scanner/drawer; this is the shell's lazy entry.
export default function ScannerDrawer({ onClose }: DrawerContentProps) {
	return <ScannerDrawerView onClose={onClose} />
}

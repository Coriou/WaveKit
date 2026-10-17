import { SettingsView } from "../../features/settings/SettingsView.tsx"
import type { DrawerContentProps } from "./types.ts"

// The Settings drawer lives in features/settings; this is the shell's lazy entry.
export default function SettingsDrawer({ onClose }: DrawerContentProps) {
	return <SettingsView onClose={onClose} />
}

import { RecordingsDrawer as RecordingsDrawerView } from "../../features/recordings/RecordingsDrawer.tsx"
import type { DrawerContentProps } from "./types.ts"

// The Recordings drawer lives in features/recordings; this is the shell's lazy entry.
export default function RecordingsDrawer({ onClose }: DrawerContentProps) {
	return <RecordingsDrawerView onClose={onClose} />
}

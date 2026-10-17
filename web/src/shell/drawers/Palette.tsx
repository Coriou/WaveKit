import { Palette as PaletteView } from "../../features/palette/Palette.tsx"
import type { DrawerContentProps } from "./types.ts"

// The ⌘K palette lives in features/palette; this is the shell's lazy entry.
export default function Palette({ onClose }: DrawerContentProps) {
	return <PaletteView onClose={onClose} />
}

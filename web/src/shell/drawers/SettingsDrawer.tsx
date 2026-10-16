import { Drawer } from "../../ui/Drawer.tsx"
import { Label } from "../../ui/Label.tsx"
import { Seg } from "../../ui/Seg.tsx"
import { useTheme } from "../hooks.ts"
import {
	themeStore,
	type Accent,
	type Ground,
	type ThemeName,
} from "../theme.ts"
import type { DrawerContentProps } from "./types.ts"

const THEME_OPTS: ReadonlyArray<{ value: ThemeName; label: string }> = [
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
]
const GROUND_OPTS: ReadonlyArray<{ value: Ground; label: string }> = [
	{ value: "ink", label: "Ink" },
	{ value: "graphite", label: "Graphite" },
	{ value: "black", label: "Black" },
]
const ACCENT_OPTS: ReadonlyArray<{ value: Accent; label: string }> = [
	{ value: "phosphor", label: "Phosphor" },
	{ value: "ice", label: "Ice" },
	{ value: "violet", label: "Violet" },
	{ value: "coral", label: "Coral" },
	{ value: "mono", label: "Mono" },
]

// Placeholder Settings: only the Display section, wired to the theme controller.
export default function SettingsDrawer({ onClose }: DrawerContentProps) {
	const prefs = useTheme()
	return (
		<Drawer title="Settings" onClose={onClose}>
			<Label strong as="h3">
				Display
			</Label>
			<div className="wk-shell-setting">
				<span>Theme</span>
				<Seg
					label="Theme"
					options={THEME_OPTS}
					value={prefs.theme}
					onChange={theme => themeStore.set({ theme })}
				/>
			</div>
			<div className="wk-shell-setting">
				<span>Ground</span>
				<Seg
					label="Ground"
					options={GROUND_OPTS.map(o => ({
						...o,
						disabled: prefs.theme === "light",
					}))}
					value={prefs.ground}
					onChange={ground => themeStore.set({ ground })}
				/>
			</div>
			<div className="wk-shell-setting">
				<span>Accent</span>
				<Seg
					label="Accent"
					options={ACCENT_OPTS}
					value={prefs.accent}
					onChange={accent => themeStore.set({ accent })}
				/>
			</div>
		</Drawer>
	)
}

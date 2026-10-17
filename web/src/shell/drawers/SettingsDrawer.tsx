import { useEffect, useState } from "react"

import { useStore } from "../../data/store.ts"
import {
	settingFocus,
	takeSettingFocus,
} from "../../features/settings/registry.ts"
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

const ROWS = ["dev.theme", "dev.ground", "dev.accent"] as const

/** ⌘K "Open in Settings ›": scrolls to the asked row and flashes it. */
function useSettingFlash(): string | null {
	const wanted = useStore(settingFocus, s => s.id)
	const [flash, setFlash] = useState<string | null>(null)
	useEffect(() => {
		const id = takeSettingFocus(ROWS)
		if (id === null) return
		setFlash(id)
		document
			.querySelector(`[data-setting="${id}"]`)
			?.scrollIntoView({ block: "nearest" })
		const t = setTimeout(() => setFlash(null), 1600)
		return () => clearTimeout(t)
	}, [wanted])
	return flash
}

// Placeholder Settings: only the Display section, wired to the theme controller.
export default function SettingsDrawer({ onClose }: DrawerContentProps) {
	const prefs = useTheme()
	const flash = useSettingFlash()
	const attrs = (id: string) => ({
		"data-setting": id,
		"data-flash": flash === id ? "" : undefined,
	})
	return (
		<Drawer title="Settings" onClose={onClose}>
			<Label strong as="h3">
				Display
			</Label>
			<div className="wk-shell-setting" {...attrs("dev.theme")}>
				<span>Theme</span>
				<Seg
					label="Theme"
					options={THEME_OPTS}
					value={prefs.theme}
					onChange={theme => themeStore.set({ theme })}
				/>
			</div>
			<div className="wk-shell-setting" {...attrs("dev.ground")}>
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
			<div className="wk-shell-setting" {...attrs("dev.accent")}>
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

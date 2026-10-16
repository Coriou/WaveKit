import { useSyncExternalStore } from "react"

import { shellStore, type ShellState, type ShellStore } from "./store.ts"
import { themeStore, type ThemePrefs, type ThemeStore } from "./theme.ts"

export function useShell(store: ShellStore = shellStore): ShellState {
	return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

export function useTheme(store: ThemeStore = themeStore): ThemePrefs {
	return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

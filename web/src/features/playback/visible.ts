// Whether a surface's expanded row is on screen: the dock goes compact under a row only while the panel that
// shows it is the visible one (the shell's open drawer, not covered by the Receiver panel; with that panel open
// it is treated as hidden, so the dock stays full rather than vanishing under a covered row).
import { useSyncExternalStore } from "react"

import {
	shellStore,
	type DrawerId,
	type ShellState,
} from "../../shell/store.ts"

/** The drawer `id` is the open one and the Receiver panel does not take its side. */
export function drawerVisible(
	shell: Pick<ShellState, "drawer" | "panel">,
	id: DrawerId,
): boolean {
	return shell.drawer === id && shell.panel !== "receiver"
}

/** drawerVisible for the shell now, following it. */
export function useDrawerVisible(id: DrawerId): boolean {
	const read = () => drawerVisible(shellStore.getState(), id)
	return useSyncExternalStore(shellStore.subscribe, read, read)
}

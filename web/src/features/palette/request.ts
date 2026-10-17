// Opening the palette in a scope (T tunes, M picks a mode, ? lists the shortcuts): the palette reads the request
// when it mounts.
import { Store } from "../../data/store.ts"
import { shellStore } from "../../shell/store.ts"
import type { ScopeId } from "./model.ts"

export const paletteRequest = new Store<{ scope: ScopeId | null }>({
	scope: null,
})

export function openPalette(scope: ScopeId | null = null): void {
	paletteRequest.set({ scope })
	shellStore.openPalette()
}

/** The scope to open in, once. */
export function takePaletteScope(): ScopeId | null {
	const { scope } = paletteRequest.get()
	if (scope !== null) paletteRequest.set({ scope: null })
	return scope
}

import { createContext, useContext } from "react"

import type { AccessStoreState } from "../data/index.ts"
import { useStore } from "../data/index.ts"
import type { AppServices } from "./services.ts"

export const ServicesContext = createContext<AppServices | null>(null)

export function useServices(): AppServices {
	const services = useContext(ServicesContext)
	if (!services) throw new Error("useServices outside <ServicesContext>")
	return services
}

/** A protected core without a session for this browser: the app shows data but changes nothing. */
export function isReadOnly(state: AccessStoreState): boolean {
	return state.access?.mode === "protected" && state.session === null
}

export function useReadOnly(): boolean {
	return useStore(useServices().data.access, isReadOnly)
}

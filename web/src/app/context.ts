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

/** A protected core without a browser session: the app shows data but changes nothing. */
export function isReadOnly(state: AccessStoreState): boolean {
	const access = state.access
	return (
		access?.mode === "protected" && !access.bootstrap.access.sessionAvailable
	)
}

export function useReadOnly(): boolean {
	return useStore(useServices().data.access, isReadOnly)
}

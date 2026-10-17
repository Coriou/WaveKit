import "../features/features.css"

import { useEffect, useState } from "react"

import {
	AudioOutput,
	ConnectionChip,
	createTunerSlot,
	listenSlot,
	receiverSlot,
	TunedCard,
} from "../features/index.ts"
import { useStore } from "../data/index.ts"
import { PaletteKeys } from "../features/palette/PaletteKeys.tsx"
import { Plot } from "../plot/index.ts"
import { Shell } from "../shell/Shell.tsx"
import { followDeepLinks } from "../shell/deep-link-sync.ts"
import { ServicesContext } from "./context.ts"
import { createServices, type AppServices } from "./services.ts"

/** The plot with the app's one tuning step: the Tuner's chosen step, else the band plan's (Plot's default). */
function AppPlot({ services }: { services: AppServices }) {
	const stepHz = useStore(services.prefs, s => s.stepHz)
	return <Plot data={services.data} stepHz={stepHz} />
}

// One Tuner slot for the page: it holds the typed-entry state.
const tunerSlot = createTunerSlot()

/**
 * The data layer is built in the effect (not during render) so StrictMode's remount gets a fresh one.
 * It starts a microtask later: StrictMode's throwaway mount is disposed synchronously before that, so
 * it never fetches (one bootstrap, one /ws, one load of each store per page).
 */
export function App() {
	const [services, setServices] = useState<AppServices | null>(null)
	useEffect(() => {
		const s = createServices()
		let disposed = false
		setServices(s)
		const offLinks = followDeepLinks(s)
		queueMicrotask(() => {
			if (!disposed) void s.start()
		})
		return () => {
			disposed = true
			offLinks()
			s.dispose()
			setServices(null)
		}
	}, [])
	if (!services) return null
	return (
		<ServicesContext value={services}>
			<Shell
				plot={<AppPlot services={services} />}
				tuner={tunerSlot}
				receiver={receiverSlot}
				listen={listenSlot}
				card={<TunedCard />}
			/>
			<PaletteKeys />
			<ConnectionChip />
			<AudioOutput />
		</ServicesContext>
	)
}

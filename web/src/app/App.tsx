import "../features/features.css"

import { useEffect, useState, useSyncExternalStore } from "react"

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
import { shellStore } from "../shell/store.ts"
import { watchReceiverNotices } from "../features/receiver/notices.ts"
import { ServicesContext } from "./context.ts"
import { createServices, type AppServices } from "./services.ts"

const coveredNow = () => shellStore.getState().view !== "spectrum"

/**
 * The plot with the app's one tuning step: the Tuner's chosen step, else the band plan's (Plot's default). The Map and
 * Messages views cover it with an opaque surface, so it stops drawing under them.
 */
function AppPlot({ services }: { services: AppServices }) {
	const stepHz = useStore(services.prefs, s => s.stepHz)
	const covered = useSyncExternalStore(shellStore.subscribe, coveredNow)
	return <Plot data={services.data} stepHz={stepHz} paused={covered} />
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
		const offNotices = watchReceiverNotices(s.data.events)
		queueMicrotask(() => {
			if (!disposed) void s.start()
		})
		return () => {
			disposed = true
			offLinks()
			offNotices()
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

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
import { Plot } from "../plot/index.ts"
import { Shell } from "../shell/Shell.tsx"
import { ServicesContext } from "./context.ts"
import { createServices, type AppServices } from "./services.ts"

// One Tuner slot for the page: it holds the typed-entry state.
const tunerSlot = createTunerSlot()

/** The data layer is built in the effect (not during render) so StrictMode's remount gets a fresh one. */
export function App() {
	const [services, setServices] = useState<AppServices | null>(null)
	useEffect(() => {
		const s = createServices()
		setServices(s)
		void s.start()
		return () => {
			s.dispose()
			setServices(null)
		}
	}, [])
	if (!services) return null
	return (
		<ServicesContext value={services}>
			<Shell
				plot={<Plot data={services.data} />}
				tuner={tunerSlot}
				receiver={receiverSlot}
				listen={listenSlot}
				card={<TunedCard />}
			/>
			<ConnectionChip />
			<AudioOutput />
		</ServicesContext>
	)
}

import {
	listenPlaceholder,
	receiverPlaceholder,
	TunedCardPlaceholder,
	tunerPlaceholder,
} from "../shell/placeholders.tsx"
import { Shell } from "../shell/Shell.tsx"

// The Immersive shell with stand-in island contents; the spectrum (C3) fills `plot`, the slice (C5) the islands.
export function App() {
	return (
		<Shell
			tuner={tunerPlaceholder}
			receiver={receiverPlaceholder}
			listen={listenPlaceholder}
			card={<TunedCardPlaceholder />}
		/>
	)
}

import "@wavekit/brand/tokens/typography.css"
import "@wavekit/brand/tokens/ui.css"
import "./styles/app.css"
import "./shell/device-prefs.ts"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./app/App.tsx"
import { startPwa } from "./pwa/pwa.ts"

startPwa()

const root = document.getElementById("root")
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>,
	)
}

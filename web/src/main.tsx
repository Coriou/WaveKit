import "@wavekit/brand/tokens/typography.css"
import "@wavekit/brand/tokens/ui.css"
import "./styles/app.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./app/App.tsx"

const root = document.getElementById("root")
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>,
	)
}

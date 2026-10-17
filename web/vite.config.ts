import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

import { pwa } from "./build/pwa-plugin.ts"

// The dev server proxies the core API. Default target is the mock (pnpm --filter @wavekit/web mock).
// Live audio is not proxied: the page fetches status.httpUrl directly (the core answers CORS). With a
// core on another machine, set its liveDemod.publicOrigin (WAVEKIT_LIVE_DEMOD__PUBLIC_ORIGIN) so it
// advertises a stream URL this browser can reach instead of http://localhost:<port>.
const api = process.env["WAVEKIT_WEB_API"] ?? "http://127.0.0.1:3101"
const ws = api.replace(/^http/, "ws")

export default defineConfig({
	plugins: [react(), pwa()],
	// packages/brand pulls its own React 18 peer; one copy only.
	resolve: { dedupe: ["react", "react-dom"] },
	server: {
		port: 5173,
		proxy: {
			"/api": { target: api, changeOrigin: false },
			"/health": { target: api, changeOrigin: false },
			"/ws": { target: ws, ws: true },
		},
	},
	worker: { format: "es" },
	build: { target: "es2022", sourcemap: true },
})

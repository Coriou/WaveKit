import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The dev server proxies the core API. Default target is the mock (pnpm --filter @wavekit/web mock).
const api = process.env["WAVEKIT_WEB_API"] ?? "http://127.0.0.1:3101"
const ws = api.replace(/^http/, "ws")

export default defineConfig({
	plugins: [react()],
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

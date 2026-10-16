import { request as httpRequest } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"

import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import type { Connect, Plugin } from "vite"

import {
	AUDIO_PROXY_PREFIX,
	parseAudioProxyPath,
} from "./src/features/listen/audio-proxy.ts"

// The dev server proxies the core API. Default target is the mock (pnpm --filter @wavekit/web mock).
const api = process.env["WAVEKIT_WEB_API"] ?? "http://127.0.0.1:3101"
const ws = api.replace(/^http/, "ws")

/**
 * `/__wk-audio/<port>/<path>` → http://<API host>:<port>/<path>, streamed. Live audio is on its own
 * port (status.httpUrl) and a legacy core sends no CORS header for it, so the page cannot fetch() it
 * cross-origin; the page rewrites its audio URLs to this path in development (audio-proxy.ts).
 */
function audioProxy(apiUrl: string): Plugin {
	const host = new URL(apiUrl).hostname
	const handle = (
		req: IncomingMessage,
		res: ServerResponse,
		next: Connect.NextFunction,
	): void => {
		const target = parseAudioProxyPath(req.url ?? "")
		if (!target) return next()
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.statusCode = 405
			res.end()
			return
		}
		const upstream = httpRequest(
			{
				host,
				port: target.port,
				path: target.path,
				method: req.method,
				headers: { accept: req.headers.accept ?? "*/*" },
			},
			answer => {
				res.writeHead(answer.statusCode ?? 502, answer.headers)
				answer.pipe(res)
				answer.on("error", () => res.destroy())
			},
		)
		upstream.on("error", () => {
			if (!res.headersSent) {
				res.statusCode = 502
				res.end()
			} else res.destroy()
		})
		// the page aborts the fetch on stop or retune: drop the upstream client too
		res.on("close", () => upstream.destroy())
		upstream.end()
	}
	return {
		name: "wavekit-audio-proxy",
		configureServer(server) {
			server.middlewares.use(AUDIO_PROXY_PREFIX, (req, res, next) => {
				// connect strips the mount path; restore it for the parser
				req.url = `${AUDIO_PROXY_PREFIX}${req.url ?? ""}`
				handle(req, res, next)
			})
		},
	}
}

export default defineConfig({
	plugins: [react(), audioProxy(api)],
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

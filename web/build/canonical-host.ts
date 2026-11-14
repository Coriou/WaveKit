// localhost, 127.0.0.1 and [::1] reach the same web server, but to a browser and to a protected core they are
// three different sites: the core accepts the one named in its access settings and answers 403 HOST_FORBIDDEN
// to the others, and a session cookie belongs to one name. When a page is opened under a loopback name the
// core refuses, and it accepts another one, the web server (dev and preview) sends the browser there.
//
// The check asks this very server (its /api proxy), with the Host a browser at that name would send, so it
// sees exactly what the page would. It only ever talks to its own port on a loopback name; a host that is not
// one is never probed or redirected, and the core alone decides what it accepts.

import * as http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"

import type { Plugin } from "vite"

/** A loopback name in a Host header, and where to connect to reach it. */
const LOOPBACK: Readonly<Record<string, string>> = {
	localhost: "localhost",
	"127.0.0.1": "127.0.0.1",
	"[::1]": "::1",
}

/** The names tried, in order, when the one in the address bar is refused. */
const PREFERENCE = ["127.0.0.1", "localhost", "[::1]"] as const

/** A probe waits this long (ms) for the core's answer before the name counts as unknown. */
export const PROBE_TIMEOUT_MS = 1500

/** The paths the core owns (vite.config.ts proxy): never redirected. */
const CORE_PATHS = /^\/(?:api|ws|health)(?:[/?]|$)/

type Probe = "accepted" | "refused" | "unknown"

/** GET /api/access/bootstrap on this server's own `port`, as a browser at `name` would send it. */
function probe(name: string, port: number): Promise<Probe> {
	return new Promise(resolve => {
		const request = http.request(
			{
				host: LOOPBACK[name],
				port,
				path: "/api/access/bootstrap",
				method: "GET",
				setHost: false,
				headers: { host: `${name}:${port}`, accept: "application/json" },
				timeout: PROBE_TIMEOUT_MS,
			},
			response => {
				const status = response.statusCode ?? 0
				const chunks: Buffer[] = []
				let size = 0
				response.on("data", (chunk: Buffer) => {
					size += chunk.length
					if (size <= 4096) chunks.push(chunk)
				})
				response.on("error", () => resolve("unknown"))
				response.on("end", () => {
					if (status === 403) {
						let code: unknown
						try {
							code = (
								JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
									code?: unknown
								} | null
							)?.code
						} catch {
							code = undefined
						}
						resolve(code === "HOST_FORBIDDEN" ? "refused" : "unknown")
						return
					}
					// 200: a protected core that accepts the name; 404: a core without access control.
					resolve(status === 200 || status === 404 ? "accepted" : "unknown")
				})
			},
		)
		request.on("timeout", () => request.destroy())
		request.on("error", () => resolve("unknown"))
		request.end()
	})
}

/**
 * Where a navigation to `url` with the Host header `host` should go instead, or null to serve it
 * as it is. Not null only when `host` is a loopback name on `port` (this server's), the core
 * refuses that name, and it accepts another loopback name that reaches this server.
 */
export async function canonicalHostRedirect(
	host: string,
	url: string,
	port: number,
): Promise<string | null> {
	const split = /^(.+):(\d+)$/.exec(host)
	if (!split?.[1] || Number(split[2]) !== port) return null
	const name = split[1].toLowerCase()
	if (LOOPBACK[name] === undefined) return null
	// a local path only: nothing that a browser could read as another site
	if (!url.startsWith("/") || url.startsWith("//") || url.includes("\\"))
		return null
	if ((await probe(name, port)) !== "refused") return null
	for (const other of PREFERENCE) {
		if (other === name) continue
		if ((await probe(other, port)) === "accepted")
			return `http://${other}:${port}${url}`
	}
	return null
}

/** A page load (not the API, a module, a worker script or an asset). */
export function isNavigation(
	method: string | undefined,
	url: string,
	headers: Readonly<Record<string, string | string[] | undefined>>,
): boolean {
	if (method !== "GET" || CORE_PATHS.test(url)) return false
	const dest = headers["sec-fetch-dest"]
	if (dest !== undefined && dest !== "document") return false
	const accept = headers["accept"]
	return typeof accept === "string" && accept.includes("text/html")
}

type Next = (error?: unknown) => void

/** Connect middleware for the dev and preview servers; `port` reads the port actually listened on. */
export function canonicalHostMiddleware(port: () => number | null) {
	return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
		const listening = port()
		const host = req.headers.host
		const url = req.url ?? "/"
		if (
			listening === null ||
			host === undefined ||
			!isNavigation(req.method, url, req.headers)
		) {
			next()
			return
		}
		canonicalHostRedirect(host, url, listening).then(
			location => {
				if (location === null) {
					next()
					return
				}
				res.writeHead(307, { Location: location, "Cache-Control": "no-store" })
				res.end()
			},
			() => next(),
		)
	}
}

function listeningPort(server: { address(): unknown } | null): number | null {
	const address = server?.address()
	return typeof address === "object" && address !== null && "port" in address
		? (address as { port: number }).port
		: null
}

/** The redirect on the dev server and on `vite preview`. */
export function canonicalHost(): Plugin {
	return {
		name: "wavekit-canonical-host",
		configureServer(server) {
			server.middlewares.use(
				canonicalHostMiddleware(() => listeningPort(server.httpServer)),
			)
		},
		configurePreviewServer(server) {
			server.middlewares.use(
				canonicalHostMiddleware(() => listeningPort(server.httpServer)),
			)
		},
	}
}

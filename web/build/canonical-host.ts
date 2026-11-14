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

/**
 * The probe of the name in the address bar waits this long (ms): it runs before every page load
 * under a loopback name, so a core that hangs must not hold the page for long. A core on this
 * machine answers in a few milliseconds.
 */
export const FIRST_PROBE_TIMEOUT_MS = 500
/** A probe of another name (only after the core refused the first) waits this long (ms). */
export const PROBE_TIMEOUT_MS = 1500
/**
 * A verdict is reused this long (ms): reloads and the pages of one session ask the core once, and
 * a core that hangs costs one wait, not one per navigation. Short enough that a core restarted
 * with other access settings is seen at the next load.
 */
export const PROBE_CACHE_MS = 5000

/** Verdicts by "name:port", with the time they were read. */
export type ProbeCache = Map<string, { at: number; verdict: Probe }>

/** The paths the core owns (vite.config.ts proxy): never redirected. */
const CORE_PATHS = /^\/(?:api|ws|health)(?:[/?]|$)/

/** `open`: a core without access control (it has no bootstrap); it accepts any name. */
type Probe = "accepted" | "open" | "refused" | "unknown"

/** The most of an answer's body a probe reads (bytes): a bootstrap document is well under 1 KiB. */
const PROBE_BODY_MAX = 16 * 1024

/**
 * What an answer to the bootstrap probe says, from its JSON body (the core does not label every
 * answer as JSON, so the content type is not asked for). Only the core's own answers count: a 403
 * with its HOST_FORBIDDEN code is a refusal, its bootstrap document (200) an acceptance, a JSON
 * 404 a core without access control. Anything else (another server's page, a proxy error) is unknown.
 */
export function readProbe(status: number, text: string): Probe {
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		return "unknown"
	}
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return "unknown"
	const fields = body as Record<string, unknown>
	if (status === 403)
		return fields["code"] === "HOST_FORBIDDEN" ? "refused" : "unknown"
	if (status === 404) return "open"
	if (status === 200)
		return typeof fields["version"] === "number" &&
			typeof fields["access"] === "object" &&
			fields["access"] !== null
			? "accepted"
			: "unknown"
	return "unknown"
}

/** GET /api/access/bootstrap on this server's own `port`, as a browser at `name` would send it. */
function probe(name: string, port: number, timeoutMs: number): Promise<Probe> {
	return new Promise(resolve => {
		const request = http.request(
			{
				host: LOOPBACK[name],
				port,
				path: "/api/access/bootstrap",
				method: "GET",
				setHost: false,
				headers: { host: `${name}:${port}`, accept: "application/json" },
				timeout: timeoutMs,
			},
			response => {
				const chunks: Buffer[] = []
				let size = 0
				response.on("data", (chunk: Buffer) => {
					size += chunk.length
					if (size <= PROBE_BODY_MAX) chunks.push(chunk)
				})
				response.on("error", () => resolve("unknown"))
				response.on("end", () =>
					resolve(
						size > PROBE_BODY_MAX
							? "unknown"
							: readProbe(
									response.statusCode ?? 0,
									Buffer.concat(chunks).toString("utf8"),
								),
					),
				)
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
 * refuses that name, and it accepts another loopback name that reaches this server. With a `cache`,
 * verdicts are reused for PROBE_CACHE_MS.
 */
export async function canonicalHostRedirect(
	host: string,
	url: string,
	port: number,
	cache?: ProbeCache,
): Promise<string | null> {
	const split = /^(.+):(\d+)$/.exec(host)
	if (!split?.[1] || Number(split[2]) !== port) return null
	const name = split[1].toLowerCase()
	if (LOOPBACK[name] === undefined) return null
	// a local path only: nothing that a browser could read as another site
	if (!url.startsWith("/") || url.startsWith("//") || url.includes("\\"))
		return null
	const ask = async (candidate: string, timeoutMs: number): Promise<Probe> => {
		const key = `${candidate}:${port}`
		const held = cache?.get(key)
		const now = Date.now()
		if (held && now - held.at < PROBE_CACHE_MS) return held.verdict
		const verdict = await probe(candidate, port, timeoutMs)
		cache?.set(key, { at: Date.now(), verdict })
		return verdict
	}
	if ((await ask(name, FIRST_PROBE_TIMEOUT_MS)) !== "refused") return null
	for (const other of PREFERENCE) {
		if (other === name) continue
		// the refusal came from a protected core: only its own bootstrap document is an acceptance
		if ((await ask(other, PROBE_TIMEOUT_MS)) === "accepted")
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
	const cache: ProbeCache = new Map()
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
		void canonicalHostRedirect(host, url, listening, cache)
			.catch(() => null)
			.then(location => {
				// a client gone during the probe, or anything else here, must not take the server down
				try {
					if (location === null) {
						next()
						return
					}
					res.writeHead(307, {
						Location: location,
						"Cache-Control": "no-store",
					})
					res.end()
				} catch {
					if (!res.headersSent) next()
				}
			})
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

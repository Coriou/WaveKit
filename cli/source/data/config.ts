import { isObj } from "./guards.js"

export interface ApiTarget {
	base: string
	ws: string
	explicit: boolean
}

export class CliUsageError extends Error {
	override name = "CliUsageError"
}

/** Never `localhost` (IPv6-first resolution) and never 4713 (the RTL-TCP relay). */
export const DISCOVERY_CANDIDATES: readonly string[] = [
	"http://127.0.0.1:9000",
	"http://127.0.0.1:3000",
]

const RELAY_PORT = "4713"

export type FetchLike = (
	url: string,
	init?: {
		signal?: AbortSignal
		method?: string
		headers?: Record<string, string>
		body?: string
	},
) => Promise<{
	ok: boolean
	status: number
	statusText: string
	json(): Promise<unknown>
}>

export function checkTarget(url: string): URL {
	let u: URL
	try {
		u = new URL(url)
	} catch {
		throw new CliUsageError(`invalid API URL: ${url}`)
	}
	if (u.hostname === "localhost") u.hostname = "127.0.0.1"
	if (u.port === RELAY_PORT) {
		throw new CliUsageError(
			`port 4713 is the RTL-TCP relay, not the WaveKit API (${url})`,
		)
	}
	return u
}

export function deriveWs(base: string): string {
	const u = new URL(base)
	u.protocol = u.protocol === "https:" ? "wss:" : "ws:"
	u.pathname = "/ws"
	u.search = ""
	u.hash = ""
	return u.toString()
}

export function deriveBase(ws: string): string {
	const u = new URL(ws)
	u.protocol = u.protocol === "wss:" ? "https:" : "http:"
	return u.origin
}

export function hostPort(url: string): string {
	return new URL(url).host
}

type Env = Readonly<Record<string, string | undefined>>

/** Precedence: --api, WAVEKIT_API_URL, WAVEKIT_WS_URL, first of WAVEKIT_WS_URLS. */
export function resolveExplicit(
	apiFlag: string | undefined,
	env: Env,
): ApiTarget | null {
	const api = apiFlag ?? env["WAVEKIT_API_URL"]
	if (api !== undefined && api !== "") {
		const base = checkTarget(api).origin
		return { base, ws: deriveWs(base), explicit: true }
	}
	const ws =
		env["WAVEKIT_WS_URL"] ?? env["WAVEKIT_WS_URLS"]?.split(",")[0]?.trim()
	if (ws !== undefined && ws !== "") {
		const url = checkTarget(ws).toString()
		return { base: deriveBase(url), ws: url, explicit: true }
	}
	return null
}

/** Probe each candidate's /health; the first JSON body with status "ok" wins (200 or 503 both mean core answered). */
export async function discover(
	fetchFn: FetchLike,
	candidates: readonly string[] = DISCOVERY_CANDIDATES,
	timeoutMs = 2000,
): Promise<{ target: ApiTarget | null; tried: string[] }> {
	const tried: string[] = []
	for (const base of candidates) {
		tried.push(hostPort(base))
		try {
			const res = await fetchFn(`${base}/health`, {
				signal: AbortSignal.timeout(timeoutMs),
			})
			const body = await res.json()
			if (isObj(body) && body["status"] === "ok") {
				return { target: { base, ws: deriveWs(base), explicit: false }, tried }
			}
		} catch {
			// unreachable, timed out or not JSON: try the next candidate
		}
	}
	return { target: null, tried }
}

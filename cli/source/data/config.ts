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

export type DispatchRefusalReason =
	| "aborted"
	| "eligibility"
	| "destination"
	| "headers"
	| "credential"

/** Proof from the adapter that native dispatch did not occur. No raw diagnostics. */
export class DispatchNotSent extends Error {
	override name = "DispatchNotSent"
	constructor(readonly reason: DispatchRefusalReason) {
		super("Identify request not sent")
	}
}

export type FetchLike = (
	url: string,
	init?: {
		signal?: AbortSignal
		method?: string
		headers?: Record<string, string>
		body?: string
		/** Private synchronous fence; adapters remove it before native dispatch. */
		beforeDispatch?: () => boolean
	},
) => Promise<{
	ok: boolean
	status: number
	statusText: string
	headers?: { get(name: string): string | null }
	body?: ReadableStream<Uint8Array> | null
	json(): Promise<unknown>
}>

const SCHEMES = new Set(["http:", "https:", "ws:", "wss:"])

export interface TargetOptions {
	/** Protected transports bind the original authority before any URL conversion. */
	preserveLocalhost?: boolean
}

export function checkTarget(url: string, options: TargetOptions = {}): URL {
	let u: URL
	try {
		u = new URL(url)
	} catch {
		throw new CliUsageError("invalid API URL; use http(s):// or ws(s)://")
	}
	if (url.includes("#"))
		throw new CliUsageError("invalid API URL; remove the fragment")
	if (!SCHEMES.has(u.protocol) || u.hostname === "" || u.username || u.password)
		throw new CliUsageError(
			"invalid API URL; use http(s):// or ws(s):// without userinfo",
		)
	if (u.hostname === "localhost" && !options.preserveLocalhost)
		u.hostname = "127.0.0.1"
	if (u.port === RELAY_PORT)
		throw new CliUsageError(
			"port 4713 is the RTL-TCP relay, not the WaveKit API",
		)
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
	u.protocol =
		u.protocol === "wss:" || u.protocol === "https:" ? "https:" : "http:"
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
	options: TargetOptions = {},
): ApiTarget | null {
	const api = apiFlag ?? env["WAVEKIT_API_URL"]
	if (api !== undefined && api !== "") {
		const u = checkTarget(api, options)
		if (u.protocol === "ws:") u.protocol = "http:"
		else if (u.protocol === "wss:") u.protocol = "https:"
		const base = u.origin
		return { base, ws: deriveWs(base), explicit: true }
	}
	const ws =
		env["WAVEKIT_WS_URL"] ?? env["WAVEKIT_WS_URLS"]?.split(",")[0]?.trim()
	if (ws !== undefined && ws !== "") {
		const u = checkTarget(ws, options)
		if (u.protocol === "http:") u.protocol = "ws:"
		else if (u.protocol === "https:") u.protocol = "wss:"
		const url = u.toString()
		return { base: deriveBase(url), ws: url, explicit: true }
	}
	return null
}

/**
 * Probe each candidate's /health; the first WaveKit health body wins: status "ok" (200), or
 * "unhealthy" (503, the core answered but reports itself unhealthy). Cores before the
 * reason-carrying 503 body answered "ok" with 503, which also counts.
 */
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
			if (
				isObj(body) &&
				(body["status"] === "ok" || body["status"] === "unhealthy")
			) {
				return { target: { base, ws: deriveWs(base), explicit: false }, tried }
			}
		} catch {
			// unreachable, timed out or not JSON: try the next candidate
		}
	}
	return { target: null, tried }
}

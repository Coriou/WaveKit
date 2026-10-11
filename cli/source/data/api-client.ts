import { guardScan, type ScanRead, type ScanValues } from "./scanner-guards.js"
import type { LiveAudioConfig } from "@wavekit/api-types"
import type { FetchLike } from "./config.js"
import {
	guardAircraftSnapshot,
	guardCoreStatus,
	guardDecoder,
	guardFanout,
	guardList,
	guardLiveAudioStatus,
	guardPresets,
	guardRelay,
	guardResources,
	guardSource,
	guardTuner,
	isObj,
	isStr,
	type Guarded,
} from "./guards.js"
import {
	ENDPOINT_PATHS,
	type ActionResult,
	type DecoderOp,
	type Endpoint,
	type FetchOutcome,
	type LaneError,
	type RestValues,
	type TunerCommand,
} from "./types.js"

const one = <T>(v: T | undefined): Guarded<T> | undefined =>
	v === undefined ? undefined : { value: v, rejected: 0 }

export const REST_GUARDS: {
	[E in Endpoint]: (v: unknown) => Guarded<RestValues[E]> | undefined
} = {
	decoders: v => guardList(v, guardDecoder),
	sources: v => guardList(v, guardSource),
	tuner: v => guardList(v, guardTuner),
	relay: v => one(guardRelay(v)),
	fanout: v => one(guardFanout(v)),
	resources: v => one(guardResources(v)),
	audio: v => one(guardLiveAudioStatus(v)),
	status: v => one(guardCoreStatus(v)),
	presets: v => one(guardPresets(v)),
	aircraft: v => one(guardAircraftSnapshot(v)),
}

export function classifyError(
	err: unknown,
	at: number,
	timeoutMs: number,
): LaneError {
	if (isTimeout(err)) {
		return {
			kind: "timeout",
			message: `timeout ${Math.round(timeoutMs / 1000)}s`,
			at,
		}
	}
	const message =
		errorCode(err) ?? (err instanceof Error ? err.message : String(err))
	return { kind: "network", message, at }
}

export interface ApiClient {
	get<E extends Endpoint>(endpoint: E): Promise<FetchOutcome<RestValues[E]>>
	decoder(id: string, op: DecoderOp): Promise<ActionResult>
	tuner(sourceId: string, cmd: TunerCommand): Promise<ActionResult>
	audio(op: "start" | "stop"): Promise<ActionResult>
	patchAudio(patch: Partial<LiveAudioConfig>): Promise<ActionResult>
}

export interface ApiClientOptions {
	base: () => string | null
	fetchFn: FetchLike
	now: () => number
	/** Reads (default 2 s). */
	timeoutMs?: number
	/** Writes (default 10 s): decoder stop/restart can take > 5 s on the server (R23). */
	writeTimeoutMs?: number
}

/** A body that is not JSON reads as undefined; a timeout or reset mid-body is rethrown for classifyError. */
async function readJson(res: { json(): Promise<unknown> }): Promise<unknown> {
	try {
		return await res.json()
	} catch (err: unknown) {
		if (err instanceof SyntaxError) return undefined
		throw err
	}
}

function isTimeout(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === "TimeoutError" || err.name === "AbortError")
	)
}

/** Errors that mean the connection dropped after the request went out. */
const RESET_CODES: ReadonlySet<string> = new Set([
	"ECONNRESET",
	"EPIPE",
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
])

function errorCode(err: unknown): string | undefined {
	const cause =
		err instanceof Error
			? (err as Error & { cause?: unknown }).cause
			: undefined
	return isObj(cause) && isStr(cause["code"]) ? cause["code"] : undefined
}

function statusMessage(res: { status: number; statusText: string }): string {
	return res.statusText !== "" ? res.statusText : `HTTP ${res.status}`
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
	const timeoutMs = opts.timeoutMs ?? 2000
	const writeTimeoutMs = opts.writeTimeoutMs ?? 10_000

	async function get<E extends Endpoint>(
		endpoint: E,
	): Promise<FetchOutcome<RestValues[E]>> {
		const base = opts.base()
		if (base === null)
			return {
				ok: false,
				error: { kind: "network", message: "no API target", at: opts.now() },
			}
		try {
			const res = await opts.fetchFn(`${base}${ENDPOINT_PATHS[endpoint]}`, {
				signal: AbortSignal.timeout(timeoutMs),
			})
			const body = await readJson(res)
			if (!res.ok) {
				const message =
					isObj(body) && isStr(body["message"])
						? body["message"]
						: statusMessage(res)
				return {
					ok: false,
					error: { kind: "http", status: res.status, message, at: opts.now() },
				}
			}
			const guarded = REST_GUARDS[endpoint](body)
			if (!guarded) {
				return {
					ok: false,
					error: {
						kind: "invalid",
						message: "unexpected response shape",
						at: opts.now(),
					},
				}
			}
			return { ok: true, value: guarded.value, rejected: guarded.rejected }
		} catch (err: unknown) {
			return { ok: false, error: classifyError(err, opts.now(), timeoutMs) }
		}
	}

	async function send(
		method: "POST" | "PATCH",
		path: string,
		body?: unknown,
	): Promise<ActionResult> {
		const base = opts.base()
		if (base === null)
			return {
				ok: false,
				outcome: "failed",
				status: null,
				message: "no API target",
			}
		let res: Awaited<ReturnType<FetchLike>>
		try {
			res = await opts.fetchFn(`${base}${path}`, {
				method,
				signal: AbortSignal.timeout(writeTimeoutMs),
				...(body !== undefined
					? {
							headers: { "content-type": "application/json" },
							body: JSON.stringify(body),
						}
					: {}),
			})
		} catch (err: unknown) {
			// R23: no reply in time, or a reset after sending, means the request may
			// have landed: the outcome is unknown, never a failure. These two messages
			// never render: the views word an unknown outcome themselves (sent · no
			// reply …) and quote a result's message only when it failed.
			if (isTimeout(err)) {
				return {
					ok: false,
					outcome: "unknown",
					status: null,
					message: `sent · no reply in ${Math.round(writeTimeoutMs / 1000)}s`,
				}
			}
			if (RESET_CODES.has(errorCode(err) ?? "")) {
				return {
					ok: false,
					outcome: "unknown",
					status: null,
					message: "sent · connection reset",
				}
			}
			return {
				ok: false,
				outcome: "failed",
				status: null,
				message: classifyError(err, opts.now(), writeTimeoutMs).message,
			}
		}
		// The status line arrived, so it decides the outcome even if the body read fails.
		let json: unknown
		try {
			json = await readJson(res)
		} catch {
			json = undefined
		}
		const message =
			isObj(json) && isStr(json["message"])
				? json["message"]
				: res.ok
					? "ok"
					: statusMessage(res)
		const code = isObj(json) && isStr(json["code"]) ? json["code"] : undefined
		return {
			ok: res.ok,
			outcome: res.ok ? "ok" : "failed",
			status: res.status,
			message,
			...(!res.ok && code !== undefined ? { code } : {}),
		}
	}

	return {
		get,
		// R100: a bare start pins the decoder (operator mode); only a return to auto
		// sends a body, `{ "pin": false }`.
		decoder: (id, op) =>
			op === "unpin"
				? send("POST", `/api/decoders/${encodeURIComponent(id)}/start`, {
						pin: false,
					})
				: send("POST", `/api/decoders/${encodeURIComponent(id)}/${op}`),
		tuner: (sourceId, cmd) =>
			send(
				"POST",
				`/api/tuner/${encodeURIComponent(sourceId)}/${cmd.setting}`,
				cmd.body,
			),
		audio: op => send("POST", `/api/live-audio/${op}`),
		patchAudio: patch => send("PATCH", "/api/live-audio/config", patch),
	}
}

/** New Scan reads never use response.json(): the byte cap applies before parsing. */
export const SCAN_BODY_BYTES = 2 * 1024 * 1024
export class ScanReadError extends Error {
	override name = "ScanReadError"
	constructor(
		readonly kind:
			| "unavailable"
			| "too-large"
			| "invalid"
			| "http"
			| "network"
			| "timeout",
		message: string,
		readonly status?: number,
		readonly code?: string,
	) {
		super(message)
	}
}

export async function readBoundedJson(
	response: Awaited<ReturnType<FetchLike>>,
	signal: AbortSignal,
): Promise<unknown> {
	const body = response.body
	if (!body)
		throw new ScanReadError("unavailable", "bounded response body unavailable")
	const reader = body.getReader()
	let abort: (() => void) | undefined
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => {
			reject(new ScanReadError("timeout", "Scan read cancelled or timed out"))
			void reader.cancel().catch(() => undefined)
		}
		signal.addEventListener("abort", abort, { once: true })
	})
	try {
		if (signal.aborted)
			throw new ScanReadError("timeout", "Scan read cancelled or timed out")
		const hint = response.headers?.get("content-length")
		if (
			hint !== null &&
			hint !== undefined &&
			/^\d+$/.test(hint) &&
			Number(hint) > SCAN_BODY_BYTES
		)
			throw new ScanReadError("too-large", "Scan response exceeds 2 MiB")
		const bytes = new Uint8Array(SCAN_BODY_BYTES)
		let size = 0
		while (true) {
			const r = await Promise.race([reader.read(), cancelled])
			if (r.done) break
			if (!(r.value instanceof Uint8Array))
				throw new ScanReadError("invalid", "invalid Scan response bytes")
			const nextSize = size + r.value.byteLength
			if (nextSize > SCAN_BODY_BYTES)
				throw new ScanReadError("too-large", "Scan response exceeds 2 MiB")
			bytes.set(r.value, size)
			size = nextSize
		}
		try {
			return JSON.parse(
				Buffer.from(bytes.buffer, 0, size).toString("utf8"),
			) as unknown
		} catch {
			throw new ScanReadError("invalid", "invalid Scan JSON")
		}
	} finally {
		if (abort) signal.removeEventListener("abort", abort)
		void reader.cancel().catch(() => undefined)
		reader.releaseLock()
	}
}

export async function getScan<K extends ScanRead>(
	fetchFn: FetchLike,
	base: string,
	key: K,
	path: string,
	signal: AbortSignal,
): Promise<ScanValues[K]> {
	let abort: (() => void) | undefined
	let abandoned = false
	let claimed = false
	let lateResponse: Awaited<ReturnType<FetchLike>> | null = null
	let disposed = false
	const disposeLate = () => {
		if (!lateResponse || claimed || disposed) return
		disposed = true
		void lateResponse.body?.cancel().catch(() => undefined)
	}
	try {
		if (signal.aborted)
			throw new ScanReadError("timeout", "Scan read cancelled or timed out")
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => {
				abandoned = true
				disposeLate()
				reject(new ScanReadError("timeout", "Scan read cancelled or timed out"))
			}
			signal.addEventListener("abort", abort, { once: true })
		})
		const fetch = fetchFn(`${base}${path}`, { signal }).then(response => {
			lateResponse = response
			if (abandoned) disposeLate()
			return response
		})
		const response = await Promise.race([fetch, cancelled])
		claimed = true
		let body: unknown
		try {
			body = await readBoundedJson(response, signal)
		} catch (error) {
			if (!response.ok && error instanceof ScanReadError)
				throw new ScanReadError(
					error.kind,
					`HTTP ${response.status}: ${error.message}`,
					response.status,
				)
			throw error
		}
		if (!response.ok) {
			// Never echo arbitrary error messages from an authenticated transport.
			const code =
				isObj(body) &&
				isStr(body["code"]) &&
				/^(?:SCANNER_|SPECTRUM_|AUTH_|ACCESS_|HOST_|ORIGIN_|MACHINE_|SESSION_|VALIDATION_)[A-Z_]{1,80}$/.test(
					body["code"],
				)
					? body["code"]
					: undefined
			throw new ScanReadError(
				"http",
				`HTTP ${response.status}${code ? ` ${code}` : ""}`,
				response.status,
				code,
			)
		}
		const value = guardScan(key, body)
		if (value === undefined)
			throw new ScanReadError("invalid", "unexpected Scan response shape")
		return value
	} catch (error) {
		if (error instanceof ScanReadError) throw error
		const timeout =
			signal.aborted ||
			(error instanceof Error &&
				(error.name === "AbortError" || error.name === "TimeoutError"))
		throw new ScanReadError(
			timeout ? "timeout" : "network",
			timeout
				? "Scan read cancelled or timed out"
				: "Scan transport unavailable",
		)
	} finally {
		if (abort) signal.removeEventListener("abort", abort)
	}
}

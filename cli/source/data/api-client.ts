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
			// have landed: the outcome is unknown, never a failure.
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
		decoder: (id, op) =>
			send("POST", `/api/decoders/${encodeURIComponent(id)}/${op}`),
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

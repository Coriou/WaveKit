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
	if (
		err instanceof Error &&
		(err.name === "TimeoutError" || err.name === "AbortError")
	) {
		return {
			kind: "timeout",
			message: `timeout ${Math.round(timeoutMs / 1000)}s`,
			at,
		}
	}
	const cause =
		err instanceof Error
			? (err as Error & { cause?: unknown }).cause
			: undefined
	const code = isObj(cause) && isStr(cause["code"]) ? cause["code"] : undefined
	const message = code ?? (err instanceof Error ? err.message : String(err))
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
	timeoutMs?: number
}

async function readJson(res: { json(): Promise<unknown> }): Promise<unknown> {
	try {
		return await res.json()
	} catch {
		return undefined
	}
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
	const timeoutMs = opts.timeoutMs ?? 2000

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
						: res.statusText
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
			return { ok: false, status: null, message: "no API target" }
		try {
			const res = await opts.fetchFn(`${base}${path}`, {
				method,
				signal: AbortSignal.timeout(timeoutMs),
				...(body !== undefined
					? {
							headers: { "content-type": "application/json" },
							body: JSON.stringify(body),
						}
					: {}),
			})
			const json = await readJson(res)
			const message =
				isObj(json) && isStr(json["message"])
					? json["message"]
					: res.ok
						? "ok"
						: res.statusText
			const code = isObj(json) && isStr(json["code"]) ? json["code"] : undefined
			return {
				ok: res.ok,
				status: res.status,
				message,
				...(!res.ok && code !== undefined ? { code } : {}),
			}
		} catch (err: unknown) {
			return {
				ok: false,
				status: null,
				message: classifyError(err, opts.now(), timeoutMs).message,
			}
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

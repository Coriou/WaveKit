/**
 * Decoder settings (WG6 option descriptors, WG8 settings store): GET /api/decoders/types, the
 * per-decoder view GET /api/decoders/:id/settings, the JSON merge patch PATCH /api/decoders/:id
 * with the store revision as If-Match (applied when the decoder next starts), the start / stop /
 * restart actions and the raw log.
 *
 * The settings view and the working PATCH are mounted only by a protected core. A legacy core
 * answers the view with the route-not-found 404 (code NOT_FOUND, not DECODER_NOT_FOUND) and the
 * PATCH with 501 DECODER_CONFIG_UPDATE_UNSUPPORTED: `available` is then false.
 */
import { z } from "zod"
import type {
	DecoderLog,
	DecoderLogLine,
	DecoderSettingsUpdate,
	DecoderSettingsUpdateResult,
	DecoderSettingsView,
	DecoderTypeInfo,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { ApiError, errorMessage, validated } from "./api-client.ts"
import {
	errorBody,
	failedWrite,
	WRITE_OK,
	writeError,
} from "./setting-write.ts"
import type { SettingWriteResult } from "./setting-write.ts"
import type { Listener, ReadableStore } from "./store.ts"
import { Store } from "./store.ts"

export type DecoderAction = "start" | "stop" | "restart"

export interface DecoderSettingsState {
	/** Registered decoder types by type name (GET /api/decoders/types). */
	types: Readonly<Record<string, DecoderTypeInfo>>
	typesLoaded: boolean
	typesError: string | null
	/** Settings views by decoder id, as loaded or written. */
	views: Readonly<Record<string, DecoderSettingsView>>
	/** Why a decoder's view could not be loaded (unknown decoder, scanner probe, network). */
	viewErrors: Readonly<Record<string, string>>
	/** Protected decoder settings on this core: null until a view or write answers. */
	available: boolean | null
}

/** Lines of GET /api/decoders/:id/log (core's bounds). */
export const DECODER_LOG_LINES = { min: 1, max: 500, default: 200 } as const

const UNAVAILABLE_TEXT =
	"Decoder settings can only be changed on a WaveKit with access control."
const STALE_TEXT =
	"Decoder settings were changed elsewhere. The current values are shown; try again."
const NOT_PATCHABLE_TEXT = "This option cannot be changed here."
const UNKNOWN_KEYS_TEXT = "Some options are not documented for this decoder."

const settingValue = z.union([
	z.boolean(),
	z.number(),
	z.string(),
	z.array(z.string()),
	z.array(z.number()),
])
const source = z.enum(["override", "config", "default"])
const viewSchema = z.object({
	decoderId: z.string(),
	type: z.string(),
	revision: z.number().int().min(0),
	enabled: z.object({ value: z.boolean(), source }),
	options: z.array(
		z.object({
			key: z.string(),
			source,
			patchable: z.boolean(),
			secret: z.boolean(),
			present: z.boolean(),
			value: settingValue.nullable().optional(),
		}),
	),
	undocumentedKeys: z.number().int().min(0),
	pendingRestart: z.boolean(),
	overrideIgnored: z.literal("type-changed").optional(),
})
const resultSchema = z.object({
	settings: viewSchema,
	revision: z.number().int().min(0),
	changed: z.array(z.string()),
	pendingRestart: z.boolean(),
})
const typesSchema = z.array(
	z
		.object({
			type: z.string(),
			caps: z.object({}).passthrough(),
			options: z.array(z.object({ key: z.string() }).passthrough()).optional(),
		})
		.passthrough(),
)
const logSchema = z.object({
	decoderId: z.string(),
	lines: z.array(
		z.object({ stream: z.enum(["stdout", "stderr"]), line: z.string() }),
	),
})

const enc = encodeURIComponent

function without<V>(
	record: Readonly<Record<string, V>>,
	key: string,
): Readonly<Record<string, V>> {
	if (!Object.hasOwn(record, key)) return record
	const copy = { ...record }
	delete copy[key]
	return copy
}

/** True when a 404 is the route-not-found answer (settings not mounted), not an unknown decoder. */
function notMounted(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		error.status === 404 &&
		error.code !== "DECODER_NOT_FOUND"
	)
}

/** DECODER_OPTIONS_INVALID / DECODER_OPTION_NOT_PATCHABLE bodies as per-key messages. */
export function decoderFieldErrors(body: unknown): Record<string, string> {
	const out: Record<string, string> = {}
	if (typeof body !== "object" || body === null) return out
	const record = body as Record<string, unknown>
	const issues = record["issues"]
	if (Array.isArray(issues))
		for (const issue of issues as unknown[]) {
			if (typeof issue !== "object" || issue === null) continue
			const path = (issue as Record<string, unknown>)["path"]
			const message = (issue as Record<string, unknown>)["message"]
			if (typeof path !== "string" || typeof message !== "string") continue
			const key = path.split(".")[0] ?? ""
			if (key === "" || Object.hasOwn(out, key)) continue
			out[key] = message.charAt(0).toUpperCase() + message.slice(1)
		}
	const keys = record["keys"]
	if (Array.isArray(keys))
		for (const key of keys as unknown[])
			if (typeof key === "string" && !Object.hasOwn(out, key))
				out[key] = NOT_PATCHABLE_TEXT
	return out
}

export class DecoderSettingsStore implements ReadableStore<DecoderSettingsState> {
	private readonly state: Store<DecoderSettingsState>
	private readonly api: ApiClient
	private typesInflight: Promise<void> | null = null
	private readonly viewInflight = new Map<string, Promise<void>>()
	private disposed = false

	constructor(api: ApiClient) {
		this.state = new Store<DecoderSettingsState>({
			types: {},
			typesLoaded: false,
			typesError: null,
			views: {},
			viewErrors: {},
			available: null,
		})
		this.api = api
	}

	get(): DecoderSettingsState {
		return this.state.get()
	}

	subscribe = (listener: Listener<DecoderSettingsState>): (() => void) =>
		this.state.subscribe(listener)

	/** GET /api/decoders/types. Never rejects: a failure lands in `typesError`. */
	loadTypes(): Promise<void> {
		this.typesInflight ??= this.fetchTypes().finally(() => {
			this.typesInflight = null
		})
		return this.typesInflight
	}

	/** GET /api/decoders/:id/settings. Never rejects: a failure lands in `viewErrors[id]`. */
	loadView(id: string): Promise<void> {
		let run = this.viewInflight.get(id)
		if (!run) {
			run = this.fetchView(id).finally(() => {
				this.viewInflight.delete(id)
			})
			this.viewInflight.set(id, run)
		}
		return run
	}

	/** PATCH /api/decoders/:id (merge patch, If-Match: the view's revision). Resolves, never rejects. */
	update(
		id: string,
		patch: DecoderSettingsUpdate,
	): Promise<SettingWriteResult> {
		return this.write(id, patch)
	}

	/** POST /api/decoders/:id/{start,stop,restart}; reloads a loaded view (pendingRestart). */
	async action(id: string, kind: DecoderAction): Promise<SettingWriteResult> {
		try {
			await this.api.post<unknown>(`/api/decoders/${enc(id)}/${kind}`)
		} catch (error) {
			return failedWrite(error)
		}
		if (Object.hasOwn(this.state.get().views, id)) await this.loadView(id)
		return WRITE_OK
	}

	/** The last `lines` (1..500) raw stdout/stderr lines, oldest first. Rejects with ApiError. */
	async log(
		id: string,
		lines: number = DECODER_LOG_LINES.default,
	): Promise<DecoderLogLine[]> {
		const count = Math.min(
			DECODER_LOG_LINES.max,
			Math.max(
				DECODER_LOG_LINES.min,
				Math.round(lines) || DECODER_LOG_LINES.min,
			),
		)
		const path = `/api/decoders/${enc(id)}/log`
		const body = await this.api.get<unknown>(path, { query: { lines: count } })
		const log: DecoderLog = validated(logSchema, body, "GET", path)
		return log.lines
	}

	dispose(): void {
		this.disposed = true
	}

	// ---- internals

	private async fetchTypes(): Promise<void> {
		const path = "/api/decoders/types"
		try {
			const body = await this.api.get<unknown>(path)
			const list = validated(
				typesSchema,
				body,
				"GET",
				path,
			) as unknown as DecoderTypeInfo[]
			if (this.disposed) return
			const types: Record<string, DecoderTypeInfo> = {}
			for (const info of list) types[info.type] = info
			this.state.update(s => ({
				...s,
				types,
				typesLoaded: true,
				typesError: null,
			}))
		} catch (error) {
			if (this.disposed) return
			this.state.update(s => ({
				...s,
				typesLoaded: true,
				typesError: errorMessage(error),
			}))
		}
	}

	private async fetchView(id: string): Promise<void> {
		const path = `/api/decoders/${enc(id)}/settings`
		try {
			const body = await this.api.get<unknown>(path)
			const view = validated(
				viewSchema,
				body,
				"GET",
				path,
			) as DecoderSettingsView
			if (!this.disposed) this.acceptView(id, view)
		} catch (error) {
			if (this.disposed) return
			if (notMounted(error))
				this.state.update(s => ({
					...s,
					available: false,
					views: without(s.views, id),
					viewErrors: without(s.viewErrors, id),
				}))
			else
				this.state.update(s => ({
					...s,
					viewErrors: { ...s.viewErrors, [id]: errorMessage(error) },
				}))
		}
	}

	private acceptView(id: string, view: DecoderSettingsView): void {
		this.state.update(s => {
			// One revision for the whole store: every cached view moves to it.
			const views: Record<string, DecoderSettingsView> = {}
			for (const [key, other] of Object.entries(s.views))
				views[key] =
					other.revision < view.revision
						? { ...other, revision: view.revision }
						: other
			views[id] = view
			return {
				...s,
				available: true,
				views,
				viewErrors: without(s.viewErrors, id),
			}
		})
	}

	private async write(
		id: string,
		patch: DecoderSettingsUpdate,
	): Promise<SettingWriteResult> {
		if (patch.enabled === undefined && patch.options === undefined)
			return WRITE_OK
		const view = this.state.get().views[id]
		if (!view && this.state.get().available !== false) await this.loadView(id)
		const revision = this.state.get().views[id]?.revision
		const path = `/api/decoders/${enc(id)}`
		try {
			const body = await this.api.patch<unknown>(
				path,
				patch,
				revision !== undefined
					? { headers: { "If-Match": `"${revision}"` } }
					: {},
			)
			const result = validated(
				resultSchema,
				body,
				"PATCH",
				path,
			) as DecoderSettingsUpdateResult
			this.acceptView(id, result.settings)
			return WRITE_OK
		} catch (error) {
			if (!(error instanceof ApiError)) return failedWrite(error)
			if (
				error.status === 412 ||
				error.code === "DECODER_SETTINGS_REVISION_MISMATCH"
			) {
				await this.loadView(id)
				return writeError(STALE_TEXT)
			}
			if (
				error.status === 501 ||
				error.code === "DECODER_CONFIG_UPDATE_UNSUPPORTED"
			) {
				this.state.update(s => ({ ...s, available: false }))
				return writeError(UNAVAILABLE_TEXT)
			}
			if (
				error.code === "DECODER_OPTIONS_INVALID" ||
				error.code === "DECODER_OPTION_NOT_PATCHABLE"
			) {
				const body = errorBody(error)
				const fields = decoderFieldErrors(body)
				const unknownKeys = body["unknownKeys"]
				const message =
					typeof unknownKeys === "number" && unknownKeys > 0
						? `${error.message}. ${UNKNOWN_KEYS_TEXT}`
						: error.message
				return writeError(message, fields)
			}
			return failedWrite(error)
		}
	}
}

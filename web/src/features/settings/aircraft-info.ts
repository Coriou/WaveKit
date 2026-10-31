// Settings › Map › Online aircraft lookups: GET/PUT /api/aircraft/info (the core's enrichment switch).
import { z } from "zod/v4"
import type { AircraftInfoSettings } from "@wavekit/api-types"

import type { ApiClient } from "../../data/api-client.ts"
import { ApiError, errorMessage, validated } from "../../data/api-client.ts"
import { failedWrite, WRITE_OK } from "../../data/setting-write.ts"
import type { SettingWriteResult } from "../../data/setting-write.ts"
import { Store } from "../../data/store.ts"

const ROUTE = "/api/aircraft/info"

const settings = z.object({
	enabled: z.boolean(),
	online: z.boolean(),
	onlineFrom: z.enum(["config", "ui"]),
	persistent: z.boolean(),
	localDb: z.object({
		enabled: z.boolean(),
		aircraft: z.number().int().nonnegative().nullable(),
		updatedAt: z.string().nullable(),
	}),
}) satisfies z.ZodType<AircraftInfoSettings>

export interface AircraftInfoState {
	/** Null until loaded, or on a core without ADS-B (404) or without the route. */
	readonly settings: AircraftInfoSettings | null
	readonly error: string | null
	readonly busy: boolean
}

export class AircraftInfoStore extends Store<AircraftInfoState> {
	constructor(private readonly api: ApiClient) {
		super({ settings: null, error: null, busy: false })
	}

	async load(): Promise<void> {
		try {
			const value = validated(
				settings,
				await this.api.get<unknown>(ROUTE),
				"GET",
				ROUTE,
			)
			this.update(s => ({ ...s, settings: value, error: null }))
		} catch (error) {
			const gone = error instanceof ApiError && error.status === 404
			this.update(s => ({
				...s,
				settings: gone ? null : s.settings,
				error: gone ? null : errorMessage(error),
			}))
		}
	}

	async setOnline(online: boolean): Promise<SettingWriteResult> {
		if (this.get().busy)
			return { ok: false, message: "A change is being saved" }
		this.update(s => ({ ...s, busy: true }))
		try {
			const value = validated(
				settings,
				await this.api.put<unknown>(ROUTE, { online }),
				"PUT",
				ROUTE,
			)
			this.update(s => ({ ...s, settings: value, error: null }))
			return WRITE_OK
		} catch (error) {
			this.update(s => ({ ...s, error: errorMessage(error) }))
			return failedWrite(error)
		} finally {
			this.update(s => ({ ...s, busy: false }))
		}
	}
}

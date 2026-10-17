/**
 * Station identity (WG4 requirement 6): GET /api/station, and PATCH /api/station with the
 * revision as If-Match. Each field carries its provenance (env > yaml > ui > default); env and
 * yaml values are pinned against UI writes (409 STATION_FIELD_PINNED). PATCH is mounted only by a
 * protected core (`writable: true` in the identity); a legacy core serves the GET alone.
 */
import { z } from "zod/v4"
import { STATION_FIELDS } from "@wavekit/api-types"
import type {
	StationField,
	StationIdentity,
	StationUpdate,
	StationUpdateResult,
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

export interface StationState {
	station: StationIdentity | null
	loaded: boolean
	error: string | null
	/** Core's answer to the last accepted PATCH (restart and coverage notices), until the next load. */
	lastUpdate: StationUpdateResult | null
}

const PATH = "/api/station"

const provenance = z.enum(["default", "yaml", "env", "ui"])
const stringValue = z.object({ value: z.string().nullable(), provenance })
const numberValue = z.object({ value: z.number().nullable(), provenance })
const identitySchema = z.object({
	name: stringValue,
	lat: numberValue,
	lon: numberValue,
	altM: numberValue,
	callsign: stringValue,
	country: stringValue,
	effectiveCountry: z.string().nullable(),
	region: z.enum(["EU", "US", "CA", "AU", "NZ", "JP", "CN"]),
	revision: z.number().int().min(0).optional(),
	writable: z.boolean().optional(),
})
const fieldSchema = z.enum([
	"name",
	"lat",
	"lon",
	"altM",
	"callsign",
	"country",
])
const resultSchema = z.object({
	station: identitySchema,
	revision: z.number().int().min(0),
	changed: z.array(fieldSchema),
	appliesOnRestart: z.array(z.literal("readsb")),
	restartRequired: z.array(z.literal("country")),
	coverageCleared: z.boolean(),
})

/** Field text for a 400 naming the field (core's rules: the YAML `station` block). */
export const STATION_FIELD_RULES: Readonly<Record<StationField, string>> = {
	name: "Use 1 to 256 characters.",
	lat: "Latitude must be between -90 and 90.",
	lon: "Longitude must be between -180 and 180.",
	altM: "Altitude must be a number of metres.",
	callsign: "Use 1 to 128 characters.",
	country: "Use a two-letter country code (ISO 3166-1, e.g. FR).",
}
const PINNED_TEXT =
	"Set in the configuration file or environment; change it there."
const STALE_TEXT =
	"The station was changed elsewhere. The current values are shown; try again."

function fieldsOf(error: unknown): StationField[] {
	const fields = errorBody(error)["fields"]
	if (!Array.isArray(fields)) return []
	return STATION_FIELDS.filter(f => fields.includes(f))
}

export class StationStore implements ReadableStore<StationState> {
	private readonly state: Store<StationState>
	private readonly api: ApiClient
	private inflight: Promise<void> | null = null

	constructor(api: ApiClient) {
		this.state = new Store<StationState>({
			station: null,
			loaded: false,
			error: null,
			lastUpdate: null,
		})
		this.api = api
	}

	get(): StationState {
		return this.state.get()
	}

	subscribe = (listener: Listener<StationState>): (() => void) =>
		this.state.subscribe(listener)

	/** PATCH /api/station is mounted for this deployment (protected core). */
	get writable(): boolean {
		return this.state.get().station?.writable === true
	}

	/** GET /api/station. Never rejects: a failure lands in `error`. */
	load(): Promise<void> {
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	/** PATCH /api/station with If-Match: the current revision. Resolves, never rejects. */
	update(patch: StationUpdate): Promise<SettingWriteResult> {
		return this.write(patch)
	}

	// ---- internals

	private async fetch(): Promise<void> {
		try {
			const body = await this.api.get<unknown>(PATH)
			// Zod infers `?: T | undefined`; the DTO's optionals are absent-or-set (same data).
			const station = validated(
				identitySchema,
				body,
				"GET",
				PATH,
			) as StationIdentity
			this.state.set({
				station,
				loaded: true,
				error: null,
				lastUpdate: null,
			})
		} catch (error) {
			this.state.update(s => ({
				...s,
				loaded: true,
				error: errorMessage(error),
			}))
		}
	}

	private async write(patch: StationUpdate): Promise<SettingWriteResult> {
		if (Object.keys(patch).length === 0) return WRITE_OK
		const revision = this.state.get().station?.revision
		try {
			const body = await this.api.patch<unknown>(
				PATH,
				patch,
				revision !== undefined
					? { headers: { "If-Match": `"${revision}"` } }
					: {},
			)
			const result = validated(
				resultSchema,
				body,
				"PATCH",
				PATH,
			) as StationUpdateResult
			this.state.set({
				station: result.station,
				loaded: true,
				error: null,
				lastUpdate: result,
			})
			return WRITE_OK
		} catch (error) {
			if (!(error instanceof ApiError)) return failedWrite(error)
			if (error.status === 412 || error.code === "STATION_REVISION_MISMATCH") {
				await this.load()
				return writeError(STALE_TEXT)
			}
			const fields = fieldsOf(error)
			if (error.code === "STATION_FIELD_PINNED")
				return writeError(
					error.message,
					Object.fromEntries(fields.map(f => [f, PINNED_TEXT])),
				)
			if (error.code === "STATION_UPDATE_INVALID")
				return writeError(
					error.message,
					Object.fromEntries(fields.map(f => [f, STATION_FIELD_RULES[f]])),
				)
			if (error.status === 404 || error.status === 405)
				return writeError("This WaveKit does not accept station changes.")
			return failedWrite(error)
		}
	}
}

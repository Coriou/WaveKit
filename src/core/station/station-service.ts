/**
 * WG4 lane ST: the live station service (requirement 6, design "Station write layer").
 */
import type {
	StationField,
	StationIdentity,
	StationUpdate,
	StationUpdateResult,
} from "@wavekit/api-types"
import { STATION_FIELDS } from "@wavekit/api-types"
import { stationOrigins } from "../../config.js"
import { createComponentLogger } from "../../utils/logger.js"
import type {
	StationService,
	StationServiceOptions,
	StationStoredValue,
} from "./contract.js"
import { StationUpdateError } from "./errors.js"
import {
	changedFields,
	effectiveLocation,
	pinnedFields,
	resolveStation,
	toIdentity,
} from "./layers.js"
import type {
	EffectiveStation,
	StationFieldValue,
	StationLayers,
	StationLayerValues,
} from "./layers.js"
import {
	loadStationStore,
	storeValues,
	validateStationValue,
	writeStationStore,
} from "./store.js"
import type { StationStoreState } from "./store.js"

const FIELD_SET = new Set<string>(STATION_FIELDS)

function isStationField(key: string): key is StationField {
	return FIELD_SET.has(key)
}

type ValidPatch = Partial<Record<StationField, StationFieldValue | null>>

function invalid(message: string, fields?: StationField[]): StationUpdateError {
	return new StationUpdateError("STATION_UPDATE_INVALID", message, fields)
}

/** Keys of a patch object, or 400 when it is not a plain object. */
function patchKeys(patch: unknown): string[] {
	if (
		typeof patch !== "object" ||
		patch === null ||
		Array.isArray(patch) ||
		Object.getPrototypeOf(patch) !== Object.prototype
	) {
		throw invalid("The station update must be a JSON object")
	}
	return Object.keys(patch).filter(
		key => (patch as Record<string, unknown>)[key] !== undefined,
	)
}

function validatePatch(patch: object, keys: string[]): ValidPatch {
	const unknown = keys.filter(key => !isStationField(key))
	if (unknown.length > 0) {
		throw invalid(`Unknown station field(s): ${unknown.join(", ")}`)
	}
	if (keys.length === 0) throw invalid("The station update names no field")
	const record = patch as Record<string, unknown>
	const out: ValidPatch = {}
	const bad: StationField[] = []
	for (const field of STATION_FIELDS) {
		if (!keys.includes(field)) continue
		const raw = record[field]
		if (raw === null) {
			out[field] = null
			continue
		}
		const value = validateStationValue(field, raw)
		if (value === null) bad.push(field)
		else out[field] = value
	}
	if (bad.length > 0) {
		throw invalid(`Invalid station field(s): ${bad.join(", ")}`, bad)
	}
	const hasLat = "lat" in out
	const hasLon = "lon" in out
	if (
		hasLat !== hasLon ||
		(hasLat && (out.lat === null) !== (out.lon === null))
	) {
		throw invalid("lat and lon must be set or cleared together", ["lat", "lon"])
	}
	return out
}

function sameLocation(
	a: { lat: number; lon: number } | null,
	b: { lat: number; lon: number } | null,
): boolean {
	if (a === null || b === null) return a === b
	return a.lat === b.lat && a.lon === b.lon
}

export async function openStationService(
	options: StationServiceOptions,
): Promise<StationService> {
	const log = createComponentLogger(options.logger, "StationService")
	const now = options.now ?? Date.now
	const origins = stationOrigins(options.config)
	const configured: StationLayerValues = {}
	for (const field of STATION_FIELDS) {
		const value = options.config.station[field]
		if (value !== undefined) configured[field] = value
	}

	let store: StationStoreState = await loadStationStore(
		options.stateDir,
		log,
		now,
	)
	const layersOf = (state: StationStoreState): StationLayers => ({
		configured,
		origins: { ...origins },
		ui: storeValues(state),
	})
	const pinned = pinnedFields(layersOf(store))
	let effective: EffectiveStation = resolveStation(layersOf(store))
	const listeners = new Set<(identity: StationIdentity) => void>()
	let chain: Promise<unknown> = Promise.resolve()
	let closed = false

	const identity = (): StationIdentity =>
		toIdentity(effective, {
			region: options.region,
			revision: store.revision,
			writable: options.writable,
		})

	async function apply(
		patch: StationUpdate,
		ifMatch: number | undefined,
	): Promise<StationUpdateResult> {
		if (closed) {
			throw new StationUpdateError(
				"STATION_STORE_UNAVAILABLE",
				"The station service is closed",
			)
		}
		const keys = patchKeys(patch)
		const pinnedHit = STATION_FIELDS.filter(
			field => keys.includes(field) && pinned.has(field),
		)
		if (pinnedHit.length > 0) {
			throw new StationUpdateError(
				"STATION_FIELD_PINNED",
				`Pinned by YAML or environment: ${pinnedHit.join(", ")}`,
				pinnedHit,
			)
		}
		const valid = validatePatch(patch, keys)
		if (ifMatch !== undefined && ifMatch !== store.revision) {
			throw new StationUpdateError(
				"STATION_REVISION_MISMATCH",
				`Revision is ${store.revision}, not ${ifMatch}`,
			)
		}

		if (store.revision >= Number.MAX_SAFE_INTEGER) {
			throw new StationUpdateError(
				"STATION_STORE_UNAVAILABLE",
				"The station revision counter is exhausted",
			)
		}
		const updatedAt = new Date(now()).toISOString()
		const fields: Partial<Record<StationField, StationStoredValue>> = {
			...store.fields,
		}
		for (const field of STATION_FIELDS) {
			if (!(field in valid)) continue
			const value = valid[field]
			if (value === null || value === undefined) delete fields[field]
			else fields[field] = { value, provenance: "ui", updatedAt }
		}
		const next: StationStoreState = { revision: store.revision + 1, fields }
		try {
			await writeStationStore(options.stateDir, next)
		} catch (error: unknown) {
			log.warn({ err: error }, "Could not persist the station UI layer")
			throw new StationUpdateError(
				"STATION_STORE_UNAVAILABLE",
				"The station store could not be written",
				undefined,
				error instanceof Error ? error : undefined,
			)
		}

		const before = effective
		store = next
		effective = resolveStation(layersOf(store))
		const changed = changedFields(before, effective)
		const oldLocation = effectiveLocation(before)
		const newLocation = effectiveLocation(effective)
		const locationChanged = !sameLocation(oldLocation, newLocation)
		let coverageCleared = false
		if (locationChanged && options.onLocationChange) {
			try {
				coverageCleared = options.onLocationChange(newLocation).cleared
			} catch (error: unknown) {
				log.error({ err: error }, "Applying the station location failed")
			}
		}
		const station = identity()
		for (const listener of listeners) {
			try {
				listener(station)
			} catch (error: unknown) {
				log.error({ err: error }, "Station change listener failed")
			}
		}
		return {
			station,
			revision: store.revision,
			changed,
			appliesOnRestart: locationChanged ? ["readsb"] : [],
			restartRequired: changed.includes("country") ? ["country"] : [],
			coverageCleared,
		}
	}

	return {
		identity,
		location: () => effectiveLocation(effective),
		update(patch, updateOptions) {
			const run = chain.then(() => apply(patch, updateOptions?.ifMatch))
			chain = run.catch(() => undefined)
			return run
		},
		onChange(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		async close() {
			closed = true
			await chain
			listeners.clear()
		},
	}
}

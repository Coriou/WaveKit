/**
 * WG4 lane ST: pure station precedence (env > yaml > ui > default), provenance and the
 * lat/lon pair rule (docs/specs/web-gaps-4, requirement 6.2, 6.3, 6.11).
 */
import type {
	StationField,
	StationIdentity,
	StationValue,
} from "@wavekit/api-types"
import { STATION_FIELDS } from "@wavekit/api-types"
import type { StationConfigOrigin } from "../../config.js"

export type StationFieldValue = string | number
export type StationLayerValues = Partial<
	Record<StationField, StationFieldValue>
>

export interface StationLayers {
	/** The loaded config `station` block (env and yaml values). */
	configured: StationLayerValues
	/** Origin of each configured field; a configured field without an origin counts as yaml. */
	origins: Partial<Record<StationField, StationConfigOrigin>>
	/** The persisted UI layer. */
	ui: StationLayerValues
}

export type EffectiveStation = {
	[K in StationField]: StationValue<StationFieldValue>
}

const PAIR: readonly StationField[] = ["lat", "lon"]

function configuredOrigin(
	layers: StationLayers,
	field: StationField,
): StationConfigOrigin | null {
	if (layers.configured[field] === undefined) return null
	return layers.origins[field] ?? "yaml"
}

/**
 * Fields a UI write may not touch: every field set by yaml or env; when either of lat/lon is
 * pinned, both are.
 */
export function pinnedFields(layers: StationLayers): Set<StationField> {
	const out = new Set<StationField>()
	for (const field of STATION_FIELDS) {
		if (configuredOrigin(layers, field) !== null) out.add(field)
	}
	if (out.has("lat") || out.has("lon")) {
		out.add("lat")
		out.add("lon")
	}
	return out
}

/**
 * Effective value per field. Non-pair fields: first set layer in precedence order. lat/lon:
 * when the config sets either, the config values are used as they are (today's behaviour);
 * otherwise the UI pair applies only when both halves are stored, a half pair is ignored.
 */
export function resolveStation(layers: StationLayers): EffectiveStation {
	const out = {} as Record<StationField, StationValue<StationFieldValue>>
	for (const field of STATION_FIELDS) {
		if (PAIR.includes(field)) continue
		const origin = configuredOrigin(layers, field)
		const configured = layers.configured[field]
		const ui = layers.ui[field]
		if (origin !== null && configured !== undefined) {
			out[field] = { value: configured, provenance: origin }
		} else if (ui !== undefined) {
			out[field] = { value: ui, provenance: "ui" }
		} else {
			out[field] = { value: null, provenance: "default" }
		}
	}
	const configPair = PAIR.some(field => layers.configured[field] !== undefined)
	const uiLat = layers.ui.lat
	const uiLon = layers.ui.lon
	for (const field of PAIR) {
		let value: StationValue<StationFieldValue>
		if (configPair) {
			const origin = configuredOrigin(layers, field)
			const configured = layers.configured[field]
			value =
				origin !== null && configured !== undefined
					? { value: configured, provenance: origin }
					: { value: null, provenance: "default" }
		} else if (uiLat !== undefined && uiLon !== undefined) {
			value = { value: layers.ui[field] ?? null, provenance: "ui" }
		} else {
			value = { value: null, provenance: "default" }
		}
		out[field] = value
	}
	return out
}

/** The effective lat/lon pair, or null when either is unset. */
export function effectiveLocation(
	effective: EffectiveStation,
): { lat: number; lon: number } | null {
	const lat = effective.lat.value
	const lon = effective.lon.value
	if (typeof lat !== "number" || typeof lon !== "number") return null
	return { lat, lon }
}

function asString(
	value: StationValue<StationFieldValue>,
): StationValue<string> {
	return {
		value: typeof value.value === "string" ? value.value : null,
		provenance: value.provenance,
	}
}

function asNumber(
	value: StationValue<StationFieldValue>,
): StationValue<number> {
	return {
		value: typeof value.value === "number" ? value.value : null,
		provenance: value.provenance,
	}
}

/** The StationIdentity DTO of an effective station. */
export function toIdentity(
	effective: EffectiveStation,
	extra: {
		region: StationIdentity["region"]
		revision: number
		writable: boolean
	},
): StationIdentity {
	const country = asString(effective.country)
	return {
		name: asString(effective.name),
		lat: asNumber(effective.lat),
		lon: asNumber(effective.lon),
		altM: asNumber(effective.altM),
		callsign: asString(effective.callsign),
		country,
		effectiveCountry: country.value,
		region: extra.region,
		revision: extra.revision,
		writable: extra.writable,
	}
}

/** Fields whose effective value differs, in STATION_FIELDS order. */
export function changedFields(
	before: EffectiveStation,
	after: EffectiveStation,
): StationField[] {
	return STATION_FIELDS.filter(
		field => before[field].value !== after[field].value,
	)
}

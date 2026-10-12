import type { BandRegion } from "./decoders.js"

export type StationProvenance = "default" | "yaml" | "env"
export interface StationValue<T> {
	readonly value: T | null
	readonly provenance: StationProvenance
}
/** Explicit operator identity; coordinates never determine country or region. */
export interface StationIdentity {
	readonly name: StationValue<string>
	readonly lat: StationValue<number>
	readonly lon: StationValue<number>
	readonly altM: StationValue<number>
	readonly callsign: StationValue<string>
	readonly country: StationValue<string>
	readonly effectiveCountry: string | null
	readonly region: BandRegion
}

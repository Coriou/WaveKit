// What the live aircraft fleet says about one airframe, for places that only hold its ICAO address
// (Activity rows, ⌘K). Pure functions over the fleet snapshot.
import type { Aircraft } from "../data/fleets.ts"
import type { FleetState } from "../data/fleet-store.ts"

/** The map's name: callsign, else registration, else the ICAO address. */
export function aircraftName(a: Aircraft): string {
	return a.callsign?.trim() || a.identification?.registration || a.icao
}

/** Who flies it and what it is: "WaveKit Air · A320 214"; "" when the core knows neither. */
export function aircraftAbout(a: Aircraft): string {
	const id = a.identification
	return [
		id?.airline?.name ?? id?.operator,
		id?.typeDescription ?? id?.typeCode,
	]
		.filter(Boolean)
		.join(" · ")
}

/** The ICAO address in an Activity entity key ("icao:0A0B01"); null for any other key. */
export function icaoOfEntity(key: string | null | undefined): string | null {
	const m = /^icao:([0-9A-Fa-f]{6})$/.exec(key ?? "")
	return m?.[1] ? m[1].toUpperCase() : null
}

/** The live aircraft with this ICAO address, whatever case the fleet keys it in. */
export function aircraftByIcao(
	s: FleetState<Aircraft>,
	icao: string,
): Aircraft | null {
	const e =
		s.entries.get(icao) ??
		s.entries.get(icao.toUpperCase()) ??
		s.entries.get(icao.toLowerCase())
	return e?.value ?? null
}

// The live fleet's name and "who flies what" for an Activity row's aircraft (icao:… entity keys).
import { useEffect, useMemo } from "react"

import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import {
	aircraftAbout,
	aircraftByIcao,
	aircraftName,
	icaoOfEntity,
} from "../aircraft.ts"
import type { RowAircraft } from "./rows.ts"

/** Null for rows that are not about an aircraft, or for an aircraft the receiver no longer tracks. */
export function useRowAircraft(
	entityKey: string | null | undefined,
): RowAircraft | null {
	const { data } = useServices()
	const icao = icaoOfEntity(entityKey)
	const fleet = data.fleets.aircraft
	const name = useStore(fleet, s => {
		const a = icao ? aircraftByIcao(s, icao) : null
		return a ? aircraftName(a) : null
	})
	const about = useStore(fleet, s => {
		const a = icao ? aircraftByIcao(s, icao) : null
		return a ? aircraftAbout(a) : null
	})
	return useMemo(
		() => (name === null ? null : { name, about: about ?? "" }),
		[name, about],
	)
}

/** The entity key names an aircraft (icao:…). */
export const aircraftKey = (key: string | null | undefined): boolean =>
	icaoOfEntity(key) !== null

/** Keeps the aircraft fleet live while `on` (a list that shows aircraft rows). */
export function useAircraftFleet(on: boolean): void {
	const { data } = useServices()
	useEffect(() => (on ? data.fleets.aircraft.attach() : undefined), [on, data])
}

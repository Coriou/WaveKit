import type { DecoderOutput } from "@wavekit/api-types"
import type { AircraftLookup, FormattedMessage } from "../../data/types.js"
import { formatAcars } from "./acars.js"
import { formatAircraft, isAircraftShape } from "./aircraft.js"
import { formatAis, isAisShape } from "./ais.js"
import { formatCall, isCallShape } from "./call.js"
import { formatGeneric } from "./generic.js"
import { formatMesh, isMeshShape } from "./mesh.js"
import { formatPager } from "./pager.js"
import { formatRtl433, isRtl433Shape } from "./rtl433.js"

export { detailJson } from "./generic.js"
export { EMERGENCY_SQUAWKS } from "./aircraft.js"
export { MAX_TEXT } from "./common.js"

const NONE: AircraftLookup = () => undefined

/** Matches ReduceDeps["summarize"]: computed once at ingest (spec §10.8). */
export function formatMessage(
	output: DecoderOutput,
	decoderId: string,
	lookup: AircraftLookup = NONE,
): FormattedMessage {
	const t = output.type.toLowerCase()
	const d = output.data
	if (t === "aircraft" || (decoderId === "readsb" && isAircraftShape(d)))
		return formatAircraft(d, decoderId, t, lookup)
	if (t === "call_start" || t === "call_end") return formatCall(d, decoderId, t)
	if (t === "pocsag" || t === "flex") return formatPager(d, decoderId, t)
	if (t === "meshtastic" && isMeshShape(d)) return formatMesh(d, decoderId, t)
	if (t === "acars" || t === "vdl2") return formatAcars(d, decoderId, t)
	if (t === "ais" || t === "ship" || isAisShape(d))
		return formatAis(d, decoderId, t)
	if (isRtl433Shape(d)) return formatRtl433(d, decoderId, t)
	if (isAircraftShape(d)) return formatAircraft(d, decoderId, t, lookup)
	if (isCallShape(d)) return formatCall(d, decoderId, t)
	return formatGeneric(output, decoderId)
}

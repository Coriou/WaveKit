import type { DecoderOutput } from "@wavekit/api-types"
import type { AircraftLookup, FormattedMessage } from "../../data/types.js"
import { formatAcars, formatVdl2 } from "./acars.js"
import { formatAircraft, isAircraftShape } from "./aircraft.js"
import { formatAis, isAisShape } from "./ais.js"
import { formatAprs } from "./aprs.js"
import { formatCall, isCallShape } from "./call.js"
import { formatGeneric } from "./generic.js"
import { formatMesh, isMeshShape } from "./mesh.js"
import { formatMultimonDecode, isMultimonDecodeShape } from "./multimon.js"
import { formatPager, isPagerShape } from "./pager.js"
import { formatRtl433, isRtl433Shape } from "./rtl433.js"

export { detailJson } from "./generic.js"
export { EMERGENCY_SQUAWKS } from "./aircraft.js"
export { MAX_TEXT } from "./common.js"

const NONE: AircraftLookup = () => undefined

/**
 * Matches ReduceDeps["summarize"]: computed once at ingest (spec §10.8).
 * Routing follows the types src/decoders/builtin/* emit (R6): aircraft
 * (readsb), call_start/call_end/sync/error (dsd-fme), message/decode
 * (multimon-ng), meshtastic, acars, vdl2, aprs (direwolf), ship
 * (ais-catcher) and signal (rtl433).
 */
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
	if (t === "pocsag" || t === "flex" || (t === "message" && isPagerShape(d)))
		return formatPager(d, decoderId, t)
	if (isMultimonDecodeShape(t, d)) return formatMultimonDecode(d, decoderId, t)
	if (t === "meshtastic" && isMeshShape(d)) return formatMesh(d, decoderId, t)
	if (t === "acars") return formatAcars(d, decoderId, t)
	if (t === "vdl2") return formatVdl2(d, decoderId, t)
	if (t === "aprs") return formatAprs(d, decoderId, t)
	if (t === "ais" || t === "ship" || isAisShape(d))
		return formatAis(d, decoderId, t)
	if (isRtl433Shape(d)) return formatRtl433(d, decoderId, t)
	if (isAircraftShape(d)) return formatAircraft(d, decoderId, t, lookup)
	if (isCallShape(d)) return formatCall(d, decoderId, t)
	return formatGeneric(output, decoderId)
}

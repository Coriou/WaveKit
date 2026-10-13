import type { ShipData } from "../../../decoders/builtin/ais-catcher.js"
import { isCoalescibleShape } from "../storage/coalesce.js"
import type { DecodePresentation } from "../types.js"
import {
	canonicalMmsi,
	clampTitle,
	entityKey,
	numberField,
	presentation,
	readPayload,
	readPosition,
	stringField,
	takeFields,
} from "./budget.js"

/** AIS vessel. Speed stays in the payload's knots; no unit conversion. */
export function presentShip(data: unknown): DecodePresentation | undefined {
	const payload = readPayload(data)
	if (!payload) return undefined
	const ship = payload as Partial<ShipData>
	const mmsi = canonicalMmsi(ship.mmsi ?? payload["mmsi"])
	const name = stringField(payload, "name")
	const title = clampTitle(name ?? mmsi ?? "")
	const key = mmsi === null ? null : entityKey("mmsi", mmsi)
	const fields = isCoalescibleShape("ship", payload)
		? []
		: takeFields(
				[
					{ key: "name", label: "Name", value: name },
					{
						key: "callsign",
						label: "Callsign",
						value: stringField(payload, "callsign"),
					},
					{
						key: "navStatus",
						label: "Nav status",
						value: numberField(payload, "navStatus"),
					},
					{
						key: "sog",
						label: "Speed",
						unit: "kn",
						value: numberField(payload, "sog"),
					},
					{
						key: "cog",
						label: "Course",
						unit: "deg",
						value: numberField(payload, "cog"),
					},
					{
						key: "shipType",
						label: "Ship type",
						value: numberField(payload, "shipType"),
					},
				],
				{ title, omitKeys: name === undefined ? [] : ["name"] },
			)
	return presentation({
		category: "marine",
		protocol: "ais",
		entityKey: key,
		title,
		position: readPosition(payload),
		fields,
	})
}

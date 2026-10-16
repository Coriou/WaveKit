import type { MeshtasticPacket } from "../../../decoders/builtin/lora-meshtastic.js"
import { isCoalescibleShape } from "../storage/coalesce.js"
import type { DecodePresentation } from "../types.js"
import {
	clampTitle,
	entityKey,
	asNumber,
	numberField,
	objectSchema,
	parsePayload,
	presentation,
	takeFields,
} from "./budget.js"

const meshPayload = objectSchema({
	from: asNumber,
	portnum: asNumber,
	to: asNumber,
	hopLimit: asNumber,
	rxSnr: asNumber,
	rxRssi: asNumber,
})

/** Short names for the Meshtastic PortNum values Activity actually shows. */
const PORT_NAMES: Readonly<Record<number, string>> = {
	0: "Unknown",
	1: "Text",
	2: "Remote hardware",
	3: "Position",
	4: "Node info",
	5: "Routing",
	6: "Admin",
	7: "Compressed text",
	8: "Waypoint",
	9: "Audio",
	10: "Detection sensor",
	32: "Reply",
	33: "IP tunnel",
	34: "Paxcounter",
	64: "Serial",
	65: "Store and forward",
	66: "Range test",
	67: "Telemetry",
	68: "ZPS",
	69: "Simulator",
	70: "Traceroute",
	71: "Neighbor info",
	72: "ATAK",
	73: "Map report",
	74: "Power stress",
	256: "Private",
	257: "ATAK forwarder",
}

/** `!` plus 8 lowercase hex of a uint32 node id (`from >>> 0`). */
export function meshNodeId(from: unknown): string | null {
	if (
		typeof from !== "number" ||
		!Number.isInteger(from) ||
		!Number.isSafeInteger(from)
	)
		return null
	if (from < 0 || from > 0xffffffff) return null
	return `!${(from >>> 0).toString(16).padStart(8, "0")}`
}

function portName(portnum: number | undefined): string {
	if (portnum === undefined) return "Meshtastic"
	return PORT_NAMES[portnum] ?? `Port ${portnum}`
}

/**
 * Mesh packet. Position is omitted: the coordinates live in the protobuf
 * payload, which this mapper does not decode.
 */
export function presentMeshtastic(
	data: unknown,
): DecodePresentation | undefined {
	const payload = parsePayload(meshPayload, data)
	if (!payload) return undefined
	const packet = payload as Partial<MeshtasticPacket>
	const node = meshNodeId(packet.from)
	const portnum = numberField(payload, "portnum")
	const name = portName(portnum === undefined ? undefined : portnum)
	const title = clampTitle(node === null ? name : `${node} ${name}`)
	const fields = isCoalescibleShape("meshtastic", payload)
		? []
		: takeFields(
				[
					{ key: "portnum", label: "Port", value: portnum },
					{ key: "to", label: "To", value: numberField(payload, "to") },
					{
						key: "hops",
						label: "Hops",
						value: numberField(payload, "hopLimit"),
					},
					{
						key: "rxSnr",
						label: "RX SNR",
						unit: "dB",
						value: numberField(payload, "rxSnr"),
					},
					{
						key: "rxRssi",
						label: "RX RSSI",
						unit: "dBm",
						value: numberField(payload, "rxRssi"),
					},
				],
				{ title },
			)
	return presentation({
		category: "mesh",
		protocol: "meshtastic",
		entityKey: node === null ? null : entityKey("node", node),
		title,
		fields,
	})
}

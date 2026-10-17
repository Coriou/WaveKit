import type { MeshtasticPacket } from "../../../decoders/builtin/lora-meshtastic.js"
import { readPosition as readMeshPosition } from "../../meshtastic-protobuf.js"
import { isCoalescibleShape } from "../storage/coalesce.js"
import type { DecodePosition, DecodePresentation } from "../types.js"
import {
	altitudeMetres,
	clampTitle,
	entityKey,
	asNumber,
	numberField,
	objectSchema,
	parsePayload,
	presentation,
	readPosition,
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

/** PortNum POSITION_APP. */
const PORT_POSITION = 3
/** 256 bytes of Position protobuf, as canonical base64 (req 4.4). */
export const MESH_POSITION_MAX_BYTES = 256
export const MESH_POSITION_MAX_B64 = 344
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Strict canonical base64, the mesh tracker's rules with the 256-byte cap:
 * length a multiple of 4, standard alphabet, at most two trailing `=`, and
 * re-encoding gives the same text. Empty is no payload here.
 */
function decodePositionBytes(text: string): Uint8Array | null {
	if (text.length === 0 || text.length > MESH_POSITION_MAX_B64) return null
	if (text.length % 4 !== 0 || !BASE64_RE.test(text)) return null
	const bytes = Buffer.from(text, "base64")
	if (bytes.length > MESH_POSITION_MAX_BYTES) return null
	if (bytes.toString("base64") !== text) return null
	return bytes
}

/**
 * Position of a portnum 3 packet (req 4.4): `lat`/`lon` by the shared rule
 * (finite, in range, not (0, 0)) and `altM` from `altitudeM` (req 4.5).
 * Anything undecodable is no position; never throws.
 */
export function meshPosition(
	portnum: unknown,
	payloadB64: unknown,
): DecodePosition | undefined {
	if (portnum !== PORT_POSITION || typeof payloadB64 !== "string")
		return undefined
	try {
		const bytes = decodePositionBytes(payloadB64)
		if (!bytes) return undefined
		const decoded = readMeshPosition(bytes)
		if (!decoded) return undefined
		return readPosition(
			{ lat: decoded.lat, lon: decoded.lon },
			altitudeMetres(decoded.altitudeM),
		)
	} catch {
		return undefined
	}
}

/**
 * Mesh packet. A POSITION packet (portnum 3) carries the position decoded
 * from `payloadB64`; other ports have none.
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
		position: meshPosition(portnum, payload["payloadB64"]),
		fields,
	})
}

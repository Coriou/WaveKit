import type { FormattedMessage } from "../../data/types.js"
import {
	asObj,
	clipMultiline,
	finish,
	num,
	seg,
	str,
	textGlyphs,
} from "./common.js"

const BROADCAST = 0xffffffff
const PORTS: Readonly<Record<number, string>> = {
	0: "UNKNOWN",
	1: "TEXT",
	2: "REMOTE_HW",
	3: "POS",
	4: "NODE",
	5: "ROUTING",
	6: "ADMIN",
	7: "TEXT_GZIP",
	8: "WAYPOINT",
	9: "AUDIO",
	10: "DETECT",
	32: "REPLY",
	33: "IP_TUN",
	34: "PAXCNTR",
	64: "SERIAL",
	65: "STORE_FWD",
	66: "RANGE_TEST",
	67: "TELEM",
	68: "ZPS",
	69: "SIM",
	70: "TRACE",
	71: "NEIGHBOR",
	72: "ATAK",
	73: "MAP",
	74: "PWRSTRESS",
	257: "PRIVATE",
	258: "ATAK_FWD",
}

const nodeId = (n: number): string =>
	n === BROADCAST ? "BCAST" : `!${(n >>> 0).toString(16).padStart(8, "0")}`

export function isMeshShape(data: unknown): boolean {
	const o = asObj(data)
	return (
		num(o, "from") !== undefined &&
		num(o, "to") !== undefined &&
		num(o, "portnum") !== undefined &&
		str(o, "payloadB64") !== undefined
	)
}

export function formatMesh(
	data: unknown,
	decoderId: string,
	type: string,
): FormattedMessage {
	const o = asObj(data)
	const from = num(o, "from") ?? 0
	const to = num(o, "to") ?? 0
	const port = num(o, "portnum") ?? 0
	const len = num(o, "payloadLen")
	// The wrapper sends 0 when RSSI/SNR are unavailable: unknown, not 0 dBm (T5).
	const rssi = num(o, "rxRssi") || undefined
	const snr = num(o, "rxSnr") || undefined
	const hopStart = num(o, "hopStart")
	const hopLimit = num(o, "hopLimit")
	let text: string | undefined
	if (port === 1) {
		try {
			text = clipMultiline(
				Buffer.from(str(o, "payloadB64") ?? "", "base64").toString("utf8"),
			).trim()
		} catch {
			text = undefined
		}
	}
	const segments = [
		seg(`${nodeId(from)}${textGlyphs().arrow}${nodeId(to)}`, 0),
		seg(PORTS[port] ?? `PORT${port}`, 1),
		...(text === undefined && len !== undefined ? [seg(`${len} B`, 2)] : []),
		...(rssi !== undefined ? [seg(`${rssi} dBm`, 3)] : []),
		...(snr !== undefined ? [seg(`SNR ${snr.toFixed(1)}`, 3)] : []),
		...(hopStart !== undefined && hopLimit !== undefined
			? [seg(`${Math.max(0, hopStart - hopLimit)}/${hopStart} hops`, 4)]
			: []),
	]
	const fields: FormattedMessage["fields"] = [
		{ label: "from", value: nodeId(from) },
		{ label: "to", value: nodeId(to) },
		{ label: "port", value: PORTS[port] ?? `PORT${port}` },
		...(num(o, "frequency") !== undefined
			? [
					{
						label: "frequency",
						value: `${((num(o, "frequency") ?? 0) / 1e6).toFixed(3)} MHz`,
					},
				]
			: []),
	]
	return finish(
		decoderId,
		type,
		"MESH",
		"data",
		segments,
		fields,
		text ? { text } : {},
	)
}

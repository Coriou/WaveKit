import type { ACARSMessage } from "../../../decoders/builtin/acarsdec.js"
import type { VDL2Message } from "../../../decoders/builtin/dumpvdl2.js"
import { z } from "zod"
import type {
	DecodeField,
	DecodePosition,
	DecodePresentation,
} from "../types.js"
import {
	BASIS_TEXT,
	FAMILY_TEXT,
	acarsLabelInfo,
	normalizeAcarsLabel,
	type AcarsLabelBasis,
	type AcarsLabelFamily,
} from "./acars-labels.js"
import {
	LONG_TEXT_BYTES,
	altitudeFromFeet,
	asString,
	canonicalIcao,
	canonicalRegistration,
	childRecord,
	clampTitle,
	entityKey,
	identifierText,
	objectSchema,
	parsePayload,
	presentation,
	stringField,
	takeFields,
	type FieldDraft,
} from "./budget.js"

const acarsBody = z
	.object({
		tail: asString,
		flight: asString,
		label: asString,
		text: asString,
		direction: asString,
	})
	.passthrough()
const acarsPayload = objectSchema({
	tail: asString,
	flight: asString,
	label: asString,
	text: asString,
	direction: asString,
})
const vdl2Payload = objectSchema({
	icao: asString,
	tail: asString,
	flight: asString,
	label: asString,
	text: asString,
	msgType: asString,
	frameType: asString,
	direction: asString,
	groundAddress: asString,
	acars: acarsBody.nullish(),
})

/** One ADS-C position tag as libacars prints it (adsc.c la_adsc_basic_report_format_json). */
const adscReportSchema = z.object({
	lat: z.number().finite().min(-90).max(90),
	lon: z.number().finite().min(-180).max(180),
	alt: z.number().finite().optional(),
})
/** ADS-C tags that carry a basic report (libacars adsc.c, same formatter for each). */
const ADSC_POSITION_TAGS = [
	"basic_report",
	"emerg_basic_report",
	"lat_dev_change_event",
	"vspd_chg_event",
	"alt_range_event",
	"wpt_change_event",
] as const

/** libacars ARINC 622 `msg_type` (arinc.c imi_props json_key) in plain language. */
const ARINC622_MEANING: Readonly<Record<string, string>> = {
	adsc_msg: "ADS-C report",
	adsc_disconnect_request: "ADS-C disconnect",
	fans1a_cpdlc_msg: "CPDLC message",
	fans1a_cpdlc_connect_request: "CPDLC connection request",
	fans1a_cpdlc_connect_confirm: "CPDLC connection confirmed",
	fans1a_cpdlc_disconnect_request: "CPDLC disconnect",
}
/** Other libacars protocols, by their json_key. */
const LIBACARS_MEANING: Readonly<Record<string, string>> = {
	"media-adv": "Media advisory",
	miam: "Compressed message (MIAM)",
	ohma: "Maintenance data (OHMA)",
}

/** VDL2 frames without ACARS: link machinery (AVLC frame types, ICAO Doc 9776). */
const FRAME_MEANING: Readonly<Record<string, string>> = {
	S: "Link supervision",
	U: "Link control",
	I: "Data frame (not ACARS)",
}

const DIRECTION_TEXT: Readonly<Record<string, string>> = {
	downlink: "Air to ground",
	uplink: "Ground to air",
}

interface Reading {
	meaning?: string
	family?: AcarsLabelFamily
	basis: AcarsLabelBasis | "decoded" | "unknown"
	position?: DecodePosition
	positionSource?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The first ADS-C position in a libacars ARINC 622 tree, altitude in metres. */
function adscPosition(
	arinc: Record<string, unknown>,
): DecodePosition | undefined {
	const adsc = childRecord(arinc, "adsc")
	const tags = adsc?.["tags"]
	if (!Array.isArray(tags)) return undefined
	for (const tag of tags) {
		if (!isRecord(tag)) continue
		for (const name of ADSC_POSITION_TAGS) {
			const parsed = adscReportSchema.safeParse(tag[name])
			if (!parsed.success) continue
			const { lat, lon, alt } = parsed.data
			if (lat === 0 && lon === 0) continue
			const altM = altitudeFromFeet(alt)
			return altM === undefined ? { lat, lon } : { lat, lon, altM }
		}
	}
	return undefined
}

/** What the label and any libacars result say about one ACARS message. */
function readAcars(body: Record<string, unknown>): Reading {
	const info = acarsLabelInfo(stringField(body, "label"))
	const reading: Reading = info
		? { meaning: info.name, family: info.family, basis: info.basis }
		: { basis: "unknown" }
	const lib = childRecord(body, "libacars")
	if (lib === undefined) return reading
	const arinc = childRecord(lib, "arinc622")
	if (arinc !== undefined) {
		const type = stringField(arinc, "msg_type")
		const meaning = type === undefined ? undefined : ARINC622_MEANING[type]
		if (meaning !== undefined && arinc["crc_ok"] !== false) {
			reading.meaning = meaning
			reading.family = "air-traffic"
			reading.basis = "decoded"
			const position = adscPosition(arinc)
			if (position !== undefined) {
				reading.position = position
				reading.positionSource = "ADS-C report"
			}
		}
		return reading
	}
	for (const [key, meaning] of Object.entries(LIBACARS_MEANING)) {
		if (lib[key] === undefined) continue
		reading.meaning = meaning
		reading.basis = "decoded"
		if (key === "media-adv") reading.family = "link"
		else reading.family ??= "onboard"
		return reading
	}
	return reading
}

/** ACARS pads registrations to seven characters with leading dots; they are not part of it. */
function displayTail(tail: string | undefined): string | undefined {
	if (tail === undefined) return undefined
	const clean = tail.replace(/^\.+/, "")
	return clean === "" ? undefined : clean
}

function directionText(value: string | undefined): string | undefined {
	return value === undefined ? undefined : DIRECTION_TEXT[value]
}

/** Who, then what: "N0WK01 ZZ0101 · No information to transmit". */
function titleOf(
	who: readonly (string | undefined)[],
	what: string | undefined,
) {
	const name = who.filter(part => part !== undefined).join(" ")
	return clampTitle(
		[name || undefined, what].filter(p => p !== undefined).join(" · "),
	)
}

/**
 * The fields of an ACARS message (at most six). Text gives way to the position source when
 * libacars decoded a position: ADS-C text is an encoded block, not something to read.
 */
function acarsFields(
	body: Record<string, unknown>,
	reading: Reading,
	direction: string | undefined,
	title: string | null,
): DecodeField[] {
	const label = normalizeAcarsLabel(stringField(body, "label"))
	const drafts: FieldDraft[] = [
		{ key: "label", label: "Label", value: label },
		{ key: "meaning", label: "Meaning", value: reading.meaning },
		{
			key: "kind",
			label: "Kind",
			value:
				reading.family === undefined ? undefined : FAMILY_TEXT[reading.family],
		},
		{ key: "basis", label: "Basis", value: BASIS_TEXT[reading.basis] },
		{ key: "direction", label: "Direction", value: directionText(direction) },
		reading.positionSource === undefined
			? {
					key: "text",
					label: "Text",
					value: stringField(body, "text"),
					maxBytes: LONG_TEXT_BYTES,
				}
			: {
					key: "position-source",
					label: "Position from",
					value: reading.positionSource,
				},
	]
	return takeFields(drafts, { title })
}

/**
 * ACARS heard on VHF. The entity is the registration with dots removed. A ground station
 * squitter names no aircraft. Positions come only from a decoded ADS-C report.
 */
export function presentAcars(data: unknown): DecodePresentation | undefined {
	const payload = parsePayload(acarsPayload, data)
	if (!payload) return undefined
	const tail = displayTail(stringField(payload, "tail") as ACARSMessage["tail"])
	const flight = stringField(payload, "flight")
	const tailId = identifierText(payload, "tail")
	const reading = readAcars(payload)
	const fromGround = reading.family === "ground-station"
	const reg =
		tailId === undefined || fromGround ? null : canonicalRegistration(tailId)
	const what = reading.meaning ?? labelText(payload)
	const title = titleOf(fromGround ? ["Ground station"] : [tail, flight], what)
	return presentation({
		category: "aviation-data",
		protocol: "acars",
		entityKey: reg === null ? null : entityKey("reg", reg),
		title,
		position: reading.position,
		fields: acarsFields(
			payload,
			reading,
			stringField(payload, "direction"),
			title,
		),
	})
}

function labelText(body: Record<string, unknown>): string | undefined {
	const label = normalizeAcarsLabel(stringField(body, "label"))
	return label === undefined ? undefined : `Label ${label}`
}

/** XID position: dumpvdl2 rounds it to 0.1 degree and 1000 ft. */
function xidPosition(
	payload: Record<string, unknown>,
): DecodePosition | undefined {
	const xid = childRecord(payload, "xid")
	const loc = xid === undefined ? undefined : childRecord(xid, "acLocation")
	if (loc === undefined) return undefined
	const parsed = adscReportSchema
		.extend({ altFt: z.number().finite().optional() })
		.safeParse(loc)
	if (!parsed.success) return undefined
	const { lat, lon, altFt } = parsed.data
	if (lat === 0 && lon === 0) return undefined
	const altM = altitudeFromFeet(altFt)
	return altM === undefined ? { lat, lon } : { lat, lon, altM }
}

/**
 * VDL2. The entity is the aircraft's ICAO address (the aircraft end of the frame), else the
 * registration of embedded ACARS. A frame between ground stations names no aircraft.
 */
export function presentVdl2(data: unknown): DecodePresentation | undefined {
	const payload = parsePayload(vdl2Payload, data)
	if (!payload) return undefined
	const nested = childRecord(payload, "acars")
	const icaoRaw = identifierText(payload, "icao")
	const icao = icaoRaw === undefined ? null : canonicalIcao(icaoRaw)
	const tailRaw = displayTail(
		stringField(payload, "tail") ??
			(nested ? stringField(nested, "tail") : undefined),
	)
	const tailId =
		identifierText(payload, "tail") ??
		(nested ? identifierText(nested, "tail") : undefined)
	const tail = tailId === undefined ? null : canonicalRegistration(tailId)
	const flight =
		stringField(payload, "flight") ??
		(nested ? stringField(nested, "flight") : undefined)
	const direction =
		stringField(payload, "direction") ??
		(nested ? stringField(nested, "direction") : undefined)
	const key =
		icao !== null
			? entityKey("icao", icao)
			: tail === null
				? null
				: entityKey("reg", tail)
	const who = tailRaw ?? icao ?? undefined

	if (nested !== undefined) {
		const reading = readAcars(nested)
		const title = titleOf(
			reading.family === "ground-station" ? ["Ground station"] : [who, flight],
			reading.meaning ?? labelText(nested),
		)
		return presentation({
			category: "aviation-data",
			protocol: "vdl2",
			entityKey: key,
			title,
			position: reading.position,
			fields: acarsFields(nested, reading, direction, title),
		})
	}

	const msgType: VDL2Message["msgType"] | undefined = stringField(
		payload,
		"msgType",
	)
	const frameType = stringField(payload, "frameType")
	const xid = childRecord(payload, "xid")
	const meaning =
		xid !== undefined
			? (stringField(xid, "typeDescr") ?? "Link establishment")
			: frameType === undefined
				? msgType
				: (FRAME_MEANING[frameType] ?? msgType)
	const position = xidPosition(payload)
	const title = titleOf(
		[who ?? (direction === "uplink" ? "Ground station" : undefined)],
		meaning,
	)
	const fields = takeFields(
		[
			{ key: "frame", label: "Frame", value: frameType },
			{ key: "meaning", label: "Meaning", value: meaning },
			{ key: "kind", label: "Kind", value: FAMILY_TEXT.link },
			{ key: "direction", label: "Direction", value: directionText(direction) },
			{
				key: "destination",
				label: "Destination",
				value: xid === undefined ? undefined : stringField(xid, "dstAirport"),
			},
			position === undefined
				? {
						key: "ground-station",
						label: "Ground station",
						value: stringField(payload, "groundAddress"),
					}
				: {
						key: "position-source",
						label: "Position from",
						value: "VDL2 link frame (±0.1°)",
					},
		],
		{ title },
	)
	return presentation({
		category: "aviation-data",
		protocol: "vdl2",
		entityKey: key,
		title,
		position,
		fields,
	})
}

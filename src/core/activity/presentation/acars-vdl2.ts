import type { ACARSMessage } from "../../../decoders/builtin/acarsdec.js"
import type { VDL2Message } from "../../../decoders/builtin/dumpvdl2.js"
import type { DecodePresentation } from "../types.js"
import {
	LONG_TEXT_BYTES,
	canonicalIcao,
	canonicalRegistration,
	childRecord,
	clampTitle,
	entityKey,
	presentation,
	readPayload,
	stringField,
	takeFields,
} from "./budget.js"

function textFields(
	payload: Record<string, unknown>,
	nested: Record<string, unknown> | undefined,
	title: string | null,
) {
	const flight =
		stringField(payload, "flight") ??
		(nested ? stringField(nested, "flight") : undefined)
	const label =
		stringField(payload, "label") ??
		(nested ? stringField(nested, "label") : undefined)
	const text =
		stringField(payload, "text") ??
		(nested ? stringField(nested, "text") : undefined)
	return takeFields(
		[
			{ key: "flight", label: "Flight", value: flight },
			{ key: "label", label: "Label", value: label },
			{ key: "text", label: "Text", value: text, maxBytes: LONG_TEXT_BYTES },
		],
		{ title },
	)
}

/** ACARS. The entity is the tail with dots removed; there is no map position. */
export function presentAcars(data: unknown): DecodePresentation | undefined {
	const payload = readPayload(data)
	if (!payload) return undefined
	const tail = stringField(payload, "tail") as ACARSMessage["tail"]
	const flight = stringField(payload, "flight")
	const label = stringField(payload, "label")
	const reg = tail === undefined ? null : canonicalRegistration(tail)
	const who = tail ?? flight
	const title = clampTitle(
		[who, label].filter(part => part !== undefined).join(" "),
	)
	return presentation({
		category: "aviation-data",
		protocol: "acars",
		entityKey: reg === null ? null : entityKey("reg", reg),
		title,
		fields: textFields(payload, undefined, title),
	})
}

/** VDL2. ICAO wins over an embedded ACARS tail. No map position. */
export function presentVdl2(data: unknown): DecodePresentation | undefined {
	const payload = readPayload(data)
	if (!payload) return undefined
	const nested = childRecord(payload, "acars")
	const icaoRaw = stringField(payload, "icao")
	const icao = icaoRaw === undefined ? null : canonicalIcao(icaoRaw)
	const tailRaw =
		stringField(payload, "tail") ??
		(nested ? stringField(nested, "tail") : undefined)
	const tail = tailRaw === undefined ? null : canonicalRegistration(tailRaw)
	const flight =
		stringField(payload, "flight") ??
		(nested ? stringField(nested, "flight") : undefined)
	const who = icao ?? tailRaw ?? flight
	const msgType: VDL2Message["msgType"] | undefined = stringField(
		payload,
		"msgType",
	)
	const title = clampTitle(
		[who, msgType].filter(part => part !== undefined).join(" "),
	)
	const key =
		icao !== null
			? entityKey("icao", icao)
			: tail === null
				? null
				: entityKey("reg", tail)
	return presentation({
		category: "aviation-data",
		protocol: "vdl2",
		entityKey: key,
		title,
		fields: textFields(payload, nested, title),
	})
}

import type { DsdFmeVoiceCallState } from "../../../decoders/builtin/dsd-fme.js"
import type { DigitalVoiceCall } from "../../digital-voice.js"
import type { DecodePresentation } from "../types.js"
import {
	childRecord,
	clampTitle,
	entityKey,
	integerField,
	numberField,
	presentation,
	readPayload,
	safeProtocol,
	stringField,
	takeFields,
} from "./budget.js"

function nestedNumber(
	payload: Record<string, unknown>,
	objectKey: string,
	field: string,
): number | undefined {
	const child = childRecord(payload, objectKey)
	if (!child) return undefined
	return numberField(child, field)
}

function nestedString(
	payload: Record<string, unknown>,
	objectKey: string,
	field: string,
): string | undefined {
	const child = childRecord(payload, objectKey)
	if (!child) return undefined
	return stringField(child, field)
}

/**
 * Digital voice call. The key is the talkgroup; colour code prefers the flat
 * contract field and falls back to `dmr.cc` / `p25.nac` already on the output.
 */
export function presentVoice(data: unknown): DecodePresentation | undefined {
	const payload = readPayload(data)
	if (!payload) return undefined
	const call = payload as Partial<DigitalVoiceCall> &
		Partial<DsdFmeVoiceCallState>
	const protocolRaw =
		typeof call.protocol === "string" ? call.protocol : undefined
	const protocol =
		protocolRaw === undefined ? undefined : safeProtocol(protocolRaw)
	const talkgroup = integerField(payload, "talkgroup")
	const source = integerField(payload, "source")
	const label =
		protocolRaw === undefined ? "Voice" : protocolRaw.trim().toUpperCase()
	let titleText = label === "" ? "Voice" : label
	if (talkgroup !== undefined) titleText += ` TG ${talkgroup}`
	if (source !== undefined) titleText += ` from ${source}`
	const title = clampTitle(titleText)
	const colour =
		numberField(payload, "colourCode") ?? nestedNumber(payload, "dmr", "cc")
	const nac = stringField(payload, "nac") ?? nestedString(payload, "p25", "nac")
	return presentation({
		category: "voice",
		protocol,
		entityKey:
			talkgroup === undefined
				? null
				: entityKey("talkgroup", String(talkgroup)),
		title,
		fields: takeFields(
			[
				{ key: "talkgroup", label: "Talkgroup", value: talkgroup },
				{ key: "source", label: "Radio", value: source },
				{ key: "slot", label: "Slot", value: integerField(payload, "slot") },
				{ key: "encrypted", label: "Encrypted", value: payload["encrypted"] },
				{
					key: "duration",
					label: "Duration",
					unit: "ms",
					value: numberField(payload, "duration"),
				},
				{ key: "colourCode", label: "Colour code", value: colour },
				{ key: "nac", label: "NAC", value: nac },
			],
			{ title },
		),
	})
}

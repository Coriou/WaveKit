import type { DsdFmeVoiceCallState } from "../../../decoders/builtin/dsd-fme.js"
import type { DigitalVoiceCall } from "../../digital-voice.js"
import { z } from "zod"
import type { DecodePresentation } from "../types.js"
import {
	asNumber,
	asScalar,
	asString,
	childRecord,
	clampTitle,
	entityKey,
	integerField,
	numberField,
	objectSchema,
	parsePayload,
	presentation,
	safeProtocol,
	stringField,
	takeFields,
} from "./budget.js"

const voicePayload = objectSchema({
	protocol: asString,
	talkgroup: asNumber,
	source: asNumber,
	slot: asNumber,
	encrypted: asScalar,
	duration: asNumber,
	colourCode: asNumber,
	nac: asString,
	dmr: z.object({ cc: asNumber }).passthrough().nullish(),
	p25: z.object({ nac: asString }).passthrough().nullish(),
	dstar: z
		.object({ my: asString, ur: asString, rpt1: asString, rpt2: asString })
		.passthrough()
		.nullish(),
	ysf: z.object({ callsign: asString }).passthrough().nullish(),
})

/** dsd-fme protocols whose calls have no talkgroup or numeric source. */
const NO_TALKGROUP_PROTOCOLS: ReadonlySet<string> = new Set([
	"DSTAR",
	"YSF",
	"DPMR",
	"PROVOICE",
	// NXDN calls heard by RAN alone, before a VCALL names the units.
	"NXDN48",
	"NXDN96",
])

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
 * Digital voice call. The key is the talkgroup, or the calling station's
 * callsign for D-STAR (MY) and YSF (source), which have no talkgroup; colour
 * code prefers the flat contract field and falls back to `dmr.cc` /
 * `p25.nac` already on the output.
 */
export function presentVoice(data: unknown): DecodePresentation | undefined {
	const payload = parsePayload(voicePayload, data)
	if (!payload) return undefined
	const call = payload as Partial<DigitalVoiceCall> &
		Partial<DsdFmeVoiceCallState>
	const protocolRaw =
		typeof call.protocol === "string" ? call.protocol : undefined
	const protocol =
		protocolRaw === undefined ? undefined : safeProtocol(protocolRaw)
	const callsign =
		nestedString(payload, "dstar", "my") ??
		nestedString(payload, "ysf", "callsign")
	const urCall = nestedString(payload, "dstar", "ur")
	const label =
		protocolRaw === undefined ? "Voice" : protocolRaw.trim().toUpperCase()
	// dsd-fme calls of protocols without talkgroups carry 0 / 0 placeholders.
	const talkgroupRaw = integerField(payload, "talkgroup")
	const sourceRaw = integerField(payload, "source")
	const placeholders =
		NO_TALKGROUP_PROTOCOLS.has(label) && talkgroupRaw === 0 && sourceRaw === 0
	const talkgroup = placeholders ? undefined : talkgroupRaw
	const source = placeholders ? undefined : sourceRaw
	let titleText = label === "" ? "Voice" : label
	if (talkgroup !== undefined) titleText += ` TG ${talkgroup}`
	if (source !== undefined) titleText += ` from ${source}`
	else if (callsign !== undefined) titleText += ` from ${callsign}`
	if (urCall !== undefined && urCall !== "") titleText += ` to ${urCall}`
	const title = clampTitle(titleText)
	const colour =
		numberField(payload, "colourCode") ?? nestedNumber(payload, "dmr", "cc")
	const nac = stringField(payload, "nac") ?? nestedString(payload, "p25", "nac")
	return presentation({
		category: "voice",
		protocol,
		entityKey:
			talkgroup !== undefined
				? entityKey("talkgroup", String(talkgroup))
				: callsign !== undefined
					? entityKey("callsign", callsign)
					: null,
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
				{ key: "callsign", label: "Callsign", value: callsign },
				{ key: "destination", label: "To", value: urCall || undefined },
				{
					key: "repeater1",
					label: "RPT1",
					value: nestedString(payload, "dstar", "rpt1") || undefined,
				},
				{
					key: "repeater2",
					label: "RPT2",
					value: nestedString(payload, "dstar", "rpt2") || undefined,
				},
			],
			{ title },
		),
	})
}

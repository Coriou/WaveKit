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
	p25: z
		.object({ nac: asString, unitTarget: asNumber })
		.passthrough()
		.nullish(),
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

/** A voice call's title when nothing names who or to whom. */
export const VOICE_CALL_TITLE = "Voice call"

/**
 * A voice call's title: who, then to whom when known, never the protocol (the row's `protocol`
 * names it): `TG 2081 · radio 3120001` (a talkgroup call), `radio 1 → unit 2` (unit to unit),
 * `N0CALL → CQCQCQ` (D-STAR MY and UR), `N0CALL` (YSF), else VOICE_CALL_TITLE.
 */
export function voiceCallTitle(call: {
	talkgroup?: number | undefined
	unitTarget?: number | undefined
	from?: string | undefined
	to?: string | undefined
}): string {
	if (call.talkgroup !== undefined)
		return call.from === undefined
			? `TG ${call.talkgroup}`
			: `TG ${call.talkgroup} · ${call.from}`
	const to = call.unitTarget !== undefined ? `unit ${call.unitTarget}` : call.to
	if (call.from !== undefined)
		return to === undefined ? call.from : `${call.from} → ${to}`
	return to === undefined ? VOICE_CALL_TITLE : `${VOICE_CALL_TITLE} → ${to}`
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
	// A P25 unit to unit call targets a unit: it has no talkgroup.
	const unitTarget = nestedNumber(payload, "p25", "unitTarget")
	const talkgroup =
		placeholders || unitTarget !== undefined ? undefined : talkgroupRaw
	const source = placeholders ? undefined : sourceRaw
	const title = clampTitle(
		voiceCallTitle({
			talkgroup,
			unitTarget,
			from:
				source !== undefined
					? `radio ${source}`
					: callsign !== undefined && callsign !== ""
						? callsign
						: undefined,
			to: urCall !== undefined && urCall !== "" ? urCall : undefined,
		}),
	)
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
				{ key: "unitTarget", label: "Target unit", value: unitTarget },
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

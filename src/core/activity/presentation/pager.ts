import type { DecodePresentation } from "../types.js"
import {
	LONG_TEXT_BYTES,
	canonicalCallsign,
	canonicalCapcode,
	clampTitle,
	entityKey,
	integerField,
	presentation,
	readPayload,
	safeProtocol,
	stringField,
	takeFields,
} from "./budget.js"

type TextualType = "message" | "decode"

function family(protocol: string | undefined): string | undefined {
	if (protocol === undefined) return undefined
	if (/^pocsag/i.test(protocol)) return "pocsag"
	if (/^flex$/i.test(protocol)) return "flex"
	if (/^eas$/i.test(protocol)) return "eas"
	if (/^dtmf$/i.test(protocol)) return "dtmf"
	if (/^fsk9600$/i.test(protocol)) return "fsk9600"
	if (/^afsk1200$/i.test(protocol)) return "afsk1200"
	return undefined
}

/** POCSAG, FLEX, EAS, DTMF, FSK9600 and AFSK1200 textual decodes. */
export function presentTextual(
	type: TextualType,
	data: unknown,
): DecodePresentation | undefined {
	const payload = readPayload(data)
	if (!payload) return undefined
	const rawProtocol = stringField(payload, "protocol")
	const kind = family(rawProtocol)
	if (kind === undefined) return undefined
	if (
		(kind === "pocsag" || kind === "flex") &&
		(type === "message" || type === "decode")
	)
		return presentPage(payload, kind, rawProtocol ?? kind)
	if (kind === "eas" && type === "message")
		return presentation({
			category: "other",
			protocol: "eas",
			title: clampTitle(rawProtocol ?? "EAS"),
		})
	if ((kind === "dtmf" || kind === "fsk9600") && type === "decode")
		return presentation({
			category: "other",
			protocol: safeProtocol(kind),
			title: clampTitle(rawProtocol ?? kind),
		})
	if (kind === "afsk1200" && type === "decode") return presentAfsk(payload)
	return undefined
}

function presentPage(
	payload: Record<string, unknown>,
	kind: "pocsag" | "flex",
	rawProtocol: string,
): DecodePresentation {
	const cap = canonicalCapcode(payload["address"] ?? payload["capcode"])
	const message = stringField(payload, "message")
	const preview = message === undefined ? "" : message.slice(0, 40)
	const title = clampTitle(
		[rawProtocol, cap ?? "", preview].filter(part => part !== "").join(" "),
	)
	return presentation({
		category: "paging",
		protocol: kind,
		entityKey: cap === null ? null : entityKey("capcode", cap),
		title,
		fields: takeFields(
			[
				{
					key: "message",
					label: "Message",
					value: message,
					maxBytes: LONG_TEXT_BYTES,
				},
				{
					key: "function",
					label: "Function",
					value: integerField(payload, "function"),
				},
				{
					key: "messageType",
					label: "Message type",
					value: stringField(payload, "messageType"),
				},
			],
			{ title },
		),
	})
}

function presentAfsk(payload: Record<string, unknown>): DecodePresentation {
	const from = stringField(payload, "from")
	const to = stringField(payload, "to")
	const call = from === undefined ? null : canonicalCallsign(from)
	const title = clampTitle(
		[from, to].filter(part => part !== undefined).join(" → "),
	)
	return presentation({
		category: "aprs",
		protocol: "afsk1200",
		entityKey: call === null ? null : entityKey("callsign", call),
		title,
	})
}

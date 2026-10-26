import type { DecodePresentation } from "../types.js"
import {
	LONG_TEXT_BYTES,
	canonicalCallsign,
	identifierText,
	canonicalCapcode,
	clampTitle,
	entityKey,
	asNumber,
	asNumberOrString,
	asString,
	integerField,
	objectSchema,
	parsePayload,
	presentation,
	safeProtocol,
	stringField,
	takeFields,
} from "./budget.js"

const textualPayload = objectSchema({
	protocol: asString,
	address: asNumberOrString,
	capcode: asNumberOrString,
	message: asString,
	function: asNumber,
	messageType: asString,
	from: asString,
	to: asString,
})

// Keep marker regexes and sanitisation in sync with web/src/features/activity/pager-detail.ts.
// multimon-ng pocsag.c trtab: ASCII 0..31 plus DEL (127).
// https://github.com/EliasOenal/multimon-ng/blob/master/pocsag.c
const PAGER_MARKERS =
	/<(NUL|SOH|STX|ETX|EOT|ENQ|ACK|BEL|BS|HT|LF|VT|FF|CR|SO|SI|DLE|DC1|DC2|DC3|DC4|NAK|SYN|ETB|CAN|EM|SUB|ESC|FS|GS|RS|US|DEL)>/g

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
	const payload = parsePayload(textualPayload, data)
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
	const rawMessage = payload["message"]
	const message =
		typeof rawMessage === "string"
			? rawMessage
					.replace(/<(LF|CR|HT|VT|FF|RS|US)>|[\n\r\t\v\f\u001e\u001f]/g, " ")
					.replace(PAGER_MARKERS, "")
					.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
					.replace(/\s+/g, " ")
					.trim()
			: undefined
	const toneOnly = integerField(payload, "function") === 0 && !message
	const preview = message === undefined ? "" : message.slice(0, 40)
	const title = clampTitle(
		[rawProtocol, cap ?? "", toneOnly ? "tone only" : preview]
			.filter(part => part !== "")
			.join(" "),
	)
	return presentation({
		category: "paging",
		protocol: kind,
		entityKey: cap === null ? null : entityKey("capcode", cap),
		title,
		fields: takeFields(
			[
				{
					key: "label",
					label: "Label",
					value: toneOnly ? "tone only" : undefined,
				},
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
	const from = identifierText(payload, "from")
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

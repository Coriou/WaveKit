import type { APRSData } from "../../../decoders/builtin/direwolf.js"
import {
	APRS_POSITION_DATA_TYPES,
	isCoalescibleShape,
} from "../storage/coalesce.js"
import type { DecodePresentation } from "../types.js"
import {
	APRS_TEXT_BYTES,
	canonicalCallsign,
	type FieldDraft,
	childRecord,
	clampTitle,
	entityKey,
	numberField,
	presentation,
	readPayload,
	readPosition,
	stringField,
	takeFields,
} from "./budget.js"

function messageText(payload: Record<string, unknown>): string | undefined {
	const message = payload["message"]
	if (typeof message === "string") return message
	const body = childRecord(payload, "message")
	if (!body) return undefined
	return stringField(body, "text")
}

/** Station, object and item packets. Position only for the six position types, or an object/item. */
export function presentAprs(data: unknown): DecodePresentation | undefined {
	const payload = readPayload(data)
	if (!payload) return undefined
	const aprs = payload as Partial<APRSData>
	const dataType = stringField(payload, "dataType")
	const objectName = stringField(payload, "objectName")
	const objectKind = aprs.objectKind
	const source = stringField(payload, "source")
	const call = source === undefined ? null : canonicalCallsign(source)
	let key: string | null = null
	let titleText = ""
	if (objectName !== undefined) {
		if (objectKind === "object" || objectKind === "item") {
			key = entityKey(
				objectKind === "object" ? "aprs-object" : "aprs-item",
				objectName,
			)
			titleText = `${objectName} ${objectKind}`
		} else titleText = objectName
	} else {
		if (call !== null) key = entityKey("callsign", call)
		titleText = [call, dataType]
			.filter(value => value !== undefined && value !== null)
			.join(" ")
	}
	const titled = clampTitle(titleText)
	const positioned =
		objectName !== undefined ||
		(dataType !== undefined && APRS_POSITION_DATA_TYPES.has(dataType))
	const comment =
		stringField(payload, "comment") ?? stringField(payload, "status")
	const commentLabel = dataType === "Status" ? "Status" : "Comment"
	const message = messageText(payload)
	// One long string: summary, record and FTS each store it beside an
	// 80-character title, and two of them exceed the 1,100-byte row bound.
	const longText: FieldDraft =
		message !== undefined
			? {
					key: "message",
					label: "Message",
					value: message,
					maxBytes: APRS_TEXT_BYTES,
				}
			: {
					key: "comment",
					label: commentLabel,
					value: comment,
					maxBytes: APRS_TEXT_BYTES,
				}
	const fields = isCoalescibleShape("aprs", payload)
		? []
		: takeFields(
				[
					{ key: "dataType", label: "Data type", value: dataType },
					{
						key: "symbol",
						label: "Symbol",
						value: stringField(payload, "symbol"),
					},
					longText,
					{
						key: "course",
						label: "Course",
						unit: "deg",
						value: numberField(payload, "course"),
					},
					{
						key: "speed",
						label: "Speed",
						unit: "kn",
						value: numberField(payload, "speed"),
					},
				],
				{ title: titled },
			)
	return presentation({
		category: "aprs",
		protocol: "aprs",
		entityKey: key,
		title: titled,
		position: positioned ? readPosition(payload) : undefined,
		fields,
	})
}

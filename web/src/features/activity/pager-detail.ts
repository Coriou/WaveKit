import type { ActivityRecord, ActivitySummary } from "@wavekit/api-types"

// multimon-ng pocsag.c trtab: ASCII 0..31 and 127, represented as names.
const MARKERS =
	/<(NUL|SOH|STX|ETX|EOT|ENQ|ACK|BEL|BS|HT|LF|VT|FF|CR|SO|SI|DLE|DC1|DC2|DC3|DC4|NAK|SYN|ETB|CAN|EM|SUB|ESC|FS|GS|RS|US|DEL)>/g

/** Expand only the detail body; the stored record, list and title stay intact. */
export function pagerDetailItem(
	item: ActivitySummary,
	record: ActivityRecord | null,
): ActivitySummary {
	if (item.category !== "paging" || record?.kind !== "decoder-reception")
		return item
	const raw = record.payload.decodedData
	if (
		typeof raw !== "object" ||
		raw === null ||
		Array.isArray(raw) ||
		!("message" in raw)
	)
		return item
	const message = raw["message"]
	if (typeof message !== "string") return item
	const clean = message
		.replace(MARKERS, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
		.trim()
	const field = item.fields.find(f => f.key === "message")
	if (
		typeof field?.value !== "string" ||
		!field.value.endsWith("…") ||
		clean === field.value
	)
		return item
	return {
		...item,
		fields: item.fields.map(f =>
			f.key === "message" ? { ...f, value: clean } : f,
		),
	}
}

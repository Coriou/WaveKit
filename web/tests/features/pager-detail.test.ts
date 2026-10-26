import { expect, it } from "vitest"
import type { ActivityRecord, ActivitySummary } from "@wavekit/api-types"
import { pagerDetailItem } from "../../src/features/activity/pager-detail.ts"
import { rowView } from "../../src/features/activity/rows.ts"
import { messageView } from "../../src/features/messages/card.ts"

function fixture(message: string, presented: string) {
	const item: ActivitySummary = {
		eventId: "synthetic",
		commitSeq: "1",
		kind: "decoder-reception",
		producedAt: "2026-10-01T00:00:00Z",
		receivedAt: "2026-10-01T00:00:00Z",
		decoderId: "synthetic",
		sourceId: null,
		protocol: "pocsag",
		category: "paging",
		frequencyHz: null,
		entityKey: null,
		title: "Synthetic page…",
		fields: [{ key: "message", label: "Message", value: presented }],
	}
	const record: ActivityRecord = {
		version: 1,
		eventId: item.eventId,
		commitSeq: item.commitSeq,
		producedAt: item.producedAt,
		receivedAt: item.receivedAt,
		kind: "decoder-reception",
		payload: {
			version: 1,
			eventId: item.eventId,
			producedAt: item.producedAt,
			receivedAt: item.receivedAt,
			decoderId: "synthetic",
			outputType: "message",
			protocol: item.protocol,
			category: item.category,
			title: item.title,
			entityKey: null,
			fields: item.fields,
			provenance: { sourceId: null, frequency: null },
			decodedData: { message },
		},
	}
	return { item, record }
}
it.each([126, 127, 500])(
	"expands clipped pager detail at %i bytes while leaving the list and title clipped",
	length => {
		const message = "S".repeat(length)
		const presented = length > 126 ? `${message.slice(0, 123)}…` : message
		const { item, record } = fixture(message, presented)
		const detail = pagerDetailItem(item, record)
		expect(messageView(detail, record).text).toBe(message)
		expect(rowView(item).message).toBe(presented)
		expect(detail.title).toBe(item.title)
		expect(record.payload.decodedData).toEqual({ message })
	},
)
it("strips every multimon control marker from the expanded body", () => {
	const names =
		"NUL SOH STX ETX EOT ENQ ACK BEL BS HT LF VT FF CR SO SI DLE DC1 DC2 DC3 DC4 NAK SYN ETB CAN EM SUB ESC FS GS RS US DEL".split(
			" ",
		)
	const message = `Synthetic${names.map(n => `<${n}>`).join("")} body<EOT>`
	const { item, record } = fixture(message, "Synthetic…")
	expect(rowView(pagerDetailItem(item, record)).message).toBe("Synthetic body")
	expect(pagerDetailItem(item, null)).toBe(item)
})
it("treats a network beacon as a notice without a tone-only reception body", () => {
	const { item } = fixture("", "")
	item.fields = [{ key: "label", label: "Label", value: "network beacon" }]
	const view = messageView(item)
	expect(view.notice).toBe(true)
	expect(view.toneOnly).toBe(false)
})

import { describe, expect, it } from "vitest"
import {
	ACTIVITY_RECORD_VERSION,
	MAX_INDEXED_TEXT_BYTES,
} from "../../../../../src/core/activity/storage/contract.js"
import {
	buildActivityRow,
	truncateUtf8,
} from "../../../../../src/core/activity/storage/row.js"
import { envelope } from "./helpers.js"

function fts(decodedData: Record<string, string>): string {
	const payload = envelope({ eventId: "fts-utf8", decodedData })
	return buildActivityRow({
		version: ACTIVITY_RECORD_VERSION,
		eventId: payload.eventId,
		commitSeq: "0",
		producedAt: payload.producedAt,
		receivedAt: payload.receivedAt,
		kind: "decoder-reception",
		payload,
	}).ftsText
}

describe("indexed text truncation", () => {
	it("cuts a two-byte character that straddles the 8 KiB cap instead of storing U+FFFD", () => {
		for (let pad = 8_150; pad <= 8_200; pad++) {
			const text = fts({ icao: "ABCDEF", padding: `${"x".repeat(pad)}éz` })
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
				MAX_INDEXED_TEXT_BYTES,
			)
			expect(text).not.toContain("�")
		}
		const reported = fts({ icao: "ABCDEF", padding: `${"x".repeat(8_171)}éz` })
		expect(Buffer.byteLength(reported, "utf8")).toBeLessThanOrEqual(8_192)
		expect(reported).not.toContain("�")
	})

	it("keeps a character that ends on the cap and drops one that would cross it", () => {
		expect(truncateUtf8("aé", 3)).toBe("aé")
		expect(truncateUtf8("aéb", 3)).toBe("aé")
		expect(truncateUtf8("aé", 2)).toBe("a")
		expect(truncateUtf8("a😀", 4)).toBe("a")
		expect(truncateUtf8("a😀", 5)).toBe("a😀")
		expect(truncateUtf8("€€", 4)).toBe("€")
	})
})

import { RECORDINGS_CURSOR_MAX_LENGTH } from "@wavekit/api-types"
import type { RecordingInventoryItem } from "@wavekit/api-types"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	compareEntries,
	decodeCursor,
	encodeCursor,
	paginate,
} from "../../../../src/core/recordings/cursor.js"
import type { InventoryEntry } from "../../../../src/core/recordings/cursor.js"
import { parseInventoryQuery } from "../../../../src/core/recordings/cursor.js"
import { RECORDINGS_ID_MAX_LENGTH } from "../../../../src/core/recordings/inventory.js"

const ID = "dsd:0~20250101_120000_00001_a.wav"

function b64(o: unknown): string {
	return Buffer.from(JSON.stringify(o)).toString("base64url")
}

function entry(
	mtimeMs: number,
	id: string,
	kind: RecordingInventoryItem["kind"] = "dsd-fme-call",
	decoderId: string | null = "d1",
): InventoryEntry {
	return {
		mtimeMs,
		item: {
			id,
			kind,
			decoderId,
			discoveryId: null,
			startedAtLocal: null,
			modifiedAt: new Date(mtimeMs).toISOString(),
			bytes: 1,
			durationMs: null,
			callType: null,
			talkgroup: null,
			source: null,
			frequencyHz: null,
		},
	}
}

describe("cursor codec", () => {
	it("roundtrips", () => {
		expect(decodeCursor(encodeCursor({ m: 1700000000123, i: ID }))).toEqual({
			m: 1700000000123,
			i: ID,
		})
	})
	it("refuses bad input", () => {
		expect(decodeCursor("A".repeat(513))).toBeNull()
		expect(decodeCursor("ab+/=")).toBeNull()
		expect(decodeCursor("")).toBeNull()
		expect(decodeCursor("bm90anNvbg")).toBeNull()
		expect(decodeCursor(b64({ m: 1, i: ID, x: 1 }))).toBeNull()
		expect(decodeCursor(b64({ m: "1", i: ID }))).toBeNull()
		expect(decodeCursor(b64({ m: null, i: ID }))).toBeNull()
		expect(decodeCursor(b64({ m: 1, i: "dsd:0~../x.wav" }))).toBeNull()
		expect(decodeCursor(b64({ m: 1, i: "../../etc/passwd" }))).toBeNull()
		expect(decodeCursor(b64([1, ID]))).toBeNull()
	})
})

describe("parseInventoryQuery", () => {
	it("defaults", () => {
		const d = { limit: 50, cursor: null, kind: null, decoderId: null }
		expect(parseInventoryQuery(undefined)).toEqual(d)
		expect(parseInventoryQuery(null)).toEqual(d)
		expect(parseInventoryQuery({})).toEqual(d)
	})
	it("accepts strings and typed values", () => {
		const cursor = encodeCursor({ m: 5, i: ID })
		expect(
			parseInventoryQuery({
				limit: "200",
				cursor,
				kind: "scanner-dv",
				decoderId: "x",
			}),
		).toEqual({
			limit: 200,
			cursor: { m: 5, i: ID },
			kind: "scanner-dv",
			decoderId: "x",
		})
		expect(parseInventoryQuery({ limit: 7 })?.limit).toBe(7)
	})
	it("refuses invalid queries", () => {
		for (const limit of ["10abc", "1e2", " 5", "0", "201", "", "-1", "05"])
			expect(parseInventoryQuery({ limit })).toBeNull()
		for (const limit of [0, 201, 1.5, Number.NaN])
			expect(parseInventoryQuery({ limit })).toBeNull()
		expect(parseInventoryQuery({ cursor: "!!" })).toBeNull()
		expect(parseInventoryQuery({ kind: "nope" })).toBeNull()
		expect(parseInventoryQuery({ decoderId: "" })).toBeNull()
		expect(parseInventoryQuery({ decoderId: "x".repeat(129) })).toBeNull()
		expect(parseInventoryQuery({ foo: "1" })).toBeNull()
		expect(parseInventoryQuery({ limit: ["1", "2"] })).toBeNull()
		expect(parseInventoryQuery({ kind: ["scanner-dv"] })).toBeNull()
		expect(parseInventoryQuery("limit=1")).toBeNull()
		expect(parseInventoryQuery([])).toBeNull()
		expect(parseInventoryQuery(JSON.parse('{"__proto__":{"a":1}}'))).toBeNull()
	})
})

describe("paginate", () => {
	const sorted = [
		entry(30, "scan:d_1~a.wav", "scanner-dv", null),
		entry(20, "dsd:0~20250101_120000_00001_a.wav"),
		entry(20, "dsd:0~20250101_120000_00002_a.wav", "dsd-fme-call", "d2"),
		entry(10, "dsd:0~20250101_120000_00003_a.wav"),
	]
	const base = { limit: 50, cursor: null, kind: null, decoderId: null }
	it("orders by mtime desc then id asc", () => {
		const shuffled = [sorted[3]!, sorted[2]!, sorted[0]!, sorted[1]!]
		expect([...shuffled].sort(compareEntries)).toEqual(sorted)
	})
	it("filters", () => {
		expect(
			paginate(sorted, { ...base, kind: "scanner-dv" }).items,
		).toHaveLength(1)
		expect(paginate(sorted, { ...base, decoderId: "d2" }).items).toHaveLength(1)
	})
	it("continues after a vanished cursor item", () => {
		const cursor = { m: 20, i: "dsd:0~20250101_120000_00001_b.wav" }
		const r = paginate(sorted, { ...base, cursor })
		expect(r.items.map(x => x.id)).toEqual([
			"dsd:0~20250101_120000_00002_a.wav",
			"dsd:0~20250101_120000_00003_a.wav",
		])
		expect(r.nextCursor).toBeNull()
	})
	it("emits nextCursor only when more remain", () => {
		const r = paginate(sorted, { ...base, limit: 4 })
		expect(r.nextCursor).toBeNull()
		expect(paginate(sorted, { ...base, limit: 3 }).nextCursor).not.toBeNull()
	})

	// Feature: web-gaps-8, Property 9: Paging is a partition
	// Validates: Requirements 4.4
	it("property: following nextCursor yields every filtered item once, in order", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 0, max: 9999 }), { maxLength: 60 }),
				fc.array(fc.integer({ min: 0, max: 5 }), {
					minLength: 60,
					maxLength: 60,
				}),
				fc.integer({ min: 1, max: 200 }),
				fc.constantFrom(null, "dsd-fme-call" as const, "scanner-dv" as const),
				fc.constantFrom(null, "d1", "d2"),
				(ns, ms, limit, kind, decoderId) => {
					const entries = ns.map((n, idx) =>
						entry(
							ms[idx] ?? 0,
							`dsd:0~20250101_120000_${String(n).padStart(5, "0")}_x.wav`,
							n % 3 === 0 ? "scanner-dv" : "dsd-fme-call",
							n % 2 === 0 ? "d1" : "d2",
						),
					)
					const sortedE = [...entries].sort(compareEntries)
					const want = sortedE
						.filter(
							e =>
								(kind === null || e.item.kind === kind) &&
								(decoderId === null || e.item.decoderId === decoderId),
						)
						.map(e => e.item.id)
					const got: string[] = []
					let q = {
						limit,
						cursor: null as { m: number; i: string } | null,
						kind,
						decoderId,
					}
					for (let guard = 0; guard < 100; guard++) {
						const page = paginate(sortedE, q)
						got.push(...page.items.map(x => x.id))
						if (page.nextCursor === null) break
						q = { ...q, cursor: decodeCursor(page.nextCursor) }
						expect(q.cursor).not.toBeNull()
					}
					expect(got).toEqual(want)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: web-gaps-8, Property 9: Paging is a partition
	// Validates: Requirements 4.4
	it("property: a cursor for any id of the maximum listed length stays within bounds", () => {
		const head = "20261016_120000_01234_"
		const tail = "_GROUP_TGT_1_SRC_2.wav"
		const fill = 100 - "dsd:0~".length - head.length - tail.length
		fc.assert(
			fc.property(
				fc.double({ noNaN: true, noDefaultInfinity: true }),
				fc.stringMatching(new RegExp(`^[A-Za-z0-9_.-]{${fill}}$`)),
				(m, filler) => {
					const i = `dsd:0~${head}${filler}${tail}`
					expect(i).toHaveLength(RECORDINGS_ID_MAX_LENGTH)
					const c = encodeCursor({ m, i })
					expect(c.length).toBeLessThanOrEqual(184)
					expect(c.length).toBeLessThanOrEqual(RECORDINGS_CURSOR_MAX_LENGTH)
					expect(decodeCursor(c)).toEqual({ m: m === 0 ? 0 : m, i })
				},
			),
			{ numRuns: 100 },
		)
	})
})

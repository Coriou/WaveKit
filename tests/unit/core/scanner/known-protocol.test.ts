import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { KNOWN_PROTOCOL_MAX_MISSES } from "../../../../src/core/scanner/known-protocol-contract.js"
import {
	createKnownProtocolMemory,
	KNOWN_PROTOCOL_MEMORY_MAX_ENTRIES,
} from "../../../../src/core/scanner/known-protocol.js"
import type {
	ScannerConfidence,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"

type Row = { protocol: ScannerProtocol; confidence: ScannerConfidence }

function store(rows: Record<string, Row> = {}) {
	const map = new Map(Object.entries(rows))
	return {
		map,
		memory: (opts: { maxEntries?: number } = {}) =>
			createKnownProtocolMemory({ discovery: id => map.get(id) }, opts),
	}
}

describe("known-protocol memory (WG11 1.7, 1.8)", () => {
	it("knows a decoded discovery's protocol and decays at 2 misses (0, 1, 2, 3)", () => {
		expect(KNOWN_PROTOCOL_MAX_MISSES).toBe(2)
		const s = store({ d: { protocol: "dmr", confidence: "decoded" } })
		const m = s.memory()
		expect(m.known("d")).toBe("dmr") // 0
		m.recordMiss("d", "dmr")
		expect(m.known("d")).toBe("dmr") // 1
		m.recordMiss("d", "dmr")
		expect(m.known("d")).toBeNull() // 2
		m.recordMiss("d", "dmr")
		expect(m.known("d")).toBeNull() // 3
		expect(m.size()).toBe(1)
	})

	it("a decode resets the count; forget drops it", () => {
		const s = store({ d: { protocol: "dmr", confidence: "decoded" } })
		const m = s.memory()
		m.recordMiss("d", "dmr")
		m.recordMiss("d", "dmr")
		expect(m.known("d")).toBeNull()
		m.recordDecode("d")
		expect(m.known("d")).toBe("dmr")
		expect(m.size()).toBe(0)
		m.recordMiss("d", "dmr")
		m.recordMiss("d", "dmr")
		m.forget("d")
		expect(m.size()).toBe(0)
		expect(m.known("d")).toBe("dmr")
	})

	it("counts only misses of the current known protocol", () => {
		const s = store({ d: { protocol: "dmr", confidence: "decoded" } })
		const m = s.memory()
		m.recordMiss("d", "nxdn48")
		m.recordMiss("d", "p25p1")
		expect(m.known("d")).toBe("dmr")
		expect(m.size()).toBe(0)
	})

	it("misses counted for an older protocol do not decay a changed one", () => {
		const s = store({ d: { protocol: "dmr", confidence: "decoded" } })
		const m = s.memory()
		m.recordMiss("d", "dmr")
		m.recordMiss("d", "dmr")
		expect(m.known("d")).toBeNull()
		s.map.set("d", { protocol: "p25p1", confidence: "decoded" })
		expect(m.known("d")).toBe("p25p1")
		m.recordMiss("d", "p25p1")
		expect(m.known("d")).toBe("p25p1")
	})

	it("knows nothing below decoded, for unknown ids and on throwing or malformed deps", () => {
		for (const confidence of ["activity", "candidate", "classified"] as const) {
			const m = store({ d: { protocol: "dmr", confidence } }).memory()
			expect(m.known("d")).toBeNull()
			m.recordMiss("d", "dmr")
			expect(m.size()).toBe(0)
		}
		const s = store()
		expect(s.memory().known("nope")).toBeNull()
		const throwing = createKnownProtocolMemory({
			discovery: () => {
				throw new Error("store gone")
			},
		})
		expect(throwing.known("d")).toBeNull()
		expect(() => throwing.recordMiss("d", "dmr")).not.toThrow()
		for (const bad of [
			null,
			42,
			"dmr",
			{ protocol: "", confidence: "decoded" },
			{ protocol: 7, confidence: "decoded" },
			{ confidence: "decoded" },
			{ protocol: "dmr", confidence: "DECODED" },
		]) {
			const m = createKnownProtocolMemory({ discovery: () => bad as never })
			expect(m.known("d")).toBeNull()
		}
		expect(
			store({ d: { protocol: "dmr", confidence: "decoded" } })
				.memory()
				.known(""),
		).toBeNull()
	})

	it("drops the entry of a discovery that disappeared on its next miss", () => {
		const s = store({ d: { protocol: "dmr", confidence: "decoded" } })
		const m = s.memory()
		m.recordMiss("d", "dmr")
		expect(m.size()).toBe(1)
		s.map.delete("d")
		m.recordMiss("d", "dmr")
		expect(m.size()).toBe(0)
	})

	it("stays within its cap: at the cap, and one past it with every entry live", () => {
		expect(KNOWN_PROTOCOL_MEMORY_MAX_ENTRIES).toBe(1_000_000)
		const rows: Record<string, Row> = {}
		for (let i = 0; i < 5; i++)
			rows[`d${i}`] = { protocol: "dmr", confidence: "decoded" }
		const s = store(rows)
		const m = s.memory({ maxEntries: 4 })
		for (let i = 0; i < 4; i++) m.recordMiss(`d${i}`, "dmr")
		expect(m.size()).toBe(4) // at the cap
		m.recordMiss("d4", "dmr") // cap + 1: all live, the oldest goes
		expect(m.size()).toBe(4)
		m.recordMiss("d4", "dmr")
		expect(m.known("d4")).toBeNull()
		expect(m.known("d0")).toBe("dmr")
	})

	it("at the cap, sweeps entries of gone discoveries before evicting a live one", () => {
		const rows: Record<string, Row> = {}
		for (let i = 0; i < 5; i++)
			rows[`d${i}`] = { protocol: "dmr", confidence: "decoded" }
		const s = store(rows)
		const m = s.memory({ maxEntries: 4 })
		for (let i = 0; i < 4; i++) m.recordMiss(`d${i}`, "dmr")
		m.recordMiss("d0", "dmr") // d0 decayed (2 misses)
		s.map.delete("d2")
		m.recordMiss("d4", "dmr")
		expect(m.size()).toBe(4)
		expect(m.known("d0")).toBeNull() // the live decayed entry survived
	})

	it("ignores a malformed cap option", () => {
		for (const maxEntries of [0, -1, 1.5, Number.NaN]) {
			const m = store({ d: { protocol: "dmr", confidence: "decoded" } }).memory(
				{ maxEntries },
			)
			m.recordMiss("d", "dmr")
			expect(m.size()).toBe(1)
		}
	})

	// Feature: web-gaps-11, Property 14: Known first, decays safely
	// Validates: Requirements 1.7, 1.8
	it("property: known iff decoded with fewer than 2 consecutive misses of its protocol; a decode resets", () => {
		const protocols = ["dmr", "p25p1", "nxdn48", "dpmr"] as const
		const op = fc.oneof(
			fc.record({
				kind: fc.constant("miss" as const),
				p: fc.constantFrom(...protocols),
			}),
			fc.record({ kind: fc.constant("decode" as const) }),
			fc.record({ kind: fc.constant("forget" as const) }),
			fc.record({
				kind: fc.constant("store" as const),
				row: fc.option(
					fc.record({
						protocol: fc.constantFrom(...protocols),
						confidence: fc.constantFrom<ScannerConfidence>(
							"activity",
							"candidate",
							"classified",
							"decoded",
						),
					}),
					{ nil: undefined },
				),
			}),
		)
		fc.assert(
			fc.property(fc.array(op, { maxLength: 30 }), ops => {
				const s = store()
				const m = s.memory()
				// oracle: consecutive misses of the current known protocol since the last reset
				let misses = 0
				let countedFor: ScannerProtocol | null = null
				for (const o of ops) {
					const row = s.map.get("d")
					const cur = row?.confidence === "decoded" ? row.protocol : null
					if (o.kind === "miss") {
						if (cur === null) {
							misses = 0
							countedFor = null
						} else if (o.p === cur) {
							if (countedFor !== cur) misses = 0
							countedFor = cur
							misses = Math.min(misses + 1, KNOWN_PROTOCOL_MAX_MISSES)
						}
						m.recordMiss("d", o.p)
					} else if (o.kind === "decode" || o.kind === "forget") {
						misses = 0
						countedFor = null
						if (o.kind === "decode") m.recordDecode("d")
						else m.forget("d")
					} else if (o.row === undefined) s.map.delete("d")
					else s.map.set("d", o.row)
					const now = s.map.get("d")
					const known = now?.confidence === "decoded" ? now.protocol : null
					const decayed =
						known !== null &&
						countedFor === known &&
						misses >= KNOWN_PROTOCOL_MAX_MISSES
					expect(m.known("d")).toBe(decayed ? null : known)
					expect(m.size()).toBeLessThanOrEqual(1)
				}
			}),
			{ numRuns: 200 },
		)
	})
})

import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { probeId, shortId, ulid } from "../../../../src/core/scanner/ids.js"
import { CONFIDENCE_RANK } from "../../../../src/core/scanner/types.js"

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function ulidTime(id: string): number {
	let t = 0
	for (const ch of id.slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(ch)
	return t
}

describe("ulid", () => {
	it("encodes the given millisecond in a 26-char Crockford id", () => {
		const now = Date.now() + 86_400_000
		const id = ulid(now)
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
		expect(ulidTime(id)).toBe(now)
	})

	it("sorts strictly ascending within one millisecond and when the clock steps back", () => {
		const now = Date.now() + 2 * 86_400_000
		const ids = [ulid(now)]
		for (let i = 0; i < 2000; i++) ids.push(ulid(now))
		ids.push(ulid(now - 5_000))
		for (let i = 1; i < ids.length; i++)
			expect(ids[i]! > ids[i - 1]!).toBe(true)
		expect(new Set(ids).size).toBe(ids.length)
		expect(ulidTime(ids[ids.length - 1]!)).toBe(now)
	})

	it("starts a later millisecond above every id of the earlier one", () => {
		const now = Date.now() + 3 * 86_400_000
		const a = ulid(now)
		const b = ulid(now + 1)
		expect(b > a).toBe(true)
		expect(ulidTime(b)).toBe(now + 1)
	})

	it("rejects times outside 48 bits", () => {
		expect(() => ulid(-1)).toThrow()
		expect(() => ulid(2 ** 48)).toThrow()
		expect(() => ulid(1.5)).toThrow()
	})
})

describe("shortId", () => {
	it("is a stable 7-char [a-z0-9] digest", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 64 }), s => {
				const a = shortId(s)
				expect(a).toMatch(/^[a-z0-9]{7}$/)
				expect(shortId(s)).toBe(a)
			}),
			{ numRuns: 100 },
		)
	})

	it("separates ULID-like job ids that share a prefix", () => {
		const base = "j_01JABCDEFGHJKMNPQRSTVWXY"
		const ids = new Set<string>()
		for (const ch of CROCKFORD) ids.add(shortId(base + ch))
		expect(ids.size).toBe(32)
	})
})

describe("probeId", () => {
	it("builds the § 6.5 shape", () => {
		expect(probeId(shortId("job-1"), "dmr", 7)).toMatch(
			/^scan-[a-z0-9]{7}-dmr-7$/,
		)
		expect(probeId("abc1234", "NXDN-96", 12)).toBe("scan-abc1234-nxdn96-12")
		expect(probeId("abc1234", "digital-unknown", 0)).toBe(
			"scan-abc1234-digitalu-0",
		)
	})

	it("always yields ≤ 32 chars of [a-z0-9-] for valid inputs", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 40 }),
				fc
					.stringMatching(/^[A-Za-z0-9_-]{1,20}$/)
					.filter(s => /[A-Za-z0-9]/.test(s)),
				fc.integer({ min: 0, max: 9_999_999_999 }),
				(job, proto, seq) => {
					const id = probeId(shortId(job), proto, seq)
					expect(id.length).toBeLessThanOrEqual(32)
					expect(id).toMatch(/^[a-z0-9-]+$/)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("rejects inputs that would break the bound or the alphabet", () => {
		expect(() => probeId("ABC1234", "dmr", 1)).toThrow()
		expect(() => probeId("abc12345", "dmr", 1)).toThrow()
		expect(() => probeId("abc1234", "--", 1)).toThrow()
		expect(() => probeId("abc1234", "dmr", -1)).toThrow()
		expect(() => probeId("abc1234", "dmr", 10_000_000_000)).toThrow()
		expect(() => probeId("abc1234", "dmr", 1.5)).toThrow()
	})
})

describe("CONFIDENCE_RANK", () => {
	it("orders the § 7.3 ladder activity < candidate < classified < decoded", () => {
		const ladder = (["decoded", "activity", "classified", "candidate"] as const)
			.slice()
			.sort((a, b) => CONFIDENCE_RANK[a] - CONFIDENCE_RANK[b])
		expect(ladder).toEqual(["activity", "candidate", "classified", "decoded"])
		expect(Object.isFrozen(CONFIDENCE_RANK)).toBe(true)
	})
})

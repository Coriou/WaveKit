import { beforeAll, describe, expect, it } from "vitest"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import {
	bannerLine,
	type BannerCondition,
} from "../../../cli/source/ui/banner.js"
import { lineText } from "../../../cli/source/ui/text.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

const NOW = Date.parse("2026-10-08T18:10:11Z")
const t = (conds: BannerCondition[], w = 119) => {
	const l = bannerLine(conds, NOW, w)
	return l ? lineText(l) : null
}

describe("banner copy (spec §9)", () => {
	it("is absent without a condition", () => {
		expect(t([])).toBeNull()
	})
	it("matches the spec rows", () => {
		expect(
			t([
				{
					kind: "api-down",
					reason: "ECONNREFUSED",
					retryAt: NOW + 4000,
					asOf: Date.parse("2026-10-08T18:07:40Z"),
					target: "http://127.0.0.1:9000",
					tried: [],
				},
			]),
		).toBe(
			"! API unreachable · ECONNREFUSED · retry in 4s · data as of 18:07:40",
		)
		expect(
			t([
				{
					kind: "api-down",
					reason: "ECONNREFUSED",
					retryAt: NOW + 4000,
					asOf: null,
					target: "http://127.0.0.1:9000",
					tried: [],
				},
			]),
		).toBe("! API unreachable · ECONNREFUSED · retry in 4s · 127.0.0.1:9000")
		expect(
			t([
				{
					kind: "api-down",
					reason: "no API answered",
					retryAt: NOW + 4000,
					asOf: null,
					target: null,
					tried: ["127.0.0.1:9000", "127.0.0.1:3000"],
				},
			]),
		).toBe(
			"! API unreachable · tried 127.0.0.1:9000, 127.0.0.1:3000 · retry in 4s",
		)
		expect(t([{ kind: "ws-down", code: 1006, retryAt: NOW + 8000 }])).toBe(
			"! live feed down · ws closed 1006 · REST every 5s · retry in 8s",
		)
		expect(
			t([
				{
					kind: "rest-down",
					reason: "timeout 2s",
					retryAt: NOW + 3000,
					asOf: Date.parse("2026-10-08T18:08:20Z"),
				},
			]),
		).toBe(
			"! REST failing · timeout 2s · retry in 3s · REST data as of 18:08:20",
		)
		expect(
			t([{ kind: "endpoint", path: "/api/resources", reason: "500" }]),
		).toBe("! GET /api/resources failing · 500 · other endpoints answering")
	})
	it("shows the highest-priority condition plus · +N", () => {
		const out = t([
			{ kind: "endpoint", path: "/api/resources", reason: "500" },
			{ kind: "ws-down", code: 1006, retryAt: NOW + 8000 },
		])
		expect(out).toBe(
			"! live feed down · ws closed 1006 · REST every 5s · retry in 8s · +1",
		)
	})
	it("drops trailing groups at narrow widths and never uses banned words", () => {
		const out = t(
			[
				{
					kind: "rest-down",
					reason: "timeout 2s",
					retryAt: NOW + 3000,
					asOf: NOW - 51000,
				},
			],
			45,
		)
		expect(out).toBe("! REST failing · timeout 2s · retry in 3s")
		expect(findBanned(out ?? "")).toEqual([])
	})
	it("sanitises server and error text so nothing can move the cursor", () => {
		const out = t([
			{ kind: "endpoint", path: "/api/x\x1b[2J", reason: "5\r00\x9b" },
		])
		expect(out).toBe(
			"! GET /api/x[2J failing · 500 · other endpoints answering",
		)
	})

	describe("fix round 1", () => {
		const rest: BannerCondition = {
			kind: "rest-down",
			reason: "timeout 2s",
			retryAt: NOW + 3000,
			asOf: NOW - 51000,
		}
		const ws: BannerCondition = {
			kind: "ws-down",
			code: 1006,
			retryAt: NOW + 8000,
		}
		it("drops the reason before +N, never the other way round", () => {
			expect(t([rest, ws], 45)).toBe("! REST failing · timeout 2s · +1")
			expect(t([rest, ws], 20)).toBe("! REST failing · +1")
		})
		it("clips an over-long reason so the countdown and as-of survive", () => {
			const long =
				"connect ECONNREFUSED 192.0.2.10:9000 after 3 attempts with backoff"
			const c: BannerCondition = {
				kind: "api-down",
				reason: long,
				retryAt: NOW + 4000,
				asOf: Date.parse("2026-10-08T18:07:40Z"),
				target: "http://127.0.0.1:9000",
				tried: [],
			}
			const narrow = t([c], 80) ?? ""
			expect(narrow).toContain("retry in 4s")
			expect(narrow).toContain("data as of 18:07:40")
			expect(narrow).toContain("connect ECONNREFUSED")
			expect(narrow).toContain("…")
			expect(t([c], 200)).toContain(long)
		})
		it("says retrying once the retry time has passed", () => {
			expect(t([{ ...ws, retryAt: NOW - 1000 }])).toBe(
				"! live feed down · ws closed 1006 · REST every 5s · retrying",
			)
			expect(t([{ ...ws, retryAt: NOW }])).toContain("· retrying")
		})
	})
})

import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { ActivityQueryInvalidError } from "../../../../../src/core/activity/query/errors.js"
import { DEFAULT_ACTIVITY_QUERY_LIMITS } from "../../../../../src/core/activity/query/service.js"
import { normaliseTrailsQuery } from "../../../../../src/core/activity/query/validate.js"
import type { ActivityQueryService } from "../../../../../src/core/activity/storage/contract.js"
import {
	createActivityQueryService,
	type ActivityQueryServiceOptions,
} from "../../../../../src/core/activity/query/service.js"
import { createFixture, testLogger, type ActivityFixture } from "./fixture.js"

const NOW = Date.parse("2026-10-16T12:00:00.000Z")
const iso = (offset: number): string => new Date(NOW + offset).toISOString()

describe("normaliseTrailsQuery", () => {
	it("defaults to the last hour ending now", () => {
		expect(normaliseTrailsQuery({}, NOW)).toEqual({
			producedFromMs: NOW - 3_600_000,
			producedToMs: NOW,
		})
	})

	it("defaults from relative to an explicit producedTo", () => {
		const query = normaliseTrailsQuery({ producedTo: iso(-1000) }, NOW)
		expect(query.producedToMs).toBe(NOW - 1000)
		expect(query.producedFromMs).toBe(NOW - 1000 - 3_600_000)
	})

	it("accepts from == to and a window of exactly 24 h", () => {
		expect(() =>
			normaliseTrailsQuery({ producedFrom: iso(0), producedTo: iso(0) }, NOW),
		).not.toThrow()
		expect(() =>
			normaliseTrailsQuery(
				{ producedFrom: iso(-86_400_000), producedTo: iso(0) },
				NOW,
			),
		).not.toThrow()
	})

	it("rejects bad input at the bound", () => {
		const bad: unknown[] = [
			{ producedFrom: "nope" },
			{ producedFrom: iso(0), producedTo: iso(-1) },
			{ producedFrom: iso(-86_400_001), producedTo: iso(0) },
			{ producedFrom: iso(-86_400_001) },
			{ categories: ["bogus"] },
			{ entityKeys: Array.from({ length: 65 }, (_, i) => `k${i}`) },
			{ entityKeys: [""] },
			{ extra: 1 },
		]
		for (const input of bad) {
			expect(
				() => normaliseTrailsQuery(input, NOW),
				JSON.stringify(input),
			).toThrow(ActivityQueryInvalidError)
		}
		expect(() =>
			normaliseTrailsQuery(
				{ entityKeys: Array.from({ length: 64 }, (_, i) => `k${i}`) },
				NOW,
			),
		).not.toThrow()
	})

	it("sorts and deduplicates lists and drops empty ones", () => {
		expect(
			normaliseTrailsQuery(
				{
					categories: ["marine", "aircraft", "marine"],
					protocols: [],
					entityKeys: ["b", "a"],
				},
				NOW,
			),
		).toMatchObject({
			categories: ["aircraft", "marine"],
			entityKeys: ["a", "b"],
		})
		expect(normaliseTrailsQuery({ protocols: [] }, NOW)).not.toHaveProperty(
			"protocols",
		)
	})
})

describe("query service trails", () => {
	let fixture: ActivityFixture | undefined
	let service: ActivityQueryService | undefined

	afterEach(async () => {
		await service?.close()
		await fixture?.close()
		service = undefined
		fixture = undefined
	})

	function stamp(store: ActivityFixture, eventId: string, lat: number): void {
		const db = new DatabaseSync(store.dbPath)
		try {
			db.prepare(
				"UPDATE activity SET summary_json = json_set(summary_json, '$.position', json(?)) WHERE event_id = ?",
			).run(JSON.stringify({ lat, lon: 1 }), eventId)
		} finally {
			db.close()
		}
	}

	it("has a 1 000 ms default trails deadline", () => {
		expect(DEFAULT_ACTIVITY_QUERY_LIMITS.trailsDeadlineMs).toBe(1_000)
	})

	it("stops the scan cooperatively at 600 ms, inside the 1 000 ms reader deadline", () => {
		expect(DEFAULT_ACTIVITY_QUERY_LIMITS.trailsWallBudgetMs).toBe(600)
		expect(DEFAULT_ACTIVITY_QUERY_LIMITS.trailsWallBudgetMs).toBeLessThan(
			DEFAULT_ACTIVITY_QUERY_LIMITS.trailsDeadlineMs,
		)
	})

	it("applies trailsLimits overrides at the bound", async () => {
		fixture = await createFixture()
		const store = fixture
		service = openQueryService(store, {
			now: () => NOW,
			trailsLimits: { maxPointsPerEntity: 2 },
		})
		for (let i = 0; i < 3; i++) {
			store.insert({
				eventId: `e${i}`,
				entityKey: "A",
				producedAt: iso(-(3 - i) * 1000),
			})
			stamp(store, `e${i}`, 10 + i)
		}
		const result = await service.trails?.({})
		expect(result?.trails[0]?.points).toHaveLength(2)
		expect(result?.trails[0]?.truncated).toBe(true)
		expect(result?.truncated).toBe(true)
		expect(result?.truncation).toEqual(["per-entity"])
	})

	it("rejects invalid input with ActivityQueryInvalidError", async () => {
		fixture = await createFixture()
		service = openQueryService(fixture, { now: () => NOW })
		await expect(
			service.trails?.({ producedFrom: "nope" }),
		).rejects.toBeInstanceOf(ActivityQueryInvalidError)
	})
})

function openQueryService(
	fixture: ActivityFixture,
	overrides: Partial<Omit<ActivityQueryServiceOptions, "store">> = {},
): ActivityQueryService {
	return createActivityQueryService({
		store: fixture.store,
		logger: testLogger,
		execution: "inline",
		...overrides,
		limits: { deadlineMs: 2_000, ...overrides.limits },
	})
}

/**
 * The channel scope (`channelHz`, `nearHz` + `toleranceHz`) and the frequency range read as
 * index-driven candidate sets: the query plan drives the search, the facets scan and the
 * channelMatch probe from the refs key and activity_frequency, never from the (low, high] rowid
 * range or a full scan of activity (that walk took about 1 s on a 250 000-row store, past the
 * 250 ms deadline). The answers equal a direct model of the scope. Synthetic rows only.
 */
import { DatabaseSync } from "node:sqlite"
import fc from "fast-check"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ } from "@wavekit/api-types"
import {
	channelMatchStatement,
	facetsStatement,
	searchStatement,
} from "../../../../../src/core/activity/query/read.js"
import { DEFAULT_ACTIVITY_QUERY_LIMITS } from "../../../../../src/core/activity/query/service.js"
import {
	normaliseQuery,
	type FacetDimension,
} from "../../../../../src/core/activity/query/validate.js"
import type {
	ActivityCategory,
	ActivityQuery,
	ActivityQueryService,
} from "../../../../../src/core/activity/storage/contract.js"
import { channelRefValue } from "../../../../../src/core/activity/storage/row.js"
import type { SqlValue } from "../../../../../src/core/activity/query/sqlite.js"
import {
	createFixture,
	openQueryService,
	type ActivityFixture,
} from "./fixture.js"

const CHANNEL_HZ = 446_006_250
const STEP = 12_500
const HALF = ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ

const SCOPES: Record<string, ActivityQuery> = {
	channelHz: { channelHz: CHANNEL_HZ },
	nearHz: { nearHz: CHANNEL_HZ + 25_000, toleranceHz: 50_000 },
	"frequency range": {
		frequencyHz: { min: CHANNEL_HZ - HALF, max: CHANNEL_HZ + HALF },
	},
	"frequency min only": { frequencyHz: { min: CHANNEL_HZ - HALF } },
	"channelHz + category": { channelHz: CHANNEL_HZ, categories: ["voice"] },
	"channelHz + hasRecording": { channelHz: CHANNEL_HZ, hasRecording: true },
	"channelHz + frequency range": {
		channelHz: CHANNEL_HZ,
		frequencyHz: { min: CHANNEL_HZ - HALF, max: CHANNEL_HZ + HALF },
	},
	"channelHz + jobId": {
		channelHz: CHANNEL_HZ,
		refs: [{ type: "jobId", value: "job-1" }],
	},
}

/** The plan rows as text, one detail per line. */
function planOf(db: DatabaseSync, sql: string, params: SqlValue[]): string {
	return db
		.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.all(...params)
		.map(row => String(row["detail"]))
		.join("\n")
}

/** A plan that never walks activity: no full scan, no rowid range of the snapshot. */
function expectIndexDriven(plan: string, query: ActivityQuery): void {
	expect(plan).not.toMatch(/^SCAN activity$/m)
	expect(plan).not.toMatch(/SCAN activity\b(?!_)/)
	expect(plan).not.toContain("INTEGER PRIMARY KEY (rowid>? AND rowid<?)")
	expect(plan).not.toMatch(/USING (COVERING )?INDEX \S+ \(seq>\? AND seq<\?\)/)
	if (query.channelHz !== undefined || query.nearHz !== undefined) {
		expect(plan).toContain(
			"SEARCH activity_refs USING PRIMARY KEY (ref_type=? AND ref_value>? AND ref_value<?)",
		)
	}
	expect(plan).toMatch(
		/USING COVERING INDEX activity_frequency \(frequency_hz>\?/,
	)
}

describe("channel and frequency scopes use the indexes", () => {
	let fixture: ActivityFixture | undefined

	afterEach(async () => {
		await fixture?.close()
		fixture = undefined
	})

	it("search, facets and channelMatch never walk the snapshot's rows", async () => {
		fixture = await createFixture()
		fixture.insert({ eventId: "a", frequencyHz: CHANNEL_HZ })
		const db = new DatabaseSync(fixture.dbPath)
		try {
			for (const [name, raw] of Object.entries(SCOPES)) {
				const query = normaliseQuery(raw, DEFAULT_ACTIVITY_QUERY_LIMITS)
				const search = searchStatement({
					op: "search",
					query,
					order: "desc",
					limit: 101,
					low: "0",
					high: "250000",
					before: null,
					after: null,
				})
				const dimensions: FacetDimension[][] = [
					["category"],
					["channel", "category"],
				]
				const plans = [
					planOf(db, search.sql, search.params),
					...dimensions.map(dims => {
						const facets = facetsStatement({
							op: "facets",
							query,
							dimensions: dims,
							low: "0",
							high: "250000",
							scanCap: DEFAULT_ACTIVITY_QUERY_LIMITS.facetScan,
							valueCap: DEFAULT_ACTIVITY_QUERY_LIMITS.facetValues,
						})
						return planOf(db, facets.sql, facets.params)
					}),
				]
				for (const plan of plans) {
					try {
						expectIndexDriven(plan, raw)
						// The candidate set is ordered: no sort of the matches for ORDER BY seq.
						expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY")
					} catch (error) {
						throw new Error(`${name}:\n${plan}`, { cause: error })
					}
				}
				if (query.channel !== null) {
					const probe = channelMatchStatement(query, "0", "250000")
					const plan = planOf(db, probe.sql, probe.params)
					expect(plan, `${name} channelMatch:\n${plan}`).not.toContain(
						"INTEGER PRIMARY KEY (rowid>? AND rowid<?)",
					)
					expect(plan).toMatch(
						/SEARCH fallback USING COVERING INDEX activity_frequency \(frequency_hz>\? AND frequency_hz<\?\)/,
					)
				}
			}
		} finally {
			db.close()
		}
	})
})

interface ModelRow {
	eventId: string
	frequencyHz: number | null
	/** The stored channel; null: none (an older row or one that never had a channel). */
	channelHz: number | null
	category: ActivityCategory
	recorded: boolean
}

interface ModelScope {
	channel: { minHz: number; maxHz: number } | null
	frequency: { min: number; max: number } | null
	category: ActivityCategory | null
	hasRecording: boolean | null
}

function inChannel(row: ModelRow, channel: { minHz: number; maxHz: number }) {
	if (row.channelHz !== null)
		return row.channelHz >= channel.minHz && row.channelHz <= channel.maxHz
	return (
		row.frequencyHz !== null &&
		row.frequencyHz >= channel.minHz - HALF &&
		row.frequencyHz < channel.maxHz + HALF
	)
}

function matches(row: ModelRow, scope: ModelScope): boolean {
	if (scope.channel !== null && !inChannel(row, scope.channel)) return false
	if (
		scope.frequency !== null &&
		(row.frequencyHz === null ||
			row.frequencyHz < scope.frequency.min ||
			row.frequencyHz > scope.frequency.max)
	)
		return false
	if (scope.category !== null && row.category !== scope.category) return false
	if (scope.hasRecording !== null && row.recorded !== scope.hasRecording)
		return false
	return true
}

function queryOf(scope: ModelScope, near: boolean): ActivityQuery {
	const query: ActivityQuery = {}
	if (scope.channel !== null) {
		if (near) {
			query.nearHz = (scope.channel.minHz + scope.channel.maxHz) / 2
			query.toleranceHz = (scope.channel.maxHz - scope.channel.minHz) / 2
		} else query.channelHz = scope.channel.minHz
	}
	if (scope.frequency !== null) query.frequencyHz = scope.frequency
	if (scope.category !== null) query.categories = [scope.category]
	if (scope.hasRecording !== null) query.hasRecording = scope.hasRecording
	return query
}

/** Offsets in channel steps around CHANNEL_HZ, and carriers a few hundred Hz to a half step off. */
const channelArb = fc
	.integer({ min: -3, max: 3 })
	.map(k => CHANNEL_HZ + k * STEP)
const carrierArb = fc
	.tuple(
		channelArb,
		fc.constantFrom(0, 300, -300, HALF - 1, HALF, -HALF, -HALF - 1),
	)
	.map(([hz, off]) => hz + off)
const rowArb = fc.record({
	frequencyHz: fc.option(carrierArb, { nil: null, freq: 6 }),
	channelHz: fc.option(channelArb, { nil: null, freq: 3 }),
	category: fc.constantFrom<ActivityCategory>("voice", "other"),
	recorded: fc.boolean(),
})
const scopeArb: fc.Arbitrary<{ scope: ModelScope; near: boolean }> = fc.record({
	scope: fc.record({
		channel: fc.option(
			fc
				.tuple(channelArb, fc.integer({ min: 0, max: 2 }))
				.map(([hz, span]) => ({ minHz: hz, maxHz: hz + span * STEP })),
			{ nil: null, freq: 4 },
		),
		frequency: fc.option(
			fc
				.tuple(carrierArb, fc.integer({ min: 0, max: 30_000 }))
				.map(([min, width]) => ({ min, max: min + width })),
			{ nil: null, freq: 3 },
		),
		category: fc.option(fc.constantFrom<ActivityCategory>("voice", "other"), {
			nil: null,
			freq: 3,
		}),
		hasRecording: fc.option(fc.boolean(), { nil: null, freq: 3 }),
	}),
	near: fc.boolean(),
})

describe("channel and frequency candidate sets answer as the scope reads", () => {
	let store: ActivityFixture
	let service: ActivityQueryService

	beforeAll(async () => {
		store = await createFixture({ memory: true })
		service = openQueryService(store)
	})

	afterAll(async () => {
		await service.close()
		await store.close()
	})

	// Feature: wg24-c2 channels, Property 1: index-driven channel and frequency scopes are exact
	// Validates: Requirements C2 M1 (same matches, order, facet counts and channelMatch)
	it("search order, channel facet counts and channelMatch equal the model", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(rowArb, { maxLength: 30 }),
				scopeArb,
				async (generated, { scope: drawn, near }) => {
					// channelHz names one channel; nearHz the whole drawn span.
					const scope: ModelScope =
						drawn.channel === null || near
							? drawn
							: {
									...drawn,
									channel: {
										minHz: drawn.channel.minHz,
										maxHz: drawn.channel.minHz,
									},
								}
					store.reset()
					const rows: ModelRow[] = generated.map((row, index) => ({
						...row,
						eventId: `e${index}`,
					}))
					for (const row of rows) {
						const refs: { type: "channelHz" | "recordingId"; value: string }[] =
							[]
						if (row.channelHz !== null)
							refs.push({
								type: "channelHz",
								value: channelRefValue(row.channelHz),
							})
						if (row.recorded)
							refs.push({ type: "recordingId", value: `rec-${row.eventId}` })
						store.insert({
							eventId: row.eventId,
							frequencyHz: row.frequencyHz,
							category: row.category,
							refs,
						})
					}
					const query = queryOf(scope, near)
					const expected = rows.filter(row => matches(row, scope)).reverse()
					const page = await service.search({ query, limit: 100 })
					expect(page.items.map(item => item.eventId)).toEqual(
						expected.map(row => row.eventId),
					)
					const facets = await service.facets({
						query,
						dimensions: ["channel", "category"],
					})
					const counts = new Map<string | null, number>()
					for (const row of expected) {
						const key = row.channelHz === null ? null : String(row.channelHz)
						counts.set(key, (counts.get(key) ?? 0) + 1)
					}
					const got = new Map(
						(facets.facets["channel"] ?? []).map(entry => [
							entry.value,
							entry.count,
						]),
					)
					expect(got).toEqual(counts)
					expect(facets.scanned).toBe(expected.length)
					if (scope.channel === null) {
						expect(page.channelMatch).toBeUndefined()
					} else {
						const mixed = expected.some(row => row.channelHz === null)
						expect(page.channelMatch).toBe(mixed ? "mixed" : "exact")
						expect(facets.channelMatch).toBe(mixed ? "mixed" : "exact")
					}
				},
			),
			{ numRuns: 150 },
		)
	}, 60_000)
})

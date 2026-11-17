/**
 * The channel scope (`channelHz`, `nearHz` + `toleranceHz`) and the frequency range read as
 * index-driven candidate sets: the query plan drives the search, the facets scan and the
 * channelMatch probe from the refs key and activity_frequency, never from the (low, high] rowid
 * range or a full scan of activity (that walk took about 1 s on a 250 000-row store, past the
 * 250 ms deadline). A scope dense enough to reach SCOPE_DENSITY_CAP reads as the walk instead,
 * which stops at LIMIT. Both plans answer as a direct model of the scope. Synthetic rows only.
 *
 * The plan strings (EXPLAIN QUERY PLAN detail text) depend on the SQLite bundled with Node
 * (node:sqlite): a Node upgrade that changes the planner or its wording fails these tests first.
 * They hold plans for a store without sqlite_stat1 (no ANALYZE), as the activity store is.
 */
import { DatabaseSync } from "node:sqlite"
import fc from "fast-check"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ } from "@wavekit/api-types"
import {
	channelMatchStatement,
	facetsDensityCap,
	facetsStatement,
	runRead,
	SCOPE_DENSITY_CAP,
	scopePlanOf,
	searchStatement,
	type ScopePlan,
} from "../../../../../src/core/activity/query/read.js"
import {
	openReadOnly,
	type SqlDatabase,
} from "../../../../../src/core/activity/query/sqlite.js"
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
import type { NormalisedQuery } from "../../../../../src/core/activity/query/validate.js"
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
function planOf(
	db: DatabaseSync | SqlDatabase,
	sql: string,
	params: SqlValue[],
): string {
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

const UNION: ScopePlan = { channel: "union", frequency: "union" }
const WALK: ScopePlan = { channel: "walk", frequency: "walk" }
const PLANS: ScopePlan[] = [
	UNION,
	WALK,
	{ channel: "union", frequency: "walk" },
	{ channel: "walk", frequency: "union" },
]

/** The probe reads the fallback's activity_frequency range and stops: no candidate list. */
function expectProbe(plan: string): void {
	expect(plan).toMatch(
		/^SEARCH activity USING (COVERING )?INDEX activity_frequency \(frequency_hz>\? AND frequency_hz<\?\)$/m,
	)
	expect(plan).not.toContain("LIST SUBQUERY")
	expect(plan).not.toContain("INTEGER PRIMARY KEY (rowid>? AND rowid<?)")
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
		const reader = await openReadOnly(fixture.dbPath)
		try {
			for (const [name, raw] of Object.entries(SCOPES)) {
				const query = normaliseQuery(raw, DEFAULT_ACTIVITY_QUERY_LIMITS)
				expect(scopePlanOf(reader, query), name).toEqual(UNION)
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
					expectProbe(plan)
				}
			}
		} finally {
			reader.close()
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

const DENSE_HZ = 1_090_000_000

const DENSE_SCOPES: Record<string, ActivityQuery> = {
	"frequency range": {
		frequencyHz: { min: DENSE_HZ - 1e6, max: DENSE_HZ + 1e6 },
	},
	"frequency min only": { frequencyHz: { min: DENSE_HZ - 1e6 } },
	channelHz: { channelHz: DENSE_HZ },
	nearHz: { nearHz: DENSE_HZ + 25_000, toleranceHz: 50_000 },
	"channelHz + category": { channelHz: DENSE_HZ, categories: ["aircraft"] },
}

describe("the scope plan follows the density of its index ranges", () => {
	let store: ActivityFixture
	let reader: SqlDatabase

	beforeAll(async () => {
		store = await createFixture({ memory: true })
		reader = await openReadOnly(store.dbPath)
	})

	afterEach(() => {
		store.reset()
	})

	afterAll(async () => {
		reader.close()
		await store.close()
	})

	let inserted = 0

	function insertMany(
		count: number,
		row: { frequencyHz: number | null; channelHz?: number },
	): void {
		for (let index = 0; index < count; index++)
			store.insert({
				eventId: `d${String(inserted++)}`,
				category: "aircraft",
				frequencyHz: row.frequencyHz,
				...(row.channelHz === undefined
					? {}
					: {
							refs: [
								{ type: "channelHz", value: channelRefValue(row.channelHz) },
							],
						}),
			})
	}

	const plan = (raw: ActivityQuery): ScopePlan =>
		scopePlanOf(reader, normaliseQuery(raw, DEFAULT_ACTIVITY_QUERY_LIMITS))

	it("a frequency range and a channel's fallback half walk at the cap, not below it", () => {
		insertMany(SCOPE_DENSITY_CAP - 1, { frequencyHz: DENSE_HZ })
		expect(plan(DENSE_SCOPES["frequency range"] ?? {})).toEqual(UNION)
		expect(plan(DENSE_SCOPES["channelHz"] ?? {})).toEqual(UNION)
		insertMany(1, { frequencyHz: DENSE_HZ + 1 })
		expect(plan(DENSE_SCOPES["frequency range"] ?? {})).toEqual({
			channel: "union",
			frequency: "walk",
		})
		expect(plan(DENSE_SCOPES["channelHz"] ?? {})).toEqual({
			channel: "walk",
			frequency: "union",
		})
		// Another channel's rows stay sparse.
		expect(plan({ channelHz: CHANNEL_HZ })).toEqual(UNION)
	})

	it("a channel's stored-channel half walks at the cap, not below it", () => {
		insertMany(SCOPE_DENSITY_CAP - 1, {
			frequencyHz: null,
			channelHz: DENSE_HZ,
		})
		expect(plan({ channelHz: DENSE_HZ })).toEqual(UNION)
		insertMany(1, { frequencyHz: null, channelHz: DENSE_HZ })
		expect(plan({ channelHz: DENSE_HZ })).toEqual({
			channel: "walk",
			frequency: "union",
		})
		expect(plan({ channelHz: DENSE_HZ + STEP })).toEqual(UNION)
	})

	it("a channel's two halves count together", () => {
		insertMany(SCOPE_DENSITY_CAP / 2, {
			frequencyHz: null,
			channelHz: DENSE_HZ,
		})
		insertMany(SCOPE_DENSITY_CAP / 2 - 1, { frequencyHz: DENSE_HZ })
		expect(plan({ channelHz: DENSE_HZ })).toEqual(UNION)
		insertMany(1, { frequencyHz: DENSE_HZ })
		expect(plan({ channelHz: DENSE_HZ })).toEqual({
			channel: "walk",
			frequency: "union",
		})
	})

	it("facets keep the union until the scope holds more matches than the scan reads", () => {
		const scanCap = DEFAULT_ACTIVITY_QUERY_LIMITS.facetScan
		expect(facetsDensityCap(scanCap)).toBe(scanCap)
		expect(facetsDensityCap(SCOPE_DENSITY_CAP - 1)).toBe(SCOPE_DENSITY_CAP)
		expect(facetsDensityCap(SCOPE_DENSITY_CAP + 1)).toBe(SCOPE_DENSITY_CAP + 1)
		// A small cap stands in for the scan cap: at it the facets walk, under it the union.
		insertMany(SCOPE_DENSITY_CAP + 1, { frequencyHz: DENSE_HZ })
		const query = normaliseQuery(
			DENSE_SCOPES["frequency range"] ?? {},
			DEFAULT_ACTIVITY_QUERY_LIMITS,
		)
		expect(scopePlanOf(reader, query, facetsDensityCap(scanCap))).toEqual(UNION)
		expect(
			scopePlanOf(reader, query, facetsDensityCap(SCOPE_DENSITY_CAP + 1)),
		).toEqual({ channel: "union", frequency: "walk" })
		expect(
			scopePlanOf(reader, query, facetsDensityCap(SCOPE_DENSITY_CAP + 2)),
		).toEqual(UNION)
	})

	it("a dense scope walks (low, high] to LIMIT and the probe never builds a candidate list", () => {
		insertMany(SCOPE_DENSITY_CAP, { frequencyHz: DENSE_HZ })
		for (const [name, raw] of Object.entries(DENSE_SCOPES)) {
			const query = normaliseQuery(raw, DEFAULT_ACTIVITY_QUERY_LIMITS)
			const chosen = scopePlanOf(reader, query)
			expect(
				query.channel === null ? chosen.frequency : chosen.channel,
				name,
			).toBe("walk")
			const search = searchStatement(
				{
					op: "search",
					query,
					order: "desc",
					limit: 51,
					low: "0",
					high: "250000",
					before: null,
					after: null,
				},
				chosen,
			)
			const facets = facetsStatement(
				{
					op: "facets",
					query,
					dimensions: ["channel", "category"],
					low: "0",
					high: "250000",
					scanCap: DEFAULT_ACTIVITY_QUERY_LIMITS.facetScan,
					valueCap: DEFAULT_ACTIVITY_QUERY_LIMITS.facetValues,
				},
				scopePlanOf(reader, query, facetsDensityCap(SCOPE_DENSITY_CAP)),
			)
			for (const text of [
				planOf(reader, search.sql, search.params),
				planOf(reader, facets.sql, facets.params),
			]) {
				const detail = `${name}:\n${text}`
				// Driven by a seq-ordered walk of (low, high]: the rowid range, or the
				// (category, seq) key of an equality filter.
				expect(text, detail).toMatch(
					/^SEARCH activity USING (INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)|INDEX activity_category \(category=\? AND seq>\? AND seq<\?\))$/m,
				)
				expect(text, detail).not.toContain("LIST SUBQUERY")
				expect(text, detail).not.toContain("activity_frequency")
				expect(text, detail).not.toContain("USE TEMP B-TREE FOR ORDER BY")
			}
			if (query.channel !== null) {
				const probe = channelMatchStatement(query, "0", "250000")
				const text = planOf(reader, probe.sql, probe.params)
				try {
					expectProbe(text)
				} catch (error) {
					throw new Error(`${name} channelMatch:\n${text}`, { cause: error })
				}
			}
		}
	})

	it("the probe stays per-row beside hasRecording and other refs", () => {
		for (const raw of [
			{ channelHz: DENSE_HZ, hasRecording: true },
			{ channelHz: DENSE_HZ, hasRecording: false },
			{
				channelHz: DENSE_HZ,
				refs: [{ type: "jobId" as const, value: "job-1" }],
			},
		]) {
			const query = normaliseQuery(raw, DEFAULT_ACTIVITY_QUERY_LIMITS)
			const probe = channelMatchStatement(query, "0", "250000")
			expectProbe(planOf(reader, probe.sql, probe.params))
		}
	})
})

describe("both scope plans read the same pages", () => {
	let store: ActivityFixture
	let reader: SqlDatabase

	beforeAll(async () => {
		store = await createFixture({ memory: true })
		reader = await openReadOnly(store.dbPath)
	})

	afterAll(async () => {
		reader.close()
		await store.close()
	})

	function pages(
		query: NormalisedQuery,
		plan: ScopePlan,
		order: "asc" | "desc",
		limit: number,
		low: string,
		high: string,
	): { ids: string[][]; channelMatch: (string | undefined)[] } {
		const ids: string[][] = []
		const channelMatch: (string | undefined)[] = []
		let cursor: string | null = null
		for (;;) {
			const result = runRead(reader, {
				op: "search",
				query,
				order,
				limit,
				low,
				high,
				before: order === "desc" ? cursor : null,
				after: order === "asc" ? cursor : null,
				channelMatch: true,
				plan,
			})
			if (result.op !== "search") throw new Error("not a search")
			channelMatch.push(result.channelMatch)
			ids.push(result.rows.map(row => row.summary.eventId))
			const last = result.rows.at(-1)
			if (result.rows.length < limit || last === undefined)
				return { ids, channelMatch }
			cursor = last.seq
		}
	}

	// Feature: wg24-c2 channels, Property 2: the union and the walk read the same scope
	// Validates: Requirements C2 M1 (dense-scope regression: same matches, order, pages, facet counts and channelMatch in both plans)
	it("every plan pages, facets and answers channelMatch as the model", () => {
		fc.assert(
			fc.property(
				fc.array(rowArb, { maxLength: 60 }),
				scopeArb,
				fc.constantFrom<"asc" | "desc">("asc", "desc"),
				fc.integer({ min: 1, max: 7 }),
				fc.integer({ min: 1, max: 25 }),
				fc.tuple(fc.nat(), fc.nat()),
				(generated, { scope: drawn, near }, order, limit, scanCap, edges) => {
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
						eventId: `p${index}`,
					}))
					const seqs = rows.map(row =>
						store.insert({
							eventId: row.eventId,
							frequencyHz: row.frequencyHz,
							category: row.category,
							refs: [
								...(row.channelHz === null
									? []
									: [
											{
												type: "channelHz" as const,
												value: channelRefValue(row.channelHz),
											},
										]),
								...(row.recorded
									? [
											{
												type: "recordingId" as const,
												value: `rec-${row.eventId}`,
											},
										]
									: []),
							],
						}),
					)
					// Window (low, high] over row indexes [lowIndex, highIndex): seqs are consecutive.
					const base = BigInt(seqs[0] ?? "1") - 1n
					seqs.forEach((seq, index) => {
						expect(BigInt(seq)).toBe(base + BigInt(index) + 1n)
					})
					const lowIndex = edges[0] % (rows.length + 1)
					const highIndex = lowIndex + (edges[1] % (rows.length - lowIndex + 1))
					const low = String(base + BigInt(lowIndex))
					const high = String(base + BigInt(highIndex))
					const inWindow = rows
						.slice(lowIndex, highIndex)
						.filter(row => matches(row, scope))
					const expected = order === "asc" ? inWindow : [...inWindow].reverse()
					const query = normaliseQuery(
						queryOf(scope, near),
						DEFAULT_ACTIVITY_QUERY_LIMITS,
					)
					const channelMatch =
						scope.channel === null
							? undefined
							: inWindow.some(row => row.channelHz === null)
								? "mixed"
								: "exact"
					const newest = [...inWindow].reverse().slice(0, scanCap)
					const counts = new Map<string | null, number>()
					for (const row of newest) {
						const key = row.channelHz === null ? null : String(row.channelHz)
						counts.set(key, (counts.get(key) ?? 0) + 1)
					}
					for (const plan of PLANS) {
						const read = pages(query, plan, order, limit, low, high)
						const want: string[][] = []
						for (let at = 0; at <= expected.length; at += limit)
							want.push(expected.slice(at, at + limit).map(row => row.eventId))
						expect(read.ids, JSON.stringify(plan)).toEqual(want)
						for (const answer of read.channelMatch)
							expect(answer).toBe(channelMatch)
						const facets = runRead(reader, {
							op: "facets",
							query,
							dimensions: ["channel", "category"],
							low,
							high,
							scanCap,
							valueCap: 100,
							plan,
						})
						if (facets.op !== "facets") throw new Error("not facets")
						expect(
							new Map(
								(facets.facets["channel"] ?? []).map(entry => [
									entry.value,
									entry.count,
								]),
							),
						).toEqual(counts)
						expect(facets.scanned).toBe(newest.length)
						expect(facets.truncated).toBe(inWindow.length > scanCap)
						expect(facets.channelMatch).toBe(channelMatch)
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})

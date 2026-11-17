/**
 * The channel scope (`channelHz`, `nearHz` + `toleranceHz`) and the frequency range read as
 * index-driven candidate sets: the query plan drives the search, the facets scan and the
 * channelMatch probe from the refs key and activity_frequency, never from the (low, high] rowid
 * range or a full scan of activity (that walk took about 1 s on a 250 000-row store, past the
 * 250 ms deadline). The plan-selection rules: R0 (no scope) one statement; R1 (a scope and a
 * driver filter: entityKey, a recordingId ref, text, hasRecording=true) the literal statement of
 * 3b991342d, driven by the driver; R3′ (a scope with coarse or per-row filters only) a walk slice
 * from the cursor, then the rest of the window counted to a cap: the union under it, the literal
 * statement at it (facets count first, with the scan cap). Every form answers as a direct model of
 * the scope, and the rows and index entries a read visits are counted, not timed. Synthetic rows only.
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
	countedPlanOf,
	FACETS_WALK_SLICES,
	facetsStatement,
	hasDriver,
	runRead,
	SEARCH_COUNT_CAP,
	searchStatement,
	type ReadOptions,
	splitWindow,
	type StatementForm,
	WALK_SLICE,
	windowOf,
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
				expect(
					countedPlanOf(
						reader,
						query,
						{ low: 0n, high: 250_000n },
						DEFAULT_ACTIVITY_QUERY_LIMITS.facetScan,
					),
					name,
				).toEqual({
					channel: query.channel === null ? "walk" : "union",
					frequency: query.frequencyMin === null ? "walk" : "union",
				})
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
				// With a driver the probe is the literal one (pinned in "the driver filters").
				if (query.channel !== null && !hasDriver(query)) {
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
	entityKey?: string | null
	text?: string | null
}

interface ModelScope {
	channel: { minHz: number; maxHz: number } | null
	frequency: { min: number; max: number } | null
	category: ActivityCategory | null
	hasRecording: boolean | null
	/** A driver filter (R1). */
	entityKey?: string | null
	/** A driver filter (R1): one word of the row text. */
	text?: string | null
	/** A driver filter (R1): the recordingId ref of the row with this event id. */
	recordingOf?: string | null
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
	if (
		scope.entityKey !== undefined &&
		scope.entityKey !== null &&
		row.entityKey !== scope.entityKey
	)
		return false
	if (
		scope.text !== undefined &&
		scope.text !== null &&
		row.text !== scope.text
	)
		return false
	if (
		scope.recordingOf !== undefined &&
		scope.recordingOf !== null &&
		(!row.recorded || row.eventId !== scope.recordingOf)
	)
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
	if (scope.entityKey !== undefined && scope.entityKey !== null)
		query.entityKey = scope.entityKey
	if (scope.text !== undefined && scope.text !== null) query.text = scope.text
	if (scope.recordingOf !== undefined && scope.recordingOf !== null)
		query.refs = [{ type: "recordingId", value: `rec-${scope.recordingOf}` }]
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

/** Rows and scopes with the driver filters too (R1 picks), for the form property. */
const driverRowArb = fc.record({
	frequencyHz: fc.option(carrierArb, { nil: null, freq: 6 }),
	channelHz: fc.option(channelArb, { nil: null, freq: 3 }),
	category: fc.constantFrom<ActivityCategory>("voice", "other"),
	recorded: fc.boolean(),
	entityKey: fc.option(fc.constantFrom("k1", "k2"), { nil: null, freq: 3 }),
	text: fc.option(fc.constantFrom("alpha", "beta"), { nil: null, freq: 3 }),
})
const driverScopeArb = fc.record({
	drawn: scopeArb,
	entityKey: fc.option(fc.constantFrom("k1", "k2"), { nil: null, freq: 2 }),
	text: fc.option(fc.constantFrom("alpha", "beta"), { nil: null, freq: 2 }),
	recordingOf: fc.option(fc.integer({ min: 0, max: 59 }), {
		nil: null,
		freq: 4,
	}),
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

	// Feature: activity channels, Property 1: index-driven channel and frequency scopes are exact
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

/** Inserts `count` rows of one shape into `store`, numbering event ids from `counter`. */
function insertRows(
	store: ActivityFixture,
	counter: { next: number },
	count: number,
	row: {
		frequencyHz: number | null
		channelHz?: number
		entityKey?: string
		producedAt?: string
	},
): void {
	for (let index = 0; index < count; index++)
		store.insert({
			eventId: `d${String(counter.next++)}`,
			category: "aircraft",
			frequencyHz: row.frequencyHz,
			...(row.entityKey === undefined ? {} : { entityKey: row.entityKey }),
			...(row.producedAt === undefined ? {} : { producedAt: row.producedAt }),
			...(row.channelHz === undefined
				? {}
				: {
						refs: [
							{ type: "channelHz", value: channelRefValue(row.channelHz) },
						],
					}),
		})
}

describe("the walk slice and the facets plan", () => {
	let store: ActivityFixture
	let reader: SqlDatabase
	const counter = { next: 0 }

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

	it("the window has one bound per side: max(low, after), min(high, before - 1)", () => {
		expect(
			windowOf({ low: "5", high: "90", before: null, after: null }),
		).toEqual({ low: 5n, high: 90n })
		expect(
			windowOf({ low: "5", high: "90", before: "40", after: null }),
		).toEqual({ low: 5n, high: 39n })
		expect(
			windowOf({ low: "5", high: "90", before: "91", after: null }),
		).toEqual({ low: 5n, high: 90n })
		expect(
			windowOf({ low: "5", high: "90", before: null, after: "70" }),
		).toEqual({ low: 70n, high: 90n })
		expect(
			windowOf({ low: "5", high: "90", before: null, after: "2" }),
		).toEqual({ low: 5n, high: 90n })
		// Past MAX_SAFE_INTEGER the bound stays exact.
		const big = "9007199254740993"
		expect(windowOf({ low: "0", high: big, before: big, after: null })).toEqual(
			{
				low: 0n,
				high: 9007199254740992n,
			},
		)
		const search = searchStatement({
			op: "search",
			query: normaliseQuery({}, DEFAULT_ACTIVITY_QUERY_LIMITS),
			order: "asc",
			limit: 5,
			low: "0",
			high: "100",
			before: "60",
			after: "50",
		})
		expect(search.sql.match(/\bseq [<>]=? \?/g)).toEqual([
			"seq > ?",
			"seq <= ?",
		])
		expect(search.params.slice(0, 2)).toEqual([50, 59])
	})

	it("the walk slice is WALK_SLICE rows from the cursor, at and past its size", () => {
		const window = { low: 10n, high: 10n + BigInt(WALK_SLICE) }
		expect(splitWindow(window, "desc", WALK_SLICE)).toEqual({
			first: window,
			rest: null,
		})
		const longer = { low: 9n, high: 10n + BigInt(WALK_SLICE) }
		expect(splitWindow(longer, "desc", WALK_SLICE)).toEqual({
			first: { low: 10n, high: longer.high },
			rest: { low: 9n, high: 10n },
		})
		expect(splitWindow(longer, "asc", WALK_SLICE)).toEqual({
			first: { low: 9n, high: 9n + BigInt(WALK_SLICE) },
			rest: { low: 9n + BigInt(WALK_SLICE), high: longer.high },
		})
		expect(FACETS_WALK_SLICES * WALK_SLICE).toBeGreaterThan(
			DEFAULT_ACTIVITY_QUERY_LIMITS.facetScan,
		)
	})

	const facetsPlan = (raw: ActivityQuery, cap: number, high = 1_000_000n) =>
		countedPlanOf(
			reader,
			normaliseQuery(raw, DEFAULT_ACTIVITY_QUERY_LIMITS),
			{ low: 0n, high },
			cap,
		)

	it("a facets term reads its candidates under the scan cap and walks at it", () => {
		const cap = 40
		const marker = BigInt(
			store.insert({ eventId: `m${String(counter.next++)}`, frequencyHz: 1 }),
		)
		insertRows(store, counter, cap - 1, { frequencyHz: DENSE_HZ })
		expect(facetsPlan(DENSE_SCOPES["frequency range"] ?? {}, cap)).toEqual({
			channel: "walk",
			frequency: "union",
		})
		expect(facetsPlan({ channelHz: DENSE_HZ }, cap)).toEqual({
			channel: "union",
			frequency: "walk",
		})
		insertRows(store, counter, 1, { frequencyHz: DENSE_HZ + 1 })
		expect(facetsPlan(DENSE_SCOPES["frequency range"] ?? {}, cap)).toEqual(WALK)
		expect(facetsPlan({ channelHz: DENSE_HZ }, cap)).toEqual(WALK)
		// Another channel stays sparse; the count reads the window only (one dense row).
		expect(facetsPlan({ channelHz: CHANNEL_HZ }, cap).channel).toBe("union")
		expect(facetsPlan({ channelHz: DENSE_HZ }, cap, marker + 1n).channel).toBe(
			"union",
		)
	})

	it("a facets channel count adds its halves once: a stored channel never counts as a fallback too", () => {
		const cap = 40
		// Stored channel DENSE_HZ and own frequency DENSE_HZ: one candidate each, not two.
		insertRows(store, counter, cap / 2, {
			frequencyHz: DENSE_HZ,
			channelHz: DENSE_HZ,
		})
		insertRows(store, counter, cap / 2 - 1, { frequencyHz: DENSE_HZ })
		expect(facetsPlan({ channelHz: DENSE_HZ }, cap).channel).toBe("union")
		insertRows(store, counter, 1, { frequencyHz: null, channelHz: DENSE_HZ })
		expect(facetsPlan({ channelHz: DENSE_HZ }, cap).channel).toBe("walk")
	})

	it("the walk form drives from the window's seq range and stops at LIMIT; the probe never builds a candidate list", () => {
		insertRows(store, counter, 64, { frequencyHz: DENSE_HZ })
		for (const [name, raw] of Object.entries(DENSE_SCOPES)) {
			const query = normaliseQuery(raw, DEFAULT_ACTIVITY_QUERY_LIMITS)
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
				WALK,
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
				WALK,
			)
			for (const text of [
				planOf(reader, search.sql, search.params),
				planOf(reader, facets.sql, facets.params),
			]) {
				const detail = `${name}:\n${text}`
				// Driven by a seq-ordered walk of the window: the rowid range, or the
				// (category, seq) key of an equality filter.
				expect(text, detail).toMatch(
					/^SEARCH activity USING (INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)|INDEX activity_category \(category=\? AND seq>\? AND seq<\?\))$/m,
				)
				expect(text, detail).not.toContain("LIST SUBQUERY")
				expect(text, detail).not.toContain("activity_frequency")
				expect(text, detail).not.toContain("USE TEMP B-TREE FOR ORDER BY")
			}
			// One refs probe per walked row for the channel scope.
			if (query.channel !== null)
				expect(search.sql.match(/FROM activity_refs/g)).toHaveLength(1)
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

	it("the probe stays per-row beside hasRecording=false and other refs", () => {
		for (const raw of [
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

/**
 * A reader that counts the activity rows each statement visits and the candidate index entries
 * it reads: every outer `FROM activity WHERE` gets a leading `visit(activity.seq)` term, and every
 * candidate read (a refs list or range that is not a per-row probe, the fallback and frequency
 * ranges of activity_frequency, in the union, the counts and the literal lists) a leading
 * `entry(…)` term: non-deterministic user functions, so SQLite evaluates them on every row or
 * entry its loop reaches, inside the window or not. Per-row refs probes are not entries (at most
 * a few per visited row). It also records each statement as the read issued it.
 */
function countingReader(path: string): {
	db: SqlDatabase
	visits(): number
	entries(): number
	statements(): { sql: string; params: SqlValue[] }[]
	reset(): void
	close(): void
} {
	const raw = new DatabaseSync(path, { readOnly: true })
	let visited = 0
	let entries = 0
	let issued: { sql: string; params: SqlValue[] }[] = []
	raw.function("visit", { deterministic: false, varargs: true }, () => {
		visited += 1
		return 1
	})
	raw.function("entry", { deterministic: false, varargs: true }, () => {
		entries += 1
		return 1
	})
	const counted = (sql: string): string =>
		sql
			.replaceAll(
				"FROM activity WHERE ",
				"FROM activity WHERE visit(activity.seq) AND ",
			)
			.replace(
				/FROM activity_refs WHERE (?!activity_refs\.seq = )/g,
				"FROM activity_refs WHERE entry(activity_refs.seq) AND ",
			)
			.replace(
				/FROM activity AS (fallback|ranged) INDEXED BY activity_frequency WHERE /g,
				"FROM activity AS $1 INDEXED BY activity_frequency WHERE entry($1.seq) AND ",
			)
			.replaceAll(
				"FROM activity INDEXED BY activity_frequency WHERE ",
				"FROM activity INDEXED BY activity_frequency WHERE visit(activity.seq) AND ",
			)
	const db: SqlDatabase = {
		prepare(sql) {
			const statement = raw.prepare(counted(sql))
			const record = (params: SqlValue[]) => {
				if (!sql.startsWith("SELECT key, value FROM store_meta"))
					issued.push({ sql, params })
			}
			return {
				all: (...params) => {
					record(params)
					return statement.all(...params)
				},
				get: (...params) => {
					record(params)
					return statement.get(...params) as Record<string, unknown> | undefined
				},
			}
		},
		exec: sql => raw.exec(sql),
		close: () => raw.close(),
	}
	return {
		db,
		visits: () => visited,
		entries: () => entries,
		statements: () => issued,
		reset: () => {
			visited = 0
			entries = 0
			issued = []
		},
		close: () => raw.close(),
	}
}

describe("reads visit O(page + slice + candidates) rows", () => {
	let store: ActivityFixture
	let counting: ReturnType<typeof countingReader>
	const counter = { next: 0 }
	const OLD = 5_000
	const NEWER = 20_000
	/** Rows inside the dense scope that the few-match filters select. */
	const FEW = 3
	let high = "0"

	beforeAll(async () => {
		store = await createFixture({ memory: true })
		// Clustered old: OLD rows of the channel (half stored, half by own frequency), then
		// NEWER rows at another frequency (the dense scope), FEW of them in its middle with an
		// entity, an older producedAt, a discovery ref and a rare category.
		insertRows(store, counter, OLD / 2, {
			frequencyHz: CHANNEL_HZ,
			channelHz: CHANNEL_HZ,
		})
		insertRows(store, counter, OLD / 2, { frequencyHz: CHANNEL_HZ + 300 })
		insertRows(store, counter, NEWER / 2, { frequencyHz: DENSE_HZ })
		for (let index = 0; index < FEW; index++)
			store.insert({
				eventId: `few${String(index)}`,
				category: "voice",
				frequencyHz: DENSE_HZ,
				entityKey: "few",
				producedAt: "2025-06-01T00:00:00.000Z",
				refs: [{ type: "discoveryId", value: "few" }],
			})
		insertRows(store, counter, NEWER / 2 - FEW, { frequencyHz: DENSE_HZ })
		high = store.insert({ eventId: "last", frequencyHz: DENSE_HZ })
		counting = countingReader(store.dbPath)
	}, 120_000)

	afterAll(async () => {
		counting.close()
		await store.close()
	})

	function search(
		raw: ActivityQuery,
		order: "asc" | "desc",
		limit: number,
		cursor: string | null = null,
		options: ReadOptions = {},
	): string[] {
		counting.reset()
		const result = runRead(
			counting.db,
			{
				op: "search",
				query: normaliseQuery(raw, DEFAULT_ACTIVITY_QUERY_LIMITS),
				order,
				limit,
				low: "0",
				high,
				before: order === "desc" ? cursor : null,
				after: order === "asc" ? cursor : null,
			},
			options,
		)
		if (result.op !== "search") throw new Error("not a search")
		return result.rows.map(row => row.seq)
	}

	it("the counter sees every row a walk reaches: an empty channel walks one slice exactly", () => {
		expect(search({ channelHz: CHANNEL_HZ + 5 * STEP }, "desc", 10)).toEqual([])
		expect(counting.visits()).toBe(WALK_SLICE)
		// The count of the rest finds no candidate (none in its ranges), so the union reads none.
		expect(counting.entries()).toBe(0)
		expect(
			search({ channelHz: CHANNEL_HZ + 5 * STEP }, "asc", 10, null, {
				walkSlice: 300,
			}),
		).toEqual([])
		expect(counting.visits()).toBe(300)
	})

	it("a channel clustered behind newer rows: one slice, then the union under the count cap or the literal statement at it", () => {
		const total = OLD + NEWER + 1
		for (const order of ["desc", "asc"] as const) {
			const seqs = search({ channelHz: CHANNEL_HZ }, order, 51)
			expect(seqs).toHaveLength(51)
			const visited = counting.visits()
			expect(visited, order).toBeLessThanOrEqual(WALK_SLICE + total)
			expect(visited, order).toBeLessThan(total)
		}
		// The newest 51 scope rows are the last of the old cluster.
		expect(search({ channelHz: CHANNEL_HZ }, "desc", 51)[0]).toBe(
			String(BigInt(high) - BigInt(NEWER) - 1n),
		)
		for (const raw of [
			{ channelHz: CHANNEL_HZ },
			{ frequencyHz: { min: CHANNEL_HZ - 1, max: CHANNEL_HZ + 400 } },
		]) {
			const label = JSON.stringify(raw)
			// Under the cap (OLD candidates < 8 192): the union reads the candidates only.
			search(raw, "desc", 51, null, { walkSlice: 1_024, searchCountCap: 8_192 })
			expect(counting.visits(), label).toBeLessThanOrEqual(1_024 + 51)
			// The count and the union each read the refs range and the fallback's whole
			// frequency range (the stored rows in it too, rejected by their channel ref).
			expect(counting.entries(), label).toBeLessThanOrEqual(3 * OLD)
			// At the cap (OLD ≥ SEARCH_COUNT_CAP): the literal statement walks the rest as
			// 3b991342d did, down to the cluster; the count stops at the cap.
			expect(OLD).toBeGreaterThanOrEqual(SEARCH_COUNT_CAP)
			expect(search(raw, "desc", 51, null, { walkSlice: 1_024 })).toHaveLength(
				51,
			)
			expect(counting.visits(), label).toBeGreaterThan(NEWER)
			expect(counting.visits(), label).toBeLessThanOrEqual(NEWER + 1 + 51)
		}
	})

	it("a dense scope with a few-match driver reads the driver's rows; with a few-match per-row filter, 3b991342d's walk", () => {
		const total = OLD + NEWER + 1
		const dense = [
			{ channelHz: DENSE_HZ },
			{ frequencyHz: { min: DENSE_HZ - 1, max: DENSE_HZ + 1 } },
		]
		for (const scope of dense) {
			// R1: entityKey drives (activity_entity): FEW rows visited, no candidate read but
			// the channel's refs list (no stored channel at DENSE_HZ: none).
			const label = JSON.stringify(scope)
			expect(search({ ...scope, entityKey: "few" }, "desc", 51)).toHaveLength(
				FEW,
			)
			expect(counting.visits(), label).toBe(FEW)
			expect(counting.entries(), label).toBe(0)
			// R3′ with a rare single-value category: the (category, seq) key walks FEW rows in
			// the slice and the rest; the count reads up to the cap of scope entries.
			expect(
				search({ ...scope, categories: ["voice"] }, "desc", 51, null, {
					walkSlice: 1_024,
				}),
			).toHaveLength(FEW)
			expect(counting.visits(), label).toBe(FEW)
			expect(counting.entries(), label).toBeGreaterThan(0)
			expect(counting.entries(), label).toBeLessThanOrEqual(
				SEARCH_COUNT_CAP + 1_024,
			)
			// R3′ with a per-row filter (producedAt, a discovery ref, hasRecording=false): the
			// slice, the count to the cap, then the literal statement over the rest (the walk
			// of 3b991342d), FEW matches found.
			for (const other of [
				{ producedAt: { to: "2025-12-31T00:00:00Z" } },
				{ refs: [{ type: "discoveryId" as const, value: "few" }] },
			]) {
				const name = `${label} ${JSON.stringify(other)}`
				expect(
					search({ ...scope, ...other }, "desc", 51, null, {
						walkSlice: 1_024,
					}),
					name,
				).toHaveLength(FEW)
				expect(counting.visits(), name).toBeLessThanOrEqual(total)
				expect(counting.entries(), name).toBeLessThanOrEqual(
					SEARCH_COUNT_CAP + 1_024,
				)
			}
		}
	})

	it("an ASC page after a cursor near the end and a deep DESC page visit O(page) rows", () => {
		const end = BigInt(high)
		const near = String(end - 10n)
		expect(search({}, "asc", 5, near)).toHaveLength(5)
		expect(counting.visits()).toBeLessThanOrEqual(5)
		expect(search({}, "desc", 5, "11")).toHaveLength(5)
		expect(counting.visits()).toBeLessThanOrEqual(5)
		// A scoped page walks from the cursor too.
		expect(search({ channelHz: DENSE_HZ }, "asc", 5, near)).toHaveLength(5)
		expect(counting.visits()).toBeLessThanOrEqual(5)
		expect(search({ channelHz: CHANNEL_HZ }, "desc", 5, "11")).toHaveLength(5)
		expect(counting.visits()).toBeLessThanOrEqual(10)
	})

	function facets(raw: ActivityQuery, scanCap: number, walkSlice?: number) {
		counting.reset()
		const result = runRead(
			counting.db,
			{
				op: "facets",
				query: normaliseQuery(raw, DEFAULT_ACTIVITY_QUERY_LIMITS),
				dimensions: ["channel", "category"],
				low: "0",
				high,
				scanCap,
				valueCap: 100,
			},
			walkSlice === undefined ? {} : { walkSlice },
		)
		if (result.op !== "facets") throw new Error("not facets")
		return result
	}

	it("facets of a clustered channel read its candidates; past the scan cap a bounded walk, then the rest by its count", () => {
		const scanCap = DEFAULT_ACTIVITY_QUERY_LIMITS.facetScan
		const sparse = facets({ channelHz: CHANNEL_HZ }, scanCap)
		expect(sparse.scanned).toBe(OLD)
		expect(sparse.truncated).toBe(false)
		// The scan's OLD rows plus the channelMatch probe, which walks the fallback rows until
		// it finds one with no stored channel (at most the channel's OLD candidates again).
		expect(counting.visits()).toBeLessThanOrEqual(2 * OLD)
		// A small scan cap: the channel holds more candidates than it, so the walk reads
		// FACETS_WALK_SLICES slices of newer rows (none match); the rest holds more than the cap
		// too, so the literal statement walks it to the cluster.
		const walkSlice = 256
		const walked = facets({ channelHz: CHANNEL_HZ }, 100, walkSlice)
		expect(walked.scanned).toBe(100)
		expect(walked.truncated).toBe(true)
		expect(
			new Map(
				(walked.facets["channel"] ?? []).map(entry => [
					entry.value,
					entry.count,
				]),
			),
		).toEqual(new Map([[null, 100]]))
		// Every newer row, the 101 matches and the extra row's lookup, plus the channelMatch
		// probe's walk of at most the channel's OLD fallback rows.
		expect(counting.visits()).toBeLessThanOrEqual(NEWER + 1 + 101 + 1 + OLD)
		// A dense scope reaches the scan cap inside the walk.
		const dense = facets({ channelHz: DENSE_HZ }, 100, walkSlice)
		expect(dense.scanned).toBe(100)
		// The walk's 101 rows, the extra row's lookup and the probe's first fallback row.
		expect(counting.visits()).toBeLessThanOrEqual(101 + 1 + 1)
		// A dense scope and a few-match driver: the literal statement, driven by the entity.
		const driven = facets({ channelHz: DENSE_HZ, entityKey: "few" }, scanCap)
		expect(driven.scanned).toBe(FEW)
		expect(driven.channelMatch).toBe("mixed")
		// The scan's FEW rows and the literal probe's first (driven by the entity too).
		expect(counting.visits()).toBe(FEW + 1)
		expect(counting.entries()).toBe(0)
		// A dense scope and a rare category: the count, the bounded walk of the category key,
		// then the rest by its count.
		const rare = facets({ channelHz: DENSE_HZ, categories: ["voice"] }, 100)
		expect(rare.scanned).toBe(FEW)
		// Known gap: with no driver the channelMatch probe reads the fallback range from
		// activity_frequency, so it visits every fallback row before it finds an old one.
		expect(counting.visits()).toBeGreaterThan(FEW)
	})
})

/** The plan-selection table, one EXPLAIN pin per cell of the statements a read issues. */
describe("the plan-selection table: R0, R1 and R3′ per cell", () => {
	let store: ActivityFixture
	let counting: ReturnType<typeof countingReader>
	let plain: DatabaseSync
	let high = "0"
	const WALK = 64
	const COUNT_CAP = 32
	const SCAN_CAP = 40

	beforeAll(async () => {
		store = await createFixture({ memory: true })
		// Sparse (old): 5 rows of CHANNEL_HZ stored, 5 by own frequency. Dense (newer): 600
		// rows at DENSE_HZ, half with a stored channel, and 3 few-match rows in their middle.
		const counter = { next: 0 }
		insertRows(store, counter, 5, {
			frequencyHz: CHANNEL_HZ,
			channelHz: CHANNEL_HZ,
		})
		insertRows(store, counter, 5, { frequencyHz: CHANNEL_HZ + 300 })
		for (let index = 0; index < 300; index++) {
			insertRows(store, counter, 1, {
				frequencyHz: DENSE_HZ,
				channelHz: DENSE_HZ,
			})
			insertRows(store, counter, 1, { frequencyHz: DENSE_HZ })
			if (index === 150)
				for (let few = 0; few < 3; few++)
					store.insert({
						eventId: `few${String(few)}`,
						category: "voice",
						frequencyHz: DENSE_HZ,
						entityKey: "few",
						producedAt: "2025-06-01T00:00:00.000Z",
						text: "alpha",
						refs: [
							{ type: "discoveryId", value: "few" },
							{ type: "recordingId", value: `rec-few${String(few)}` },
						],
					})
		}
		high = store.insert({ eventId: "last", frequencyHz: DENSE_HZ })
		counting = countingReader(store.dbPath)
		plain = new DatabaseSync(store.dbPath, { readOnly: true })
	}, 60_000)

	afterAll(async () => {
		plain.close()
		counting.close()
		await store.close()
	})

	type Role = "count" | "probe" | "extra" | "main"
	function roleOf(sql: string): Role {
		if (sql.startsWith("SELECT COUNT(*)")) return "count"
		if (sql.startsWith("SELECT 1 AS one")) return "probe"
		if (sql.endsWith("FROM activity WHERE seq = ?")) return "extra"
		return "main"
	}

	/** The statements `run` issued, by role, each as its EXPLAIN text. */
	function issued(run: () => void): { role: Role; plan: string }[] {
		counting.reset()
		run()
		return counting.statements().map(({ sql, params }) => ({
			role: roleOf(sql),
			plan: planOf(plain, sql, params),
		}))
	}

	function searchOf(raw: ActivityQuery) {
		return issued(() => {
			runRead(
				counting.db,
				{
					op: "search",
					query: normaliseQuery(raw, DEFAULT_ACTIVITY_QUERY_LIMITS),
					order: "desc",
					limit: 51,
					low: "0",
					high,
					before: null,
					after: null,
					channelMatch: true,
				},
				{ walkSlice: WALK, searchCountCap: COUNT_CAP },
			)
		})
	}

	function facetsOf(raw: ActivityQuery) {
		return issued(() => {
			runRead(
				counting.db,
				{
					op: "facets",
					query: normaliseQuery(raw, DEFAULT_ACTIVITY_QUERY_LIMITS),
					dimensions: ["channel", "category"],
					low: "0",
					high,
					scanCap: SCAN_CAP,
					valueCap: 100,
				},
				{ walkSlice: WALK / FACETS_WALK_SLICES },
			)
		})
	}

	const SCOPED: Record<
		string,
		{ sparse: ActivityQuery; dense: ActivityQuery }
	> = {
		channelHz: {
			sparse: { channelHz: CHANNEL_HZ },
			dense: { channelHz: DENSE_HZ },
		},
		nearHz: {
			sparse: { nearHz: CHANNEL_HZ, toleranceHz: 10_000 },
			dense: { nearHz: DENSE_HZ, toleranceHz: 10_000 },
		},
		frequency: {
			sparse: { frequencyHz: { min: CHANNEL_HZ - 1, max: CHANNEL_HZ + 400 } },
			dense: { frequencyHz: { min: DENSE_HZ - 1, max: DENSE_HZ + 1 } },
		},
	}

	const DRIVERS: Record<string, { query: ActivityQuery; driver: RegExp }> = {
		entityKey: {
			query: { entityKey: "few" },
			driver:
				/^SEARCH activity USING INDEX activity_entity \(entity_key=\? AND seq>\? AND seq<\?\)$/m,
		},
		"recordingId ref": {
			query: { refs: [{ type: "recordingId", value: "rec-few1" }] },
			driver:
				/^SEARCH activity USING INTEGER PRIMARY KEY \(rowid=\?\)\nLIST SUBQUERY \d+\nSEARCH activity_refs USING PRIMARY KEY \(ref_type=\? AND ref_value=\?\)$/m,
		},
		text: {
			query: { text: "alpha" },
			driver:
				/^SEARCH activity USING INTEGER PRIMARY KEY \(rowid=\?\)\nLIST SUBQUERY \d+\nSCAN activity_fts VIRTUAL TABLE INDEX 0:M1$/m,
		},
		"hasRecording=true": {
			query: { hasRecording: true },
			driver:
				/^SEARCH activity USING INTEGER PRIMARY KEY \(rowid=\?\)\nLIST SUBQUERY \d+\nSEARCH activity_refs USING PRIMARY KEY \(ref_type=\?\)$/m,
		},
	}

	/**
	 * Driven by the driver: its index or list. Beside a single category the planner may key the
	 * (category, seq) index instead: by the driver's list (`seq=?`), or, beside entityKey, as a
	 * walk of the category (its choice between two drivers, as in 3b991342d).
	 */
	function expectDriven(
		plan: string,
		driverName: string,
		withCategory: boolean,
		detail: string,
	): void {
		const driver = DRIVERS[driverName]?.driver
		if (driver === undefined) throw new Error(driverName)
		if (!withCategory) {
			expect(plan, detail).toMatch(driver)
			return
		}
		if (driverName === "entityKey") {
			expect(plan, detail).toMatch(
				/^SEARCH activity USING (INDEX activity_entity \(entity_key=\? AND seq>\? AND seq<\?\)|(COVERING )?INDEX activity_category \(category=\? AND seq>\? AND seq<\?\))$/m,
			)
			return
		}
		const list = driver.source.split("\\n").slice(1).join("\n")
		expect(plan, detail).toMatch(
			new RegExp(
				`^SEARCH activity USING (INTEGER PRIMARY KEY \\(rowid=\\?\\)|(COVERING )?INDEX activity_category \\(category=\\? AND seq=\\? AND rowid>\\? AND rowid<\\?\\))\n${list}`,
				"m",
			),
		)
	}

	/** The literal statement's channel term: its refs range as a list (3b991342d's term). */
	const REFS_RANGE_LIST =
		/LIST SUBQUERY \d+\nSEARCH activity_refs USING PRIMARY KEY \(ref_type=\? AND ref_value>\? AND ref_value<\?\)/

	/** The union: candidates by rowid from the scope's index range(s). */
	function expectUnion(plan: string, scope: string, detail: string): void {
		expect(plan, detail).toMatch(
			/^SEARCH activity USING (INTEGER PRIMARY KEY \(rowid=\?\)|(COVERING )?INDEX activity_category \(category=\? AND seq=\? AND rowid>\? AND rowid<\?\))$/m,
		)
		expect(plan, detail).toContain("LIST SUBQUERY")
		expect(plan, detail).toMatch(
			scope === "frequency"
				? /SEARCH ranged USING COVERING INDEX activity_frequency/
				: /SEARCH fallback USING COVERING INDEX activity_frequency/,
		)
	}

	/** The seq-ordered walk of a window (rowid range or the (category, seq) key). */
	const SEQ_WALK =
		/^SEARCH activity USING (INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)|(COVERING )?INDEX activity_category \(category=\? AND seq>\? AND seq<\?\))$/m

	it("R0: no scope reads one statement", () => {
		for (const raw of [
			{},
			{ categories: ["voice"] },
			{ entityKey: "few" },
		] as ActivityQuery[]) {
			const statements = searchOf(raw)
			expect(
				statements.map(s => s.role),
				JSON.stringify(raw),
			).toEqual(["main"])
		}
		const unscoped = searchOf({})
		expect(unscoped[0]?.plan).toMatch(
			/^SEARCH activity USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)$/m,
		)
	})

	it("R1: a scope and any driver read one literal statement, driven by the driver, sparse or dense", () => {
		for (const [scopeName, { sparse, dense }] of Object.entries(SCOPED))
			for (const [density, scope] of Object.entries({ sparse, dense }))
				for (const [driverName, { query }] of Object.entries(DRIVERS))
					for (const other of [
						{},
						{ categories: ["voice" as const] },
						{ producedAt: { to: "2025-12-31T00:00:00Z" } },
					]) {
						const raw = { ...scope, ...query, ...other }
						const label = `${scopeName} ${density} + ${driverName} ${JSON.stringify(other)}`
						for (const [op, statements] of [
							["search", searchOf(raw)],
							["facets", facetsOf(raw)],
						] as const) {
							const main = statements.filter(s => s.role === "main")
							expect(main, `${label} ${op}`).toHaveLength(1)
							expect(
								statements.some(s => s.role === "count"),
								`${label} ${op}`,
							).toBe(false)
							const plan = main[0]?.plan ?? ""
							const detail = `${label} ${op}:\n${plan}`
							expectDriven(plan, driverName, "categories" in other, detail)
							expect(plan, detail).not.toContain("activity_frequency")
							if (scopeName === "frequency")
								expect(plan.includes("LIST SUBQUERY"), detail).toBe(
									driverName !== "entityKey",
								)
							else expect(plan, detail).toMatch(REFS_RANGE_LIST)
							// The probe of 3b991342d, driven by the driver.
							if (scopeName !== "frequency") {
								const probe =
									statements.find(s => s.role === "probe")?.plan ?? ""
								expectDriven(
									probe,
									driverName,
									"categories" in other,
									`${label} ${op} probe:\n${probe}`,
								)
								expect(probe, `${label} probe`).not.toContain(
									"activity_frequency",
								)
							}
						}
					}
	})

	it("R3′ sparse: the slice, the count under the cap, then the union over the rest", () => {
		for (const [scopeName, { sparse }] of Object.entries(SCOPED))
			for (const other of [
				{},
				{ categories: ["other" as const] },
				{ categories: ["other" as const, "voice" as const] },
				{ producedAt: { to: "2026-12-31T00:00:00Z" } },
				{ refs: [{ type: "discoveryId" as const, value: "x" }] },
				{ hasRecording: false },
			]) {
				const label = `${scopeName} sparse ${JSON.stringify(other)}`
				const raw = { ...sparse, ...other }
				const search = searchOf(raw)
				expect(
					search.map(s => s.role).filter(r => r !== "probe" && r !== "count"),
					label,
				).toEqual(["main", "main"])
				expect(
					search.some(s => s.role === "count"),
					label,
				).toBe(true)
				const [slice, union] = search.filter(s => s.role === "main")
				expect(slice?.plan, `${label} slice:\n${slice?.plan}`).toMatch(SEQ_WALK)
				// No candidate list of the scope (hasRecording=false keeps its own list).
				expect(slice?.plan, label).not.toMatch(REFS_RANGE_LIST)
				expect(slice?.plan, label).not.toContain("activity_frequency")
				expectUnion(
					union?.plan ?? "",
					scopeName,
					`${label} union:\n${union?.plan}`,
				)
				// Facets: the count under the scan cap, then one union statement.
				const facets = facetsOf(raw).filter(s => s.role === "main")
				expect(facets, label).toHaveLength(1)
				expectUnion(
					facets[0]?.plan ?? "",
					scopeName,
					`${label} facets:\n${facets[0]?.plan}`,
				)
			}
	})

	it("R3′ dense: the slice fills the page, or the count at the cap reads the literal statement over the rest", () => {
		for (const [scopeName, { dense }] of Object.entries(SCOPED)) {
			const full = searchOf(dense)
			expect(
				full.filter(s => s.role !== "probe").map(s => s.role),
				scopeName,
			).toEqual(["main"])
			expect(full[0]?.plan, scopeName).toMatch(SEQ_WALK)
			for (const other of [
				{ categories: ["voice" as const] },
				{ categories: ["voice" as const, "paging" as const] },
				{ producedAt: { to: "2025-12-31T00:00:00Z" } },
				{ refs: [{ type: "discoveryId" as const, value: "few" }] },
				{ hasRecording: false, categories: ["voice" as const] },
			]) {
				const label = `${scopeName} dense ${JSON.stringify(other)}`
				const raw = { ...dense, ...other }
				for (const [op, statements] of [
					["search", searchOf(raw)],
					["facets", facetsOf(raw)],
				] as const) {
					const main = statements.filter(s => s.role === "main")
					expect(main, `${label} ${op}`).toHaveLength(2)
					expect(
						statements.some(s => s.role === "count"),
						`${label} ${op}`,
					).toBe(true)
					const rest = main[1]?.plan ?? ""
					const detail = `${label} ${op} rest:\n${rest}`
					expect(rest, detail).toMatch(SEQ_WALK)
					expect(rest, detail).not.toContain("activity_frequency")
					// No candidate list of the scope: the frequency range is a per-row term; the
					// channel keeps 3b991342d's refs-range list beside the walk.
					// (hasRecording=false keeps its own list of recording refs.)
					expect(rest, detail).not.toMatch(/SEARCH (ranged|fallback)/)
					if (scopeName === "frequency")
						expect(rest, detail).not.toMatch(
							/LIST SUBQUERY \d+\nSEARCH activity_refs USING PRIMARY KEY \(ref_type=\? AND ref_value/,
						)
					else expect(rest, detail).toMatch(REFS_RANGE_LIST)
				}
			}
		}
	})

	it("channelMatch: activity_frequency without a driver, the driver's index with one", () => {
		for (const raw of [
			{ channelHz: DENSE_HZ },
			{ channelHz: DENSE_HZ, categories: ["voice" as const] },
			{ channelHz: DENSE_HZ, producedAt: { to: "2025-12-31T00:00:00Z" } },
			{ channelHz: DENSE_HZ, hasRecording: false },
		]) {
			const probe = searchOf(raw).find(s => s.role === "probe")?.plan ?? ""
			expectProbe(probe)
		}
		for (const [name, { query, driver }] of Object.entries(DRIVERS)) {
			const probe =
				searchOf({ channelHz: DENSE_HZ, ...query }).find(
					s => s.role === "probe",
				)?.plan ?? ""
			expect(probe, `${name}:\n${probe}`).toMatch(driver)
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
		options: ReadOptions,
		order: "asc" | "desc",
		limit: number,
		low: string,
		high: string,
	): { ids: string[][]; channelMatch: (string | undefined)[] } {
		const ids: string[][] = []
		const channelMatch: (string | undefined)[] = []
		let cursor: string | null = null
		for (;;) {
			const result = runRead(
				reader,
				{
					op: "search",
					query,
					order,
					limit,
					low,
					high,
					before: order === "desc" ? cursor : null,
					after: order === "asc" ? cursor : null,
					channelMatch: true,
				},
				options,
			)
			if (result.op !== "search") throw new Error("not a search")
			channelMatch.push(result.channelMatch)
			ids.push(result.rows.map(row => row.summary.eventId))
			const last = result.rows.at(-1)
			if (result.rows.length < limit || last === undefined)
				return { ids, channelMatch }
			cursor = last.seq
		}
	}

	// Feature: activity channels, Property 2: every form and the R0/R1/R3′ picks read the same scope
	// Validates: Requirements C2 M1 (dense-scope regression and bounded walk: same matches, order, pages, facet counts and channelMatch in every plan, the literal statement and the picks, at and past the walk slice and the count cap)
	it("every form and the R0/R1/R3′ picks page, facet and answer channelMatch as the model", () => {
		fc.assert(
			fc.property(
				fc.array(driverRowArb, { maxLength: 60 }),
				driverScopeArb,
				fc.constantFrom<"asc" | "desc">("asc", "desc"),
				fc.integer({ min: 1, max: 7 }),
				fc.integer({ min: 1, max: 25 }),
				fc.tuple(fc.nat(), fc.nat()),
				fc.integer({ min: 1, max: 12 }),
				fc.integer({ min: 1, max: 12 }),
				(
					generated,
					{ drawn: { scope: drawnScope, near }, entityKey, text, recordingOf },
					order,
					limit,
					scanCap,
					edges,
					walkSlice,
					searchCountCap,
				) => {
					const drawn: ModelScope = {
						...drawnScope,
						entityKey,
						text,
						recordingOf: recordingOf === null ? null : `p${recordingOf}`,
					}
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
							...(row.entityKey === undefined
								? {}
								: { entityKey: row.entityKey }),
							...(row.text === null ? {} : { text: row.text }),
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
					const forms: StatementForm[] = [...PLANS, "literal"]
					const runs: ReadOptions[] = [
						...forms.map(plan => ({ plan })),
						{},
						{ walkSlice },
						{ walkSlice, searchCountCap },
					]
					for (const options of runs) {
						const label = JSON.stringify(options)
						const read = pages(query, options, order, limit, low, high)
						const want: string[][] = []
						for (let at = 0; at <= expected.length; at += limit)
							want.push(expected.slice(at, at + limit).map(row => row.eventId))
						expect(read.ids, label).toEqual(want)
						for (const answer of read.channelMatch)
							expect(answer).toBe(channelMatch)
						const facets = runRead(
							reader,
							{
								op: "facets",
								query,
								dimensions: ["channel", "category"],
								low,
								high,
								scanCap,
								valueCap: 100,
							},
							options,
						)
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

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	ACTIVITY_AGGREGATES_SCAN_ROWS,
	ACTIVITY_BANDMAP_MAX_BUCKETS,
	ACTIVITY_BANDMAP_MAX_PROTOCOLS,
	ACTIVITY_BANDMAP_MAX_TOP_ENTITIES,
	ACTIVITY_TIMELINE_MAX_BUCKETS,
} from "@wavekit/api-types"
import {
	aggregateBandMap,
	aggregateTimeline,
	DEFAULT_AGGREGATES_READ_LIMITS,
	parsePackedRows,
	toBandMapRow,
	timelineBucketCount,
	type BandMapReadInput,
	type BandMapRow,
	type BandMapShape,
	type TimelineReadInput,
} from "../../../../../src/core/activity/query/aggregates.js"
import { runRead } from "../../../../../src/core/activity/query/read.js"
import type { SqlDatabase } from "../../../../../src/core/activity/query/sqlite.js"
import { WALK_CHUNK_ROWS } from "../../../../../src/core/activity/query/walk.js"
import type {
	ActivityBandMap,
	ActivityCategory,
	ActivityTimeline,
} from "../../../../../src/core/activity/storage/contract.js"
import { FIXTURE_CLOCK_ANCHOR_MS } from "../storage/helpers.js"
import {
	counting,
	createAggStore,
	newStats,
	type AggRow,
	type AggStore,
} from "./aggregates-store.js"

const NOW = FIXTURE_CLOCK_ANCHOR_MS
const CATEGORIES: ActivityCategory[] = [
	"aircraft",
	"marine",
	"aviation-data",
	"voice",
	"paging",
	"aprs",
	"sensors",
	"mesh",
	"other",
]
const KINDS = [
	"decoder-reception",
	"call-lifecycle",
	"analog-transmission",
	"scanner-result",
	"recording-change",
	"ingestion-gap",
]

const SHAPE: BandMapShape = {
	minHz: 0,
	maxHz: 2_000_000_000,
	bucketHz: 12_500,
	maxBuckets: ACTIVITY_BANDMAP_MAX_BUCKETS,
	maxProtocols: ACTIVITY_BANDMAP_MAX_PROTOCOLS,
	maxTopEntities: ACTIVITY_BANDMAP_MAX_TOP_ENTITIES,
}

function row(partial: Partial<BandMapRow> & { seq: number }): BandMapRow {
	return {
		producedAtMs: NOW,
		kind: "decoder-reception",
		protocol: "adsb",
		category: "aircraft",
		entityKey: null,
		frequencyHz: 1_090_000_000,
		...partial,
	}
}

function bandMap(
	store: AggStore,
	input: Partial<BandMapReadInput> = {},
	db: SqlDatabase = store.sql,
): ActivityBandMap {
	const result = runRead(db, {
		op: "bandmap",
		input: {
			producedFromMs: NOW - 10_000,
			producedToMs: NOW,
			minHz: 0,
			maxHz: 2_000_000_000,
			bucketHz: 12_500,
			nowMs: NOW,
			...input,
		},
	})
	if (result.op !== "bandmap") throw new TypeError("wrong op")
	return result.bandMap
}

function timeline(
	store: AggStore,
	input: Partial<TimelineReadInput> = {},
	db: SqlDatabase = store.sql,
): ActivityTimeline {
	const result = runRead(db, {
		op: "timeline",
		input: {
			producedFromMs: NOW - 10_000,
			producedToMs: NOW,
			bucketMs: 1_000,
			nowMs: NOW,
			...input,
		},
	})
	if (result.op !== "timeline") throw new TypeError("wrong op")
	return result.timeline
}

function withStore<T>(run: (store: AggStore) => T): T {
	const store = createAggStore()
	try {
		return run(store)
	} finally {
		store.close()
	}
}

// ---------- naive models ----------

interface ModelRow extends AggRow {
	seq: number
}

interface ModelQuery {
	fromMs: number
	toMs: number
	minHz: number
	maxHz: number
	bucketHz: number
	categories?: string[]
	protocols?: string[]
	maxBuckets: number
	maxProtocols: number
	maxTopEntities: number
}

function matches(
	r: ModelRow,
	q: {
		fromMs: number
		toMs: number
		categories?: string[]
		protocols?: string[]
	},
): boolean {
	if (r.producedAtMs < q.fromMs || r.producedAtMs > q.toMs) return false
	if (q.categories?.length && !q.categories.includes(r.category ?? "aircraft"))
		return false
	const protocol = r.protocol === undefined ? "adsb" : r.protocol
	if (
		q.protocols?.length &&
		(protocol === null || !q.protocols.includes(protocol))
	)
		return false
	return true
}

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function modelBandMap(rows: readonly ModelRow[], q: ModelQuery) {
	const matched = rows.filter(r => matches(r, q))
	const noFrequencyRows = matched.filter(r => r.frequencyHz === null).length
	const placed = matched.filter(
		r =>
			r.frequencyHz !== null &&
			(r.frequencyHz ?? 0) >= q.minHz &&
			(r.frequencyHz ?? 0) <= q.maxHz,
	)
	const starts = [
		...new Set(
			placed.map(
				r => Math.floor((r.frequencyHz ?? 0) / q.bucketHz) * q.bucketHz,
			),
		),
	]
	const buckets = starts.map(startHz => {
		const inBucket = placed.filter(
			r =>
				Math.floor((r.frequencyHz ?? 0) / q.bucketHz) * q.bucketHz === startHz,
		)
		const keyOf = (r: ModelRow): string =>
			(r.protocol === undefined ? "adsb" : r.protocol) ??
			r.kind ??
			"decoder-reception"
		const keys = [...new Set(inBucket.map(keyOf))]
		const groups = keys.map(key => {
			const members = inBucket.filter(r => keyOf(r) === key)
			const newest = [...members].sort((a, b) =>
				a.producedAtMs !== b.producedAtMs
					? b.producedAtMs - a.producedAtMs
					: b.seq - a.seq,
			)[0] as ModelRow
			return {
				protocol: key,
				category: newest.category ?? "aircraft",
				rows: members.length,
				entities: new Set(members.map(m => m.entityKey).filter(k => k != null))
					.size,
				lastAt: new Date(newest.producedAtMs).toISOString(),
			}
		})
		groups.sort((a, b) =>
			a.rows !== b.rows ? b.rows - a.rows : cmp(a.protocol, b.protocol),
		)
		const entityCounts = new Map<string, number>()
		for (const r of inBucket)
			if (r.entityKey != null)
				entityCounts.set(r.entityKey, (entityCounts.get(r.entityKey) ?? 0) + 1)
		const entities = [...entityCounts.entries()].sort((a, b) =>
			a[1] !== b[1] ? b[1] - a[1] : cmp(a[0], b[0]),
		)
		const lastMs = Math.max(...inBucket.map(r => r.producedAtMs))
		return {
			startHz,
			rows: inBucket.length,
			lastMs,
			lastAt: new Date(lastMs).toISOString(),
			protocols: groups.slice(0, q.maxProtocols),
			otherRows: groups
				.slice(q.maxProtocols)
				.reduce((sum, g) => sum + g.rows, 0),
			topEntities: entities
				.slice(0, q.maxTopEntities)
				.map(([entityKey, rows]) => ({ entityKey, rows })),
		}
	})
	buckets.sort((a, b) =>
		a.lastMs !== b.lastMs ? b.lastMs - a.lastMs : a.startHz - b.startHz,
	)
	const kept = buckets.slice(0, q.maxBuckets)
	const droppedRows = buckets
		.slice(q.maxBuckets)
		.reduce((s, b) => s + b.rows, 0)
	kept.sort((a, b) => a.startHz - b.startHz)
	return {
		buckets: kept.map(({ lastMs: _lastMs, ...rest }) => rest),
		countedRows: placed.length,
		noFrequencyRows,
		droppedRows,
		bucketsCut: buckets.length > q.maxBuckets,
	}
}

function modelTimeline(
	rows: readonly ModelRow[],
	q: {
		fromMs: number
		toMs: number
		bucketMs: number
		categories?: string[]
		protocols?: string[]
		entityKeys?: string[]
	},
) {
	const first = Math.floor(q.fromMs / q.bucketMs)
	const size = Math.floor(q.toMs / q.bucketMs) - first + 1
	const buckets = Array.from({ length: size }, (_, i) => ({
		startMs: (first + i) * q.bucketMs,
		total: 0,
		counts: {} as Record<string, number>,
	}))
	let total = 0
	for (const r of rows) {
		if (!matches(r, q)) continue
		if (
			q.entityKeys?.length &&
			(r.entityKey == null || !q.entityKeys.includes(r.entityKey))
		)
			continue
		const b = buckets[Math.floor(r.producedAtMs / q.bucketMs) - first]
		if (!b) throw new Error("row outside the dense array")
		const cat = r.category ?? "aircraft"
		b.counts[cat] = (b.counts[cat] ?? 0) + 1
		b.total += 1
		total += 1
	}
	return { buckets, total }
}

function sortedCounts(
	counts: Partial<Record<string, number>>,
): [string, number][] {
	return Object.entries(counts)
		.map(([k, v]): [string, number] => [k, v ?? 0])
		.sort((a, b) => cmp(a[0], b[0]))
}

// ---------- arbitraries ----------

const protocolArb = fc.constantFrom<string | null>(
	null,
	"adsb",
	"ais",
	"p25",
	"dmr",
	"pocsag",
	"aprs",
	"acars",
	"vdl2",
	"flex",
	"ysf",
)
const rowArb = (fromMs: number, spanMs: number): fc.Arbitrary<AggRow> =>
	fc.record({
		producedAtMs: fc.integer({ min: fromMs - 5, max: fromMs + spanMs + 5 }),
		kind: fc.constantFrom(...KINDS),
		protocol: protocolArb,
		category: fc.constantFrom(...CATEGORIES),
		entityKey: fc.option(fc.constantFrom("a", "b", "c", "d", "e", "f"), {
			nil: null,
		}),
		frequencyHz: fc.option(fc.integer({ min: 0, max: 120_000 }), { nil: null }),
	})

// ---------- pure helpers ----------

function maxShapedBandMapBytes(protocolPad: string, entityPad: string): number {
	const rows: BandMapRow[] = []
	let seq = 0
	const protocol = (p: number) => `${String(p)}`.padStart(64, protocolPad)
	const entity = (b: number, e: number) => `${b}:${e}:`.padEnd(128, entityPad)
	for (let b = 0; b < 1_000; b += 1)
		for (let p = 0; p < 9; p += 1)
			for (let e = 0; e < 3; e += 1)
				rows.push(
					row({
						seq: ++seq,
						frequencyHz: 1_000_000_000_000 / 100 + b * 1_000_000,
						protocol: protocol(p),
						category: "aviation-data",
						entityKey: entity(b, e + p),
						producedAtMs: NOW - seq,
					}),
				)
	const out = aggregateBandMap(rows, {
		...SHAPE,
		maxHz: 100_000_000_000,
		bucketHz: 1_000_000,
	})
	const map: ActivityBandMap = {
		producedFrom: new Date(NOW).toISOString(),
		producedTo: new Date(NOW).toISOString(),
		minHz: 100_000_000_000,
		maxHz: 100_000_000_000,
		bucketHz: 1_000_000,
		buckets: out.buckets,
		scannedRows: 250_000,
		countedRows: 250_000,
		noFrequencyRows: 250_000,
		droppedRows: 250_000,
		truncated: true,
		truncation: ["scan-rows", "time-limit", "buckets"],
		coveredFrom: new Date(NOW).toISOString(),
		retentionFloor: new Date(NOW).toISOString(),
		generatedAt: new Date(NOW).toISOString(),
	}
	expect(out.buckets).toHaveLength(1_000)
	expect(
		out.buckets.every(
			b => b.protocols.length === 8 && b.topEntities.length === 3,
		),
	).toBe(true)
	return Buffer.byteLength(JSON.stringify(map))
}

describe("band map aggregation", () => {
	it("defaults come from the frozen constants", () => {
		expect(DEFAULT_AGGREGATES_READ_LIMITS).toEqual({
			scanRows: ACTIVITY_AGGREGATES_SCAN_ROWS,
			wallBudgetMs: 600,
			chunkRows: WALK_CHUNK_ROWS,
			maxBuckets: 1_000,
			maxProtocols: 8,
			maxTopEntities: 3,
			maxTimelineBuckets: ACTIVITY_TIMELINE_MAX_BUCKETS,
		})
		expect(WALK_CHUNK_ROWS).toBe(4_096)
	})

	it("buckets on a 0 Hz grid; minHz and maxHz inclusive; null frequency counted apart", () => {
		const out = aggregateBandMap(
			[
				row({ seq: 1, frequencyHz: 100_000 }),
				row({ seq: 2, frequencyHz: 112_499 }),
				row({ seq: 3, frequencyHz: 112_500 }),
				row({ seq: 4, frequencyHz: 200_000 }),
				row({ seq: 5, frequencyHz: 99_999 }),
				row({ seq: 6, frequencyHz: 200_001 }),
				row({ seq: 7, frequencyHz: null }),
			],
			{ ...SHAPE, minHz: 100_000, maxHz: 200_000 },
		)
		expect(out.buckets.map(b => [b.startHz, b.rows])).toEqual([
			[100_000, 2],
			[112_500, 1],
			[200_000, 1],
		])
		expect(out.countedRows).toBe(4)
		expect(out.noFrequencyRows).toBe(1)
		expect(out.droppedRows).toBe(0)
	})

	it("groups by protocol, else kind; newest row's category; distinct entities; ordering", () => {
		const out = aggregateBandMap(
			[
				row({
					seq: 1,
					producedAtMs: NOW - 5,
					protocol: null,
					kind: "analog-transmission",
					category: "voice",
				}),
				row({
					seq: 2,
					producedAtMs: NOW - 9,
					protocol: "p25",
					category: "voice",
					entityKey: "u:1",
				}),
				row({
					seq: 3,
					producedAtMs: NOW - 2,
					protocol: "p25",
					category: "other",
					entityKey: "u:1",
				}),
				row({
					seq: 4,
					producedAtMs: NOW - 2,
					protocol: "p25",
					category: "paging",
					entityKey: "u:2",
				}),
				row({
					seq: 5,
					producedAtMs: NOW - 1,
					protocol: null,
					kind: "analog-transmission",
					category: "voice",
				}),
				row({
					seq: 6,
					producedAtMs: NOW - 7,
					protocol: "dmr",
					category: "voice",
					entityKey: "u:3",
				}),
				row({
					seq: 7,
					producedAtMs: NOW - 8,
					protocol: "apco",
					category: "voice",
					entityKey: "u:3",
				}),
			],
			SHAPE,
		)
		const bucket = out.buckets[0]
		expect(out.buckets).toHaveLength(1)
		expect(bucket?.rows).toBe(7)
		expect(bucket?.lastAt).toBe(new Date(NOW - 1).toISOString())
		expect(bucket?.protocols).toEqual([
			{
				protocol: "p25",
				category: "paging",
				rows: 3,
				entities: 2,
				lastAt: new Date(NOW - 2).toISOString(),
			},
			{
				protocol: "analog-transmission",
				category: "voice",
				rows: 2,
				entities: 0,
				lastAt: new Date(NOW - 1).toISOString(),
			},
			{
				protocol: "apco",
				category: "voice",
				rows: 1,
				entities: 1,
				lastAt: new Date(NOW - 8).toISOString(),
			},
			{
				protocol: "dmr",
				category: "voice",
				rows: 1,
				entities: 1,
				lastAt: new Date(NOW - 7).toISOString(),
			},
		])
		expect(bucket?.topEntities).toEqual([
			{ entityKey: "u:1", rows: 2 },
			{ entityKey: "u:3", rows: 2 },
			{ entityKey: "u:2", rows: 1 },
		])
	})

	it("protocol cap at 8 and past it (otherRows); top entities at 3 and past it", () => {
		const make = (protocols: number, entities: number): BandMapRow[] => {
			const rows: BandMapRow[] = []
			let seq = 0
			for (let p = 0; p < protocols; p += 1)
				for (let n = 0; n <= p; n += 1)
					rows.push(row({ seq: ++seq, protocol: `p${p}` }))
			for (let e = 0; e < entities; e += 1)
				rows.push(row({ seq: ++seq, protocol: "p0", entityKey: `k${e}` }))
			return rows
		}
		const at = aggregateBandMap(make(8, 3), SHAPE).buckets[0]
		expect(at?.protocols).toHaveLength(8)
		expect(at?.otherRows).toBe(0)
		expect(at?.topEntities).toHaveLength(3)
		const past = aggregateBandMap(make(9, 4), SHAPE).buckets[0]
		expect(past?.protocols).toHaveLength(8)
		// p8 has 9 rows (the most) so the dropped group is p0 (1 + 4 entity rows = 5) vs
		// p1 (2): ranks are p8..p1 and p0 (5 rows) - the smallest is p1.
		const listed = past?.protocols.reduce((sum, p) => sum + p.rows, 0) ?? 0
		expect(listed + (past?.otherRows ?? 0)).toBe(past?.rows)
		expect(past?.otherRows).toBe(2)
		expect(past?.topEntities.map(e => e.entityKey)).toEqual(["k0", "k1", "k2"])
	})

	it("bucket cap at 1 000 and past it keeps the newest lastAt, ties by startHz", () => {
		const rows = (count: number): BandMapRow[] =>
			Array.from({ length: count }, (_, index) =>
				row({
					seq: index + 1,
					frequencyHz: index * 12_500,
					// Two buckets share each timestamp; bucket 0 is the oldest.
					producedAtMs: NOW - 10_000 + Math.floor(index / 2),
				}),
			)
		const at = aggregateBandMap(rows(1_000), SHAPE)
		expect(at.buckets).toHaveLength(1_000)
		expect(at.bucketsCut).toBe(false)
		expect(at.droppedRows).toBe(0)
		const past = aggregateBandMap(rows(1_001), SHAPE)
		expect(past.buckets).toHaveLength(1_000)
		expect(past.bucketsCut).toBe(true)
		expect(past.droppedRows).toBe(1)
		expect(past.countedRows).toBe(1_001)
		// Buckets 0 and 12 500 share the oldest lastAt: the tie keeps the lower startHz.
		expect(past.buckets[0]?.startHz).toBe(0)
		expect(past.buckets[1]?.startHz).toBe(25_000)
		// Two past the cap: the whole oldest pair goes; buckets come back startHz ascending.
		const tie = aggregateBandMap(rows(1_002), SHAPE)
		expect(tie.buckets[0]?.startHz).toBe(25_000)
		expect(tie.droppedRows).toBe(2)
	})

	it("serialised max-shaped band map stays <= 2.1 MB (plain ASCII keys)", () => {
		const bytes = maxShapedBandMapBytes("p", "k")
		expect(bytes).toBeLessThanOrEqual(2_100_000)
		expect(bytes).toBeGreaterThan(1_500_000)
	})

	it("max-shaped band map with JSON-escaped ASCII keys (quotes, backslashes): measured bound", () => {
		// Every pad character escapes to two bytes. Measured 2 766 767 bytes: above the frozen
		// 2.0 MB estimate (which assumed unescaped ASCII); bound asserted at the measurement.
		const bytes = maxShapedBandMapBytes('"', "\\")
		expect(bytes).toBeLessThanOrEqual(2_800_000)
		if (process.env["WAVEKIT_AGGREGATES_SIZE"] === "1")
			process.stderr.write(`BANDMAP_ESCAPED_BYTES ${bytes}\n`)
	})

	// Feature: web-gaps-5, Property 1: Band map model
	// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5
	it("matches the naive model over generated rows (pure)", () => {
		fc.assert(
			fc.property(
				fc.array(rowArb(NOW - 100, 100), { maxLength: 80 }),
				fc.integer({ min: 1_000, max: 30_000 }),
				fc.integer({ min: 0, max: 60_000 }),
				fc.integer({ min: 0, max: 80_000 }),
				fc.integer({ min: 1, max: 6 }),
				fc.integer({ min: 1, max: 4 }),
				fc.integer({ min: 1, max: 3 }),
				(
					raw,
					bucketHz,
					minHz,
					span,
					maxBuckets,
					maxProtocols,
					maxTopEntities,
				) => {
					const rows: ModelRow[] = raw.map((r, i) => ({ ...r, seq: i + 1 }))
					const q: ModelQuery = {
						fromMs: NOW - 100,
						toMs: NOW,
						minHz,
						maxHz: minHz + span,
						bucketHz,
						maxBuckets,
						maxProtocols,
						maxTopEntities,
					}
					const expected = modelBandMap(rows, q)
					const actual = aggregateBandMap(
						rows
							.filter(r => matches(r, q))
							.map(r => ({
								seq: r.seq,
								producedAtMs: r.producedAtMs,
								kind: r.kind ?? "decoder-reception",
								protocol: r.protocol ?? null,
								category: (r.category ?? "aircraft") as ActivityCategory,
								entityKey: r.entityKey ?? null,
								frequencyHz: r.frequencyHz ?? null,
							})),
						q,
					)
					expect(actual).toEqual(expected)
					for (const b of actual.buckets) {
						expect(b.protocols.length).toBeLessThanOrEqual(maxProtocols)
						expect(b.topEntities.length).toBeLessThanOrEqual(maxTopEntities)
						expect(b.rows).toBe(
							b.protocols.reduce((s, p) => s + p.rows, 0) + b.otherRows,
						)
					}
					const sum = actual.buckets.reduce((s, b) => s + b.rows, 0)
					expect(actual.countedRows).toBe(sum + actual.droppedRows)
					expect(actual.buckets.length).toBeLessThanOrEqual(maxBuckets)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("packed band map rows", () => {
	it("corrupt packed text or rows are the record-corrupt error", () => {
		const corrupt = expect.objectContaining({ code: "ACTIVITY_RECORD_CORRUPT" })
		for (const text of [null, 5, "{", "{}", '"x"'])
			expect(() => parsePackedRows(text)).toThrow(corrupt)
		expect(parsePackedRows("[]")).toEqual([])
		const good = [1, NOW, "decoder-reception", null, "voice", null, null]
		expect(toBandMapRow(good)).toEqual({
			seq: 1,
			producedAtMs: NOW,
			kind: "decoder-reception",
			protocol: null,
			category: "voice",
			entityKey: null,
			frequencyHz: null,
		})
		for (const bad of [
			null,
			[],
			good.slice(0, 6),
			[...good.slice(0, 2), "bogus", ...good.slice(3)],
			[...good.slice(0, 4), "bogus", ...good.slice(5)],
			[...good.slice(0, 3), 5, ...good.slice(4)],
			[...good.slice(0, 5), 5, null],
			[...good.slice(0, 6), "1"],
			["1", ...good.slice(1)],
		])
			expect(() => toBandMapRow(bad)).toThrow(corrupt)
	})
})

describe("timeline aggregation", () => {
	it("bucket count is epoch aligned and inclusive of both ends", () => {
		expect(timelineBucketCount(0, 0, 60_000)).toBe(1)
		expect(timelineBucketCount(59_999, 60_000, 60_000)).toBe(2)
		expect(timelineBucketCount(60_000, 60_000 * 1_440 - 1, 60_000)).toBe(1_439)
		expect(timelineBucketCount(0, 60_000 * 1_440 - 1, 60_000)).toBe(1_440)
		expect(timelineBucketCount(0, 60_000 * 1_440, 60_000)).toBe(1_441)
	})

	it("counts only non-zero categories and the totals", () => {
		const out = aggregateTimeline(
			[
				{ producedAtMs: 10, category: "aircraft" },
				{ producedAtMs: 999, category: "aircraft" },
				{ producedAtMs: 1_000, category: "marine" },
				{ producedAtMs: 5_000, category: "marine" },
			],
			0,
			2_500,
			1_000,
		)
		expect(out.totalRows).toBe(3)
		expect(out.buckets).toEqual([
			{ startMs: 0, total: 2, counts: { aircraft: 2 } },
			{ startMs: 1_000, total: 1, counts: { marine: 1 } },
			{ startMs: 2_000, total: 0, counts: {} },
		])
	})

	// Feature: web-gaps-5, Property 2: Timeline model
	// Validates: Requirements 2.3, 2.4
	it("matches the naive model over generated rows (pure)", () => {
		fc.assert(
			fc.property(
				fc.array(rowArb(0, 50_000), { maxLength: 100 }),
				fc.integer({ min: 0, max: 50_000 }),
				fc.integer({ min: 0, max: 50_000 }),
				fc.integer({ min: 500, max: 20_000 }),
				(raw, a, b, bucketMs) => {
					const fromMs = Math.min(a, b)
					const toMs = Math.max(a, b)
					const rows: ModelRow[] = raw.map((r, i) => ({ ...r, seq: i + 1 }))
					const expected = modelTimeline(rows, { fromMs, toMs, bucketMs })
					const actual = aggregateTimeline(
						rows.map(r => ({
							producedAtMs: r.producedAtMs,
							category: (r.category ?? "aircraft") as ActivityCategory,
						})),
						fromMs,
						toMs,
						bucketMs,
					)
					expect(actual.buckets).toHaveLength(
						Math.floor(toMs / bucketMs) - Math.floor(fromMs / bucketMs) + 1,
					)
					expect(actual.totalRows).toBe(expected.total)
					expect(
						actual.buckets.map(x => [
							x.startMs,
							x.total,
							sortedCounts(x.counts),
						]),
					).toEqual(
						expected.buckets.map(x => [
							x.startMs,
							x.total,
							sortedCounts(x.counts),
						]),
					)
				},
			),
			{ numRuns: 200 },
		)
	})
})

// ---------- against a store ----------

describe("aggregate reads against a store", () => {
	it("empty window: no buckets, dense zero timeline, null floor; from == to allowed", () => {
		withStore(store => {
			const map = bandMap(store, { producedFromMs: NOW, producedToMs: NOW })
			expect(map).toEqual({
				producedFrom: new Date(NOW).toISOString(),
				producedTo: new Date(NOW).toISOString(),
				minHz: 0,
				maxHz: 2_000_000_000,
				bucketHz: 12_500,
				buckets: [],
				scannedRows: 0,
				countedRows: 0,
				noFrequencyRows: 0,
				droppedRows: 0,
				truncated: false,
				truncation: [],
				coveredFrom: new Date(NOW).toISOString(),
				retentionFloor: null,
				generatedAt: new Date(NOW).toISOString(),
			})
			const line = timeline(store, {
				producedFromMs: NOW - 2_500,
				producedToMs: NOW,
			})
			expect(line.buckets.map(b => b.total)).toEqual([0, 0, 0, 0])
			expect(line.totalRows).toBe(0)
			expect(line.retentionFloor).toBeNull()
			expect(line.coveredFrom).toBe(new Date(NOW - 2_500).toISOString())
		})
	})

	it("window, filters, inclusive Hz bounds, null frequency, every kind; retention floor", () => {
		withStore(store => {
			store.insertMany([
				{ producedAtMs: NOW - 20_000, frequencyHz: 162_000_000 },
				{
					producedAtMs: NOW - 5,
					frequencyHz: 100_000_000,
					protocol: "ais",
					category: "marine",
					entityKey: "m:1",
				},
				{
					producedAtMs: NOW - 4,
					frequencyHz: 200_000_000,
					protocol: "ais",
					category: "marine",
					entityKey: "m:2",
				},
				{ producedAtMs: NOW - 3, frequencyHz: 200_000_001 },
				{ producedAtMs: NOW - 3, frequencyHz: 99_999_999 },
				{
					producedAtMs: NOW - 2,
					frequencyHz: null,
					kind: "ingestion-gap",
					protocol: null,
					category: "other",
				},
				{
					producedAtMs: NOW - 1,
					frequencyHz: 150_000_000,
					kind: "analog-transmission",
					protocol: null,
					category: "voice",
				},
				{ producedAtMs: NOW + 1, frequencyHz: 150_000_000 },
			])
			const map = bandMap(store, { minHz: 100_000_000, maxHz: 200_000_000 })
			expect(
				map.buckets.map(b => [b.startHz, b.protocols[0]?.protocol]),
			).toEqual([
				[100_000_000, "ais"],
				[150_000_000, "analog-transmission"],
				[200_000_000, "ais"],
			])
			expect(map.noFrequencyRows).toBe(1)
			expect(map.countedRows).toBe(3)
			// Index rows of the window examined, matched or not.
			expect(map.scannedRows).toBe(6)
			expect(map.retentionFloor).toBe(new Date(NOW - 20_000).toISOString())
			const marine = bandMap(store, {
				categories: ["marine"],
				protocols: ["ais"],
			})
			expect(marine.countedRows).toBe(2)
			expect(marine.noFrequencyRows).toBe(0)
			const line = timeline(store, {
				producedFromMs: NOW - 9,
				bucketMs: 10_000,
			})
			expect(line.totalRows).toBe(6)
			expect(line.buckets).toHaveLength(
				timelineBucketCount(NOW - 9, NOW, 10_000),
			)
			const keyed = timeline(store, { entityKeys: ["m:1", "m:2", "a,b"] })
			expect(keyed.totalRows).toBe(2)
		})
	})

	it("a corrupt category or kind is the record-corrupt error", () => {
		withStore(store => {
			store.insert({ producedAtMs: NOW - 1, category: "bogus" })
			expect(() => bandMap(store)).toThrow(
				expect.objectContaining({ code: "ACTIVITY_RECORD_CORRUPT" }),
			)
			expect(() => timeline(store)).toThrow(
				expect.objectContaining({ code: "ACTIVITY_RECORD_CORRUPT" }),
			)
		})
		withStore(store => {
			store.insert({ producedAtMs: NOW - 1, kind: "bogus" })
			expect(() => bandMap(store)).toThrow(
				expect.objectContaining({ code: "ACTIVITY_RECORD_CORRUPT" }),
			)
			expect(() => timeline(store)).toThrow(
				expect.objectContaining({ code: "ACTIVITY_RECORD_CORRUPT" }),
			)
		})
		// Both check matching rows only: a corrupt row the filters exclude is skipped (R1).
		withStore(store => {
			store.insert({ producedAtMs: NOW - 2, protocol: "ais" })
			store.insert({ producedAtMs: NOW - 1, category: "bogus", protocol: "x" })
			store.insert({ producedAtMs: NOW - 1, kind: "bogus", protocol: "x" })
			const map = bandMap(store, { protocols: ["ais"] })
			expect(map.countedRows).toBe(1)
			expect(map.scannedRows).toBe(3)
			const line = timeline(store, { protocols: ["ais"] })
			expect(line.totalRows).toBe(1)
			expect(line.scannedRows).toBe(3)
		})
	})

	it("timeline at 1 440 buckets is valid, 1 441 is invalid", () => {
		withStore(store => {
			const toMs = 60_000 * 1_440 - 1
			expect(
				timeline(store, {
					producedFromMs: 0,
					producedToMs: toMs,
					bucketMs: 60_000,
				}).buckets,
			).toHaveLength(1_440)
			expect(() =>
				timeline(store, {
					producedFromMs: 0,
					producedToMs: toMs + 1,
					bucketMs: 60_000,
				}),
			).toThrow(expect.objectContaining({ code: "ACTIVITY_QUERY_INVALID" }))
		})
	})

	it("every statement seeks activity_produced (EXPLAIN QUERY PLAN), never SCAN activity", () => {
		withStore(store => {
			for (let i = 0; i < 6; i += 1)
				store.insert({ producedAtMs: NOW - Math.floor(i / 2), entityKey: "x" })
			const stats = newStats()
			const db = counting(store.sql, stats)
			bandMap(
				store,
				{
					categories: ["aircraft"],
					protocols: ["adsb"],
					limits: { chunkRows: 2 },
				},
				db,
			)
			timeline(
				store,
				{
					categories: ["aircraft"],
					protocols: ["adsb"],
					entityKeys: ["x"],
					limits: { chunkRows: 2 },
				},
				db,
			)
			// Cut mid-step and at the scan cap so countPiece and the cap probe run too.
			let ticks = 0
			bandMap(
				store,
				{ limits: { chunkRows: 4, wallBudgetMs: 2 }, clock: () => ticks++ },
				db,
			)
			bandMap(store, { limits: { scanRows: 3, chunkRows: 2 } }, db)
			const walked = [...stats.prepared].filter(sql =>
				sql.includes("activity_produced"),
			)
			// tie end, range end, count range, band map tie/range, timeline tie/range.
			expect(walked.length).toBeGreaterThanOrEqual(6)
			for (const sql of walked) {
				const count = (sql.match(/\?/g) ?? []).length
				const details = store.sql
					.prepare(`EXPLAIN QUERY PLAN ${sql}`)
					.all(...Array<number>(count).fill(1))
					.map(r => String(r["detail"]))
				expect(details.some(d => /SCAN activity\b/.test(d))).toBe(false)
				const search = details.filter(d => d.includes("activity_produced"))
				expect(search).toHaveLength(1)
				expect(search[0]).toMatch(
					/^SEARCH activity USING (COVERING )?INDEX activity_produced \((produced_at_ms=\? AND rowid>\? AND rowid<\?|produced_at_ms>\? AND produced_at_ms<\?|produced_at_ms=\? AND rowid<\?)\)$/,
				)
			}
			const floor = store.sql
				.prepare(
					"EXPLAIN QUERY PLAN SELECT MIN(produced_at_ms) AS floor FROM activity",
				)
				.all()
				.map(r => String(r["detail"]))
			expect(floor.join(" ")).toMatch(/activity_produced/)
		})
	})

	it("a run of > 4 096 rows with one timestamp: no statement returns more than the chunk, any filter", () => {
		withStore(store => {
			const rows: AggRow[] = []
			for (let i = 0; i < 5_000; i += 1)
				rows.push({
					producedAtMs: NOW - 7,
					entityKey: `k${i % 7}`,
					frequencyHz: 100_000 + (i % 3) * 20_000,
				})
			for (let i = 0; i < 300; i += 1)
				rows.push({ producedAtMs: NOW - 8 - (i % 5) })
			store.insertMany(rows)
			for (const filter of [
				{},
				{ protocols: ["nothing-matches"] },
				{ categories: ["mesh" as const] },
			]) {
				const stats = newStats()
				const db = counting(store.sql, stats)
				const map = bandMap(store, filter, db)
				const line = timeline(store, { ...filter }, db)
				const max = Math.max(...stats.returned.map(r => r.rows))
				expect(max).toBeLessThanOrEqual(WALK_CHUNK_ROWS)
				// Unfiltered, a packed band map piece of the run carries exactly one chunk.
				if (Object.keys(filter).length === 0) expect(max).toBe(WALK_CHUNK_ROWS)
				expect(map.scannedRows).toBe(5_300)
				expect(line.scannedRows).toBe(5_300)
				expect(map.truncated).toBe(false)
				if ("protocols" in filter || "categories" in filter) {
					expect(map.buckets).toEqual([])
					expect(line.totalRows).toBe(0)
				} else {
					expect(map.countedRows).toBe(5_300)
					expect(line.totalRows).toBe(5_300)
				}
				// Bounded statement count: two steps over the run plus the rest.
				expect(stats.returned.length).toBeLessThan(30)
			}
		})
	})

	it("injected clock: the wall budget stops with time-limit, counts exact from coveredFrom", () => {
		withStore(store => {
			const rows: AggRow[] = []
			for (let i = 0; i < 40; i += 1)
				rows.push({
					producedAtMs: NOW - 100 + Math.floor(i / 3),
					frequencyHz: 12_500 * (i % 4),
				})
			store.insertMany(rows)
			let ticks = 0
			const stats = newStats()
			const db = counting(store.sql, stats, () => (ticks += 1))
			const map = bandMap(
				store,
				{ limits: { chunkRows: 5, wallBudgetMs: 10 }, clock: () => ticks },
				db,
			)
			expect(map.truncation).toEqual(["time-limit"])
			expect(map.truncated).toBe(true)
			const covered = Date.parse(map.coveredFrom)
			const exact = rows.filter(r => r.producedAtMs >= covered).length
			expect(map.countedRows).toBeGreaterThanOrEqual(exact)
			expect(map.countedRows).toBeLessThan(40)
			expect(map.scannedRows).toBe(map.countedRows)
			ticks = 0
			const line = timeline(
				store,
				{ limits: { chunkRows: 5, wallBudgetMs: 10 }, clock: () => ticks },
				db,
			)
			expect(line.truncation).toEqual(["time-limit"])
			expect(line.totalRows).toBeGreaterThanOrEqual(
				rows.filter(r => r.producedAtMs >= Date.parse(line.coveredFrom)).length,
			)
			expect(line.totalRows).toBeLessThan(40)
		})
	})

	it("lowered scan cap: below the cap is complete; reaching it is scan-rows, no row past it read", () => {
		withStore(store => {
			const rows: AggRow[] = []
			for (let i = 0; i < 10; i += 1) rows.push({ producedAtMs: NOW - 10 + i })
			store.insertMany(rows)
			const below = bandMap(store, { limits: { scanRows: 11, chunkRows: 3 } })
			expect(below.truncated).toBe(false)
			expect(below.scannedRows).toBe(10)
			expect(below.coveredFrom).toBe(new Date(NOW - 10_000).toISOString())
			const stats = newStats()
			// Exactly scanRows rows in the window: a one-row probe finds none left (R1).
			const at = bandMap(
				store,
				{ limits: { scanRows: 10, chunkRows: 3 } },
				counting(store.sql, stats),
			)
			expect(at.truncation).toEqual([])
			expect(at.scannedRows).toBe(10)
			expect(at.coveredFrom).toBe(new Date(NOW - 10_000).toISOString())
			// Every row read was counted: the walk statements returned 10 rows in all.
			const walked = stats.returned.filter(r =>
				r.sql.includes("json_group_array"),
			)
			expect(walked.reduce((sum, r) => sum + r.rows, 0)).toBe(10)
			const atLine = timeline(store, { limits: { scanRows: 10, chunkRows: 4 } })
			expect(atLine.truncated).toBe(false)
			expect(atLine.coveredFrom).toBe(new Date(NOW - 10_000).toISOString())
			// One row past the cap: the probed row is at NOW-10, so exact from NOW-9.
			const past = bandMap(store, { limits: { scanRows: 9, chunkRows: 3 } })
			expect(past.truncation).toEqual(["scan-rows"])
			expect(past.scannedRows).toBe(9)
			expect(past.countedRows).toBe(9)
			expect(past.coveredFrom).toBe(new Date(NOW - 9).toISOString())
			const line = timeline(store, { limits: { scanRows: 9, chunkRows: 4 } })
			expect(line.truncation).toEqual(["scan-rows"])
			expect(line.totalRows).toBe(9)
			expect(line.coveredFrom).toBe(new Date(NOW - 9).toISOString())
		})
		withStore(store => {
			store.insert({ producedAtMs: NOW - 1 })
			const one = bandMap(store, { limits: { scanRows: 1 } })
			expect(one.truncation).toEqual([])
			expect(one.scannedRows).toBe(1)
			store.insertMany([{ producedAtMs: NOW - 5 }, { producedAtMs: NOW - 5 }])
			// The cut falls inside the NOW-5 run: rows below it in that ms remain.
			const tie = bandMap(store, { limits: { scanRows: 2 } })
			expect(tie.truncation).toEqual(["scan-rows"])
			expect(tie.coveredFrom).toBe(new Date(NOW - 4).toISOString())
		})
	})

	it("the budget is checked before every statement after the first (one row, 1 ms budget)", () => {
		withStore(store => {
			store.insert({ producedAtMs: 20_000 })
			for (const read of ["bandmap", "timeline"] as const) {
				let ticks = 0
				const stats = newStats()
				const db = counting(store.sql, stats, () => (ticks += 1))
				const input = {
					producedFromMs: 10_000,
					producedToMs: 30_000,
					limits: { wallBudgetMs: 1 },
					clock: () => ticks,
				}
				const out =
					read === "bandmap"
						? bandMap(store, input, db)
						: timeline(store, { ...input, bucketMs: 10_000 }, db)
				expect(out.truncation).toEqual(["time-limit"])
				// The snapshot meta, the retention floor (first statement of the read), then
				// the first walk statement is refused: the budget is already spent.
				expect(stats.returned).toHaveLength(2)
				expect(out.scannedRows).toBe(0)
				// Nothing examined: producedTo + 1 ms (documented; a clamp to producedTo
				// would claim the rows at producedTo exact).
				expect(out.coveredFrom).toBe(new Date(30_001).toISOString())
			}
		})
	})

	it("a time-limit stop reports the last fully examined position as coveredFrom", () => {
		withStore(store => {
			store.insertMany([{ producedAtMs: 20_000 }, { producedAtMs: 12_000 }])
			const seen = new Set<string>()
			for (let budget = 1; budget <= 12; budget += 1) {
				let ticks = 0
				const db = counting(store.sql, newStats(), () => (ticks += 1))
				const out = bandMap(
					store,
					{
						producedFromMs: 10_000,
						producedToMs: 30_000,
						limits: { chunkRows: 1, wallBudgetMs: budget },
						clock: () => ticks,
					},
					db,
				)
				const covered = Date.parse(out.coveredFrom)
				seen.add(`${out.scannedRows}:${out.truncated}:${covered}`)
				// Never above one ms over the oldest examined row (minimal), and exact.
				if (out.scannedRows === 2)
					expect(covered).toBe(out.truncated ? 12_001 : 10_000)
				else if (out.scannedRows === 1)
					expect([12_001, 20_001]).toContain(covered)
				else expect([20_001, 30_001]).toContain(covered)
			}
			// The cut right after the 12 000 row reports 12 001, not the previous cursor.
			expect(seen.has("2:true:12001")).toBe(true)
		})
	})

	it("bucket cap lowered through limits: buckets truncation with droppedRows", () => {
		withStore(store => {
			store.insertMany([
				{ producedAtMs: NOW - 3, frequencyHz: 0 },
				{ producedAtMs: NOW - 2, frequencyHz: 12_500 },
				{ producedAtMs: NOW - 1, frequencyHz: 25_000 },
			])
			const map = bandMap(store, { limits: { maxBuckets: 2 } })
			expect(map.truncation).toEqual(["buckets"])
			expect(map.buckets.map(b => b.startHz)).toEqual([12_500, 25_000])
			expect(map.droppedRows).toBe(1)
			expect(map.countedRows).toBe(3)
		})
	})

	// Feature: web-gaps-5, Property 1: Band map model
	// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5
	it("readBandMap matches the naive model on small real stores", () => {
		fc.assert(
			fc.property(
				fc.array(rowArb(NOW - 50, 50), { maxLength: 40 }),
				fc.subarray(["aircraft", "marine", "voice"]),
				fc.subarray(["adsb", "ais", "p25"]),
				fc.integer({ min: 1_000, max: 40_000 }),
				fc.integer({ min: 0, max: 60_000 }),
				(raw, categories, protocols, bucketHz, minHz) =>
					withStore(store => {
						const rows: ModelRow[] = raw.map(r => ({
							...r,
							seq: store.insert(r),
						}))
						const q: ModelQuery = {
							fromMs: NOW - 50,
							toMs: NOW,
							minHz,
							maxHz: minHz + 60_000,
							bucketHz,
							categories,
							protocols,
							maxBuckets: 3,
							maxProtocols: 2,
							maxTopEntities: 2,
						}
						const map = bandMap(store, {
							producedFromMs: q.fromMs,
							minHz: q.minHz,
							maxHz: q.maxHz,
							bucketHz,
							categories: categories as ActivityCategory[],
							protocols,
							limits: {
								maxBuckets: 3,
								maxProtocols: 2,
								maxTopEntities: 2,
								chunkRows: 3,
							},
						})
						const expected = modelBandMap(rows, q)
						expect(map.buckets).toEqual(expected.buckets)
						expect(map.countedRows).toBe(expected.countedRows)
						expect(map.noFrequencyRows).toBe(expected.noFrequencyRows)
						expect(map.droppedRows).toBe(expected.droppedRows)
						expect(map.truncation).toEqual(
							expected.bucketsCut ? ["buckets"] : [],
						)
						expect(map.scannedRows).toBe(
							rows.filter(
								r => r.producedAtMs >= q.fromMs && r.producedAtMs <= q.toMs,
							).length,
						)
					}),
			),
			{ numRuns: 100 },
		)
	})

	// Feature: web-gaps-5, Property 3: Aggregate walk bounds
	// Validates: Requirements 1.6, 2.4, 3.2, 3.3
	it("bounded statements; with a lowered scan cap or budget counts are exact from coveredFrom", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						producedAtMs: fc.integer({ min: NOW - 12, max: NOW + 1 }),
						category: fc.constantFrom("aircraft", "marine"),
						protocol: fc.constantFrom("adsb", "ais"),
						entityKey: fc.constantFrom("a", "b"),
					}),
					{ maxLength: 60 },
				),
				fc.integer({ min: 1, max: 6 }),
				fc.integer({ min: 1, max: 70 }),
				fc.integer({ min: 0, max: 40 }),
				fc.constantFrom<string[] | undefined>(undefined, ["ais"], ["none"]),
				(raw, chunkRows, scanRows, budget, protocols) =>
					withStore(store => {
						const rows: ModelRow[] = raw.map(r => ({
							...r,
							seq: store.insert(r),
						}))
						const fromMs = NOW - 10
						let ticks = 0
						const stats = newStats()
						const db = counting(store.sql, stats, () => (ticks += 1))
						const limits = { chunkRows, scanRows, wallBudgetMs: budget }
						const line = timeline(
							store,
							{
								producedFromMs: fromMs,
								bucketMs: 1,
								...(protocols ? { protocols } : {}),
								limits,
								clock: () => ticks,
							},
							db,
						)
						for (const r of stats.returned.filter(x =>
							x.sql.includes("activity_produced"),
						))
							expect(r.rows).toBeLessThanOrEqual(chunkRows)
						const window = rows.filter(
							r => r.producedAtMs >= fromMs && r.producedAtMs <= NOW,
						)
						expect(line.scannedRows).toBeLessThanOrEqual(
							Math.min(scanRows, window.length),
						)
						const covered = Date.parse(line.coveredFrom)
						const q = {
							fromMs,
							toMs: NOW,
							bucketMs: 1,
							...(protocols ? { protocols } : {}),
						}
						const all = modelTimeline(rows, q)
						const exact = modelTimeline(
							rows.filter(r => r.producedAtMs >= covered),
							q,
						)
						line.buckets.forEach((bucket, index) => {
							expect(bucket.total).toBeLessThanOrEqual(
								all.buckets[index]?.total ?? 0,
							)
							if (bucket.startMs >= covered)
								expect(bucket.total).toBe(exact.buckets[index]?.total)
						})
						if (!line.truncated) {
							expect(line.totalRows).toBe(all.total)
							expect(line.scannedRows).toBe(window.length)
							expect(covered).toBe(fromMs)
						}
						const ordered = [...window].sort((a, b) =>
							a.producedAtMs !== b.producedAtMs
								? b.producedAtMs - a.producedAtMs
								: b.seq - a.seq,
						)
						if (line.truncation.includes("scan-rows")) {
							expect(line.scannedRows).toBe(scanRows)
							// Exact (R1): a row is left, and coverage reaches just above it.
							const next = ordered[scanRows]
							expect(next).toBeDefined()
							expect(covered).toBe((next?.producedAtMs ?? 0) + 1)
						}
						if (
							scanRows >= window.length &&
							!line.truncation.includes("time-limit")
						)
							expect(line.truncated).toBe(false)
						// rows == cap with an ample budget is complete, from the window start.
						if (window.length > 0) {
							const atCap = timeline(store, {
								producedFromMs: fromMs,
								bucketMs: 1,
								...(protocols ? { protocols } : {}),
								limits: { chunkRows, scanRows: window.length },
							})
							expect(atCap.truncation).toEqual([])
							expect(atCap.coveredFrom).toBe(new Date(fromMs).toISOString())
							expect(atCap.totalRows).toBe(all.total)
						}
						// Minimal: the examined rows are the newest scannedRows of the window,
						// and coveredFrom is at most one ms above the oldest of them.
						if (line.truncated) {
							const oldest = ordered[line.scannedRows - 1]
							expect(covered).toBeLessThanOrEqual(
								oldest ? oldest.producedAtMs + 1 : Math.max(fromMs, NOW + 1),
							)
						}
					}),
			),
			{ numRuns: 100 },
		)
	})
})

import { afterEach, describe, expect, it } from "vitest"
import {
	ActivityQueryInvalidError,
	ActivityQueryClosedError,
} from "../../../../../src/core/activity/query/errors.js"
import {
	createActivityQueryService,
	DEFAULT_ACTIVITY_QUERY_LIMITS,
	type ActivityQueryServiceOptions,
} from "../../../../../src/core/activity/query/service.js"
import type { ReaderHostEvent } from "../../../../../src/core/activity/query/reader-host.js"
import type { ActivityQueryService } from "../../../../../src/core/activity/storage/contract.js"
import { createFixture, testLogger, type ActivityFixture } from "./fixture.js"

const NOW = Date.parse("2026-10-16T12:00:00.000Z")
const iso = (offset: number): string => new Date(NOW + offset).toISOString()

describe("query service band map and timeline", () => {
	let fixture: ActivityFixture | undefined
	let service: ActivityQueryService | undefined

	afterEach(async () => {
		await service?.close()
		await fixture?.close()
		service = undefined
		fixture = undefined
	})

	async function open(
		overrides: Partial<Omit<ActivityQueryServiceOptions, "store">> = {},
	): Promise<{ service: ActivityQueryService; store: ActivityFixture }> {
		fixture = await createFixture()
		service = createActivityQueryService({
			store: fixture.store,
			logger: testLogger,
			execution: "inline",
			now: () => NOW,
			...overrides,
			limits: {
				deadlineMs: 2_000,
				aggregatesDeadlineMs: 2_000,
				...overrides.limits,
			},
		})
		return { service, store: fixture }
	}

	it("has a 1 000 ms deadline above a 600 ms cooperative budget", () => {
		expect(DEFAULT_ACTIVITY_QUERY_LIMITS.aggregatesDeadlineMs).toBe(1_000)
		expect(DEFAULT_ACTIVITY_QUERY_LIMITS.aggregatesWallBudgetMs).toBe(600)
	})

	it("answers an empty store with no buckets and dense zeros", async () => {
		const { service } = await open()
		const band = await service.bandMap?.({})
		expect(band).toMatchObject({
			buckets: [],
			scannedRows: 0,
			countedRows: 0,
			truncated: false,
			retentionFloor: null,
		})
		const line = await service.timeline?.({})
		expect(line?.buckets).toHaveLength(61)
		expect(line?.totalRows).toBe(0)
		expect(
			line?.buckets.every(
				b => b.total === 0 && Object.keys(b.counts).length === 0,
			),
		).toBe(true)
	})

	it("buckets frequencies inclusive of minHz and maxHz and counts null frequency", async () => {
		const { service, store } = await open()
		const rows: [string, number | null][] = [
			["a", 100_000_000],
			["b", 100_012_499],
			["c", 100_012_500],
			["d", 200_000_000],
			["e", null],
			["f", 99_999_999],
		]
		rows.forEach(([id, hz], i) =>
			store.insert({
				eventId: id,
				frequencyHz: hz,
				protocol: "adsb",
				category: "aircraft",
				entityKey: `k${id}`,
				producedAt: iso(-(10 - i) * 1000),
			}),
		)
		const result = await service.bandMap?.({
			minHz: 100_000_000,
			maxHz: 200_000_000,
		})
		expect(result?.buckets.map(b => [b.startHz, b.rows])).toEqual([
			[100_000_000, 2],
			[100_012_500, 1],
			[200_000_000, 1],
		])
		expect(result?.noFrequencyRows).toBe(1)
		expect(result?.countedRows).toBe(4)
		expect(result?.scannedRows).toBe(6)
	})

	it("counts timeline rows per epoch bucket, all kinds, from == to allowed", async () => {
		const { service, store } = await open()
		store.insert({
			eventId: "a",
			category: "aircraft",
			producedAt: iso(-30_000),
		})
		store.insert({
			eventId: "b",
			category: "marine",
			kind: "call-lifecycle",
			producedAt: iso(-30_000),
		})
		store.insert({ eventId: "c", category: "marine", producedAt: iso(-30_000) })
		const result = await service.timeline?.({
			producedFrom: iso(-30_000),
			producedTo: iso(-30_000),
		})
		expect(result?.buckets).toHaveLength(1)
		expect(result?.buckets[0]).toMatchObject({
			total: 3,
			counts: { aircraft: 1, marine: 2 },
		})
		const filtered = await service.timeline?.({ entityKeys: ["nope"] })
		expect(filtered?.totalRows).toBe(0)
	})

	it("passes aggregatesLimits through: scan cap and bucket cap truncate", async () => {
		const { service, store } = await open({
			aggregatesLimits: { scanRows: 2, maxBuckets: 1 },
		})
		for (let i = 0; i < 4; i++) {
			store.insert({
				eventId: `e${i}`,
				frequencyHz: 100_000_000 + i * 12_500,
				protocol: "p",
				producedAt: iso(-(5 - i) * 1000),
			})
		}
		const result = await service.bandMap?.({})
		expect(result?.truncation).toContain("scan-rows")
		expect(result?.scannedRows).toBe(2)
		const capped = await service.bandMap?.({ producedFrom: iso(-4_500) })
		expect(capped?.truncation).toContain("buckets")
		expect(capped?.buckets).toHaveLength(1)
		expect(capped?.droppedRows).toBeGreaterThan(0)
	})

	it("a spent wall budget answers time-limit and never restarts the reader", async () => {
		const events: ReaderHostEvent[] = []
		const { service, store } = await open({
			limits: { aggregatesWallBudgetMs: 0 },
			aggregatesLimits: { chunkRows: 1 },
			onReaderEvent: event => events.push(event),
		})
		for (let i = 0; i < 3; i++) {
			store.insert({
				eventId: `e${i}`,
				frequencyHz: 100_000_000,
				producedAt: iso(-(4 - i) * 1000),
			})
		}
		const band = await service.bandMap?.({})
		const line = await service.timeline?.({})
		expect(band?.truncation).toEqual(["time-limit"])
		expect(line?.truncation).toEqual(["time-limit"])
		expect(events.filter(e => e.type === "terminate")).toEqual([])
	})

	it("rejects invalid input with ActivityQueryInvalidError and rejects after close", async () => {
		const { service } = await open()
		await expect(service.bandMap?.({ bucketHz: 1 })).rejects.toBeInstanceOf(
			ActivityQueryInvalidError,
		)
		await expect(service.timeline?.({ bucketMs: 1 })).rejects.toBeInstanceOf(
			ActivityQueryInvalidError,
		)
		await service.close()
		await expect(service.bandMap?.({})).rejects.toBeInstanceOf(
			ActivityQueryClosedError,
		)
		await expect(service.timeline?.({})).rejects.toBeInstanceOf(
			ActivityQueryClosedError,
		)
	})
})

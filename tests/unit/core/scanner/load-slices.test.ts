/**
 * Regression guard for the startup load: no single synchronous step of the scanner state
 * load handles more than SCANNER_LOAD_SLICE_ITEMS items. Counts items and yields, never time:
 * the snapshot validation and the store restore yield every slice, and give the same
 * result as the one-shot parse and restore.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import {
	parseInSlices,
	SCANNER_LOAD_SLICE_ITEMS,
} from "../../../../src/core/scanner/store/slices.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const logger = createLogger({ level: "fatal" })
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0)
const dirs: string[] = []

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

/** A store with `channels` discoveries of `perChannel` observations each. */
function filledStore(channels: number, perChannel: number): DiscoveryStore {
	let now = T0
	const store = new DiscoveryStore({
		maxDiscoveries: 100_000,
		now: () => now,
		newId: counterIds(),
		rasters: () => [{ spacingHz: 12_500, firstChannelHz: 100_000_000 }],
	})
	let id = 0
	for (let c = 0; c < channels; c++)
		for (let k = 0; k < perChannel; k++) {
			now += 50
			store.ingest(
				makeObs({
					id: `o${id++}`,
					centreHz: 100_000_000 + c * 25_000,
					startedAt: now - 900,
					blocks: 3,
					snrDb: 25,
					cls: "analog-fm",
					hypotheses: [["analog-fm", 0.8]],
				}),
			)
		}
	return store
}

/** A yield that records how many items the counted step handled since the last yield. */
function countingYield(counter: { items: number }) {
	const slices: number[] = []
	return {
		slices,
		yieldTurn: async () => {
			slices.push(counter.items)
			counter.items = 0
		},
	}
}

describe("scanner load slices", () => {
	it("parseInSlices validates at most one slice per turn and matches z.array", async () => {
		const counter = { items: 0 }
		const schema = z
			.object({ n: z.number() })
			.transform(v => (counter.items++, v))
		const items = Array.from({ length: 2_500 }, (_, n) => ({ n, extra: 1 }))
		const y = countingYield(counter)
		const result = await parseInSlices(items, schema, "items", y.yieldTurn)
		y.slices.push(counter.items)
		expect(result).toEqual({
			success: true,
			data: z.array(schema).parse(items),
		})
		// 2,500 items in slices of 1,024: two yields, no slice above the bound.
		expect(y.slices.slice(0, 3)).toEqual([1_024, 1_024, 452])
		expect(Math.max(...y.slices)).toBeLessThanOrEqual(SCANNER_LOAD_SLICE_ITEMS)
	})

	it("parseInSlices reports the issue path of the one-shot parse", async () => {
		const items: unknown[] = Array.from({ length: 1_500 }, (_, n) => ({ n }))
		items[1_300] = { n: "bad" }
		const schema = z.object({ n: z.number() })
		const sliced = await parseInSlices(items, schema, "items", async () => {})
		const whole = z.object({ items: z.array(schema) }).safeParse({ items })
		expect(sliced.success).toBe(false)
		expect(whole.success).toBe(false)
		if (sliced.success || whole.success) return
		expect(sliced.issues.map(i => i.path)).toEqual(
			whole.error.issues.map(i => i.path),
		)
	})

	it("restoreInSlices yields every slice and restores what restore() restores", async () => {
		const source = filledStore(40, 3)
		const snapshot = source.snapshot()
		const one = new DiscoveryStore({
			maxDiscoveries: 100_000,
			now: () => T0,
			newId: counterIds(),
		})
		one.restore(snapshot)
		const sliced = new DiscoveryStore({
			maxDiscoveries: 100_000,
			now: () => T0,
			newId: counterIds(),
		})
		let yields = 0
		await sliced.restoreInSlices(
			snapshot,
			async () => {
				yields += 1
			},
			16,
		)
		expect(sliced.snapshot()).toEqual(one.snapshot())
		// Items: each discovery inserted and normalised, each observation put.
		const items = 2 * snapshot.discoveries.length + snapshot.observations.length
		expect(snapshot.discoveries).toHaveLength(40)
		expect(yields).toBe(Math.floor(items / 16))
	})

	it("refuses ingest and a second restore until a sliced restore completes", async () => {
		const snapshot = filledStore(40, 3).snapshot()
		const store = new DiscoveryStore({
			maxDiscoveries: 100_000,
			now: () => T0 + 10_000_000,
			newId: counterIds(),
			rasters: () => [{ spacingHz: 12_500, firstChannelHz: 100_000_000 }],
		})
		const fresh = () =>
			makeObs({
				id: `late-${store.ingestsRefusedDuringRestore()}`,
				centreHz: 200_000_000,
				startedAt: T0 + 9_999_000,
				blocks: 3,
				snrDb: 25,
				cls: "analog-fm",
				hypotheses: [["analog-fm", 0.8]],
			})
		const during: string[] = []
		let second: unknown = null
		await store.restoreInSlices(
			snapshot,
			async () => {
				// Between slices, as another service running before the load completes would.
				expect(store.isRestoring()).toBe(true)
				during.push(store.ingest(fresh()).change)
				if (second === null)
					second = await store.restoreInSlices(snapshot).then(
						() => "resolved",
						(e: unknown) => e,
					)
			},
			16,
		)
		expect(during.length).toBeGreaterThan(0)
		expect(new Set(during)).toEqual(new Set(["transient"]))
		expect(store.ingestsRefusedDuringRestore()).toBe(during.length)
		expect(second).toMatchObject({ code: "SCANNER_STORE_RESTORING" })
		expect(() => {
			store.restore(snapshot)
		}).not.toThrow()
		// Nothing refused leaked into the store; after the load, ingest admits again.
		expect(store.snapshot().discoveries).toHaveLength(40)
		expect(store.isRestoring()).toBe(false)
		const after = store.ingest(fresh())
		expect(after.change).not.toBe("transient")
		expect(after.discoveryId).not.toBeNull()
	})

	it("loads a snapshot past one slice with a yield between validation slices", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-load-slices-"))
		dirs.push(dir)
		const store = filledStore(1_100, 1)
		const writer = new ScannerPersistence({ dir, logger, now: () => T0 })
		await writer.load()
		await writer.writeSnapshot(store.snapshot())
		await writer.closeSnapshotWorker()
		let yields = 0
		const reader = new ScannerPersistence({
			dir,
			logger,
			now: () => T0,
			yieldTurn: async () => {
				yields += 1
			},
		})
		const loaded = await reader.load()
		const d = loaded.discoveries.length
		const o = loaded.observations.length
		expect(d).toBe(1_100)
		expect(o).toBe(1_100)
		expect(loaded.discoveries).toEqual(store.snapshot().discoveries)
		// Slices of 1,024 in each array, plus one turn between the two arrays.
		expect(yields).toBe(
			Math.ceil(d / SCANNER_LOAD_SLICE_ITEMS) -
				1 +
				1 +
				Math.ceil(o / SCANNER_LOAD_SLICE_ITEMS) -
				1,
		)
		await reader.closeSnapshotWorker()
	})
})

import { rm } from "node:fs/promises"
import { join } from "node:path"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { ACTIVITY_RECORD_VERSION } from "../../../../../src/core/activity/storage/contract.js"
import {
	commitActivityBatch,
	openActivityDatabase,
	pruneActivityPrefix,
	readActivityState,
} from "../../../../../src/core/activity/storage/database.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import {
	buildActivityRow,
	truncateUtf8,
} from "../../../../../src/core/activity/storage/row.js"
import { envelope, roots, tempDir } from "./helpers.js"

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

describe("activity retention", () => {
	it("moves the prune watermark only forward", async () => {
		// Feature: event-foundation-batch1, Property 1: prune watermark moves only forward
		// Validates: Requirements retention
		const dir = await tempDir()
		let caseId = 0
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.boolean(), { minLength: 1, maxLength: 24 }),
				fc.integer({ min: 1, max: 8 }),
				fc.boolean(),
				async (expired, pruneBatchRows, overCap) => {
					const dbPath = join(dir, `${caseId++}.db`)
					const db = await openSqliteFile(dbPath)
					openActivityDatabase(db)
					const now = 1_700_000_000_000
					const rows = expired.map((isExpired, index) => {
						const receivedAtMs = isExpired ? now - 10_000 : now + 10_000
						const stamp = new Date(receivedAtMs).toISOString()
						const eventId = `e-${index}`
						return buildActivityRow({
							version: ACTIVITY_RECORD_VERSION,
							eventId,
							commitSeq: "0",
							producedAt: stamp,
							receivedAt: stamp,
							kind: "decoder-reception",
							payload: envelope({
								eventId,
								title: `tok${index}`,
								receivedAt: stamp,
							}),
						})
					})
					const committed = commitActivityBatch(db, rows)
					expect(committed.ok).toBe(true)
					const before = readActivityState(db, dbPath)
					const limits = {
						maxRows: overCap ? 0 : 1_000_000,
						maxDbBytes: overCap ? 0 : Number.MAX_SAFE_INTEGER,
						maxAgeMs: 1_000,
						pruneBatchRows,
						incrementalVacuumPages: 0,
					}
					const first = pruneActivityPrefix(db, limits, now)
					const expected = prefixLength(expired, pruneBatchRows, overCap)
					expect(
						BigInt(first.watermark) >= BigInt(before.identity.pruneWatermark),
					).toBe(true)
					expect(first.deleted).toBe(expected)
					if (expected === 0) {
						expect(first.changed).toBe(false)
						expect(first.watermark).toBe(before.identity.pruneWatermark)
						expect(first.generation).toBe(before.identity.pruneGeneration)
					} else {
						expect(first.changed).toBe(true)
						expect(first.watermark).toBe(String(expected))
						expect(first.generation).toBe(before.identity.pruneGeneration + 1)
					}
					const remaining = expired.length - expected
					expect(
						db.prepare("SELECT COUNT(*) AS n FROM activity").get()?.["n"],
					).toBe(remaining)
					expect(
						db.prepare("SELECT COUNT(*) AS n FROM activity_fts").get()?.["n"],
					).toBe(remaining)
					const second = pruneActivityPrefix(db, limits, now)
					expect(BigInt(second.watermark) >= BigInt(first.watermark)).toBe(true)
					if (second.changed)
						expect(second.generation).toBe(first.generation + 1)
					else expect(second.generation).toBe(first.generation)
					db.close()
				},
			),
			{ numRuns: 100 },
		)
	}, 10_000)

	it("truncates indexed text on UTF-8 boundaries", () => {
		// Feature: event-foundation-batch1, Property 2: UTF-8 truncation stays valid
		// Validates: Requirements storage indexed text
		fc.assert(
			fc.property(
				fc.string({ maxLength: 80 }),
				fc.integer({ min: 0, max: 64 }),
				(value, maxBytes) => {
					const cut = truncateUtf8(value, maxBytes)
					expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(maxBytes)
					expect(Buffer.from(cut, "utf8").toString("utf8")).toBe(cut)
				},
			),
			{ numRuns: 100 },
		)
	})
})

function prefixLength(
	expired: readonly boolean[],
	batch: number,
	overCap: boolean,
): number {
	let count = 0
	for (const isExpired of expired) {
		if (count >= batch) break
		if (!(overCap || isExpired)) break
		count += 1
	}
	return count
}

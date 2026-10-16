import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	commitActivityBatch,
	openActivityDatabase,
	pruneActivityFair,
	readActivityState,
} from "../../../../../src/core/activity/storage/database.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import type { SqliteDatabase } from "../../../../../src/core/activity/storage/sqlite.js"
import { createActivitySession } from "../../../../../src/core/activity/storage/writer-session.js"
import {
	NOW,
	readMeta,
	seqs,
	shareRow,
	smallLimits,
} from "./retention-helpers.js"
import type { MetaReading } from "./retention-helpers.js"

const DECODERS = ["readsb", "aprs", "pocsag", null] as const

/** Property 5 checked after one transaction: `deleted` are the seqs it removed. */
function checkTransaction(
	db: SqliteDatabase,
	before: MetaReading,
	deleted: readonly bigint[],
): void {
	const after = readMeta(db)
	const remaining = seqs(db)
	for (const seq of remaining) expect(seq > after.pruneWatermark).toBe(true)
	const above = deleted.filter(seq => seq > after.pruneWatermark)
	for (const seq of above) expect(seq <= after.holeWatermark).toBe(true)
	expect(after.holeWatermark >= before.holeWatermark).toBe(true)
	expect(after.pruneWatermark >= before.pruneWatermark).toBe(true)
	expect(after.holeGeneration).toBe(
		before.holeGeneration + (above.length > 0 ? 1 : 0),
	)
	expect(after.pruneGeneration).toBe(
		before.pruneGeneration +
			(after.pruneWatermark > before.pruneWatermark ? 1 : 0),
	)
	if (above.length === 0) expect(after.holeWatermark).toBe(before.holeWatermark)
	const identity = readActivityState(db, ":memory:").identity
	expect(identity.holeWatermark).toBe(after.holeWatermark.toString())
	expect(identity.holeGeneration).toBe(after.holeGeneration)
}

describe("fair-share hole bookkeeping", () => {
	it("keeps the watermark, hole watermark and generations consistent per transaction", async () => {
		// Feature: web-gaps-3, Property 5: Hole bookkeeping
		// Validates: Requirements 3.1, 3.2, 3.3, 3.4
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.integer({ min: 0, max: DECODERS.length - 1 }), {
					minLength: 1,
					maxLength: 40,
				}),
				fc.array(
					fc.array(
						fc.record({
							share: fc.integer({ min: 0, max: DECODERS.length - 1 }),
							rows: fc.integer({ min: 1, max: 8 }),
						}),
						{ minLength: 1, maxLength: 4 },
					),
					{ minLength: 1, maxLength: 8 },
				),
				async (shares, steps) => {
					const db = await openSqliteFile(":memory:")
					try {
						openActivityDatabase(db)
						const rows = shares.map((share, index) =>
							shareRow(`h-${index}`, DECODERS[share] ?? null),
						)
						expect(commitActivityBatch(db, rows).ok).toBe(true)
						for (const targets of steps) {
							const before = readMeta(db)
							const present = seqs(db)
							const result = pruneActivityFair(
								db,
								{ incrementalVacuumPages: 0 },
								targets.map(target => {
									const decoderId = DECODERS[target.share] ?? null
									return {
										decoderId,
										kind: "ingestion-gap",
										rows: target.rows,
									}
								}),
								{ rowCount: present.length, dbBytes: 0 },
							)
							const left = new Set(seqs(db))
							const deleted = present.filter(seq => !left.has(seq))
							expect(result.deleted).toBe(deleted.length)
							expect(
								[...result.deletedRows.map(row => row.seq)].sort((a, b) =>
									a < b ? -1 : a > b ? 1 : 0,
								),
							).toEqual(deleted)
							checkTransaction(db, before, deleted)
							// W' = max(W, MIN(seq) - 1), or the greatest deleted seq when empty.
							const after = readMeta(db)
							if (deleted.length > 0) {
								const min = seqs(db)[0]
								const greatest = deleted[deleted.length - 1] ?? 0n
								const floor = min === undefined ? greatest : min - 1n
								expect(after.pruneWatermark).toBe(
									floor > before.pruneWatermark ? floor : before.pruneWatermark,
								)
							} else expect(after).toEqual(before)
							expect(result.holeOpened).toBe(
								after.holeGeneration > before.holeGeneration,
							)
						}
					} finally {
						db.close()
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 30_000)

	it("never leaves a row at or below the watermark across session writes", async () => {
		// Feature: web-gaps-3, Property 5: Hole bookkeeping
		// Validates: Requirements 3.1, 3.2, 3.3, 3.4
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.array(fc.integer({ min: 0, max: DECODERS.length - 1 }), {
						minLength: 1,
						maxLength: 20,
					}),
					{ minLength: 1, maxLength: 5 },
				),
				fc.integer({ min: 10, max: 40 }),
				fc.integer({ min: 1, max: 15 }),
				async (batches, maxRows, pruneBatchRows) => {
					const db = await openSqliteFile(":memory:")
					const session = createActivitySession(
						db,
						":memory:",
						smallLimits({ maxRows, pruneBatchRows }),
					)
					try {
						const everDeleted: bigint[] = []
						let lastCommittedMax = 0n
						for (const [index, batch] of batches.entries()) {
							const before = readMeta(db)
							const present = seqs(db)
							const sequence = lastSeq(db)
							const wrote = session.write(
								batch.map((share, i) =>
									shareRow(`w${index}-${i}`, DECODERS[share] ?? null),
								),
								NOW,
							)
							expect(wrote.ok).toBe(true)
							if (!wrote.ok) return
							const after = readMeta(db)
							const left = new Set(seqs(db))
							for (const seq of present)
								if (!left.has(seq)) everDeleted.push(seq)
							// Rows committed in this write and pruned in its own burst.
							for (let seq = sequence + 1n; seq <= lastSeq(db); seq++)
								if (!left.has(seq)) everDeleted.push(seq)
							for (const seq of left)
								expect(seq > after.pruneWatermark).toBe(true)
							for (const seq of everDeleted)
								if (seq > after.pruneWatermark)
									expect(seq <= after.holeWatermark).toBe(true)
							expect(after.holeGeneration >= before.holeGeneration).toBe(true)
							expect(after.pruneGeneration >= before.pruneGeneration).toBe(true)
							const committedMax = BigInt(wrote.snapshot.identity.committedMax)
							expect(committedMax >= lastCommittedMax).toBe(true)
							expect(committedMax >= after.holeWatermark).toBe(true)
							expect(committedMax >= after.pruneWatermark).toBe(true)
							lastCommittedMax = committedMax
							expect(wrote.snapshot.identity.holeWatermark).toBe(
								after.holeWatermark.toString(),
							)
							expect(wrote.snapshot.identity.holeGeneration).toBe(
								after.holeGeneration,
							)
						}
					} finally {
						session.close()
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 30_000)
})

function lastSeq(db: SqliteDatabase): bigint {
	const row = db
		.prepare(
			"SELECT CAST(seq AS TEXT) AS s FROM sqlite_sequence WHERE name = 'activity'",
		)
		.get()
	return row ? BigInt(String(row["s"])) : 0n
}

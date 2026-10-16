import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	activityLowWater,
	commitActivityBatch,
	openActivityDatabase,
} from "../../../../../src/core/activity/storage/database.js"
import type { ActivityRetentionPolicy } from "../../../../../src/core/activity/storage/contract.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import type { BuiltActivityRow } from "../../../../../src/core/activity/storage/row.js"
import type { SqliteDatabase } from "../../../../../src/core/activity/storage/sqlite.js"
import { createActivitySession } from "../../../../../src/core/activity/storage/writer-session.js"
import type { ActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import {
	NOW,
	faultyDb,
	groupedScan,
	readMeta,
	seqs,
	shareRow,
	sharesOf,
	smallLimits,
} from "./retention-helpers.js"

const DECODERS = ["readsb", "aprs", "pocsag", null] as const

interface Spec {
	share: number
	blob: number
	ageMs: number
}

const rowSpec = fc.record({
	share: fc.integer({ min: 0, max: DECODERS.length - 1 }),
	blob: fc.integer({ min: 10, max: 1_500 }),
	ageMs: fc.integer({ min: 0, max: 400_000 }),
})

function buildBatch(
	batch: readonly Spec[],
	prefix: string,
	single = false,
): BuiltActivityRow[] {
	return batch.map((spec, index) =>
		shareRow(
			`${prefix}-${index}`,
			single ? "readsb" : (DECODERS[spec.share] ?? null),
			NOW - spec.ageMs,
			spec.blob,
		),
	)
}

async function memoryDb(): Promise<SqliteDatabase> {
	return openSqliteFile(":memory:")
}

describe("fair-share retention in the writer session", () => {
	it("binds the row and byte caps, including the prefix fallback", async () => {
		// Feature: web-gaps-3, Property 2: Caps bind
		// Validates: Requirements 1.4, 1.12
		let fallbacks = 0
		let holes = 0
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.array(rowSpec, { minLength: 1, maxLength: 20 }), {
					minLength: 1,
					maxLength: 4,
				}),
				fc.integer({ min: 20, max: 50 }),
				fc.integer({ min: 110_000, max: 180_000 }),
				fc.integer({ min: 2, max: 25 }),
				fc.boolean(),
				fc.array(
					fc.record({
						share: fc.integer({ min: 0, max: DECODERS.length - 1 }),
						blob: fc.integer({ min: 800, max: 1_500 }),
						ageMs: fc.constant(0),
					}),
					{ maxLength: 50 },
				),
				async (batches, maxRows, maxDbBytes, pruneBatchRows, zero, seed) => {
					const db = await memoryDb()
					openActivityDatabase(db)
					// Rows already on disk; zeroed record bytes make every share look empty to
					// the byte planner, so only the prefix fallback can free the live pages.
					if (seed.length > 0)
						expect(commitActivityBatch(db, buildBatch(seed, "seed")).ok).toBe(
							true,
						)
					if (zero) db.exec("UPDATE activity SET record_bytes = 0")
					const limits = smallLimits({ maxRows, maxDbBytes, pruneBatchRows })
					const session = createActivitySession(db, ":memory:", limits)
					try {
						let rows = session.snapshot().rows
						for (const [index, batch] of batches.entries()) {
							const wrote = session.write(buildBatch(batch, `b${index}`), NOW)
							expect(wrote.ok).toBe(true)
							if (!wrote.ok) return
							expect(wrote.note).toBeUndefined()
							const before = rows + wrote.commit.committed
							rows = wrote.snapshot.rows
							expect(rows).toBeLessThanOrEqual(maxRows)
							if (before > maxRows)
								expect(rows).toBeLessThanOrEqual(activityLowWater(maxRows))
							expect(wrote.snapshot.dbBytes).toBeLessThanOrEqual(maxDbBytes)
							if (wrote.prune.dbBytes > maxDbBytes)
								expect(wrote.snapshot.dbBytes).toBeLessThanOrEqual(
									activityLowWater(maxDbBytes),
								)
						}
						fallbacks += session.snapshot().retention.prefixFallbackSteps
						holes += readMeta(db).holeGeneration
					} finally {
						session.close()
					}
				},
			),
			{ numRuns: 100 },
		)
		// The generated stores reach both the fair step and the prefix fallback.
		expect({ fallbacks: fallbacks > 0, holes: holes > 0 }).toEqual({
			fallbacks: true,
			holes: true,
		})
	}, 30_000)

	it("deletes exactly what oldest-first deletes when there is one share", async () => {
		// Feature: web-gaps-3, Property 3: Single share equals oldest-first
		// Validates: Requirements 1.13, 1.14
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.array(rowSpec, { minLength: 1, maxLength: 15 }), {
					minLength: 1,
					maxLength: 3,
				}),
				fc.integer({ min: 20, max: 50 }),
				fc.integer({ min: 110_000, max: 200_000 }),
				fc.integer({ min: 2, max: 25 }),
				fc.boolean(),
				async (batches, maxRows, maxDbBytes, pruneBatchRows, aged) => {
					const limits = smallLimits({
						maxRows,
						maxDbBytes,
						pruneBatchRows,
						...(aged ? { maxAgeMs: 100_000 } : {}),
					})
					const open = async (policy: ActivityRetentionPolicy) => {
						const db = await memoryDb()
						const session = createActivitySession(db, ":memory:", {
							...limits,
							retentionPolicy: policy,
						})
						return { db, session }
					}
					const fair = await open("fair-share")
					const prefix = await open("oldest-first")
					try {
						for (const [index, batch] of batches.entries()) {
							const rows = buildBatch(batch, `s${index}`, true)
							const a = fair.session.write(rows, NOW)
							const b = prefix.session.write(rows, NOW)
							expect(a.ok && b.ok).toBe(true)
							if (!a.ok || !b.ok) return
							expect(a.prune).toEqual(b.prune)
							expect(seqs(fair.db)).toEqual(seqs(prefix.db))
							expect(readMeta(fair.db)).toEqual(readMeta(prefix.db))
							expect(readMeta(fair.db).holeGeneration).toBe(0)
							expect({ ...a.snapshot.identity, storeUuid: "" }).toEqual({
								...b.snapshot.identity,
								storeUuid: "",
							})
						}
					} finally {
						fair.session.close()
						prefix.session.close()
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 30_000)

	it("keeps the counters equal to the grouped scan through commits and prunes", async () => {
		// Feature: web-gaps-3, Property 4: Counters
		// Validates: Requirements 1.7, 1.9, 1.10
		const op = fc.oneof(
			fc.record({
				type: fc.constant("write" as const),
				rows: fc.array(rowSpec, { minLength: 1, maxLength: 15 }),
				duplicates: fc.integer({ min: 0, max: 5 }),
				oversize: fc.boolean(),
			}),
			fc.record({
				type: fc.constant("failing-prune" as const),
				rows: fc.array(rowSpec, { minLength: 1, maxLength: 10 }),
			}),
			fc.record({ type: fc.constant("failing-commit" as const) }),
		)
		await fc.assert(
			fc.asyncProperty(
				fc.array(op, { minLength: 1, maxLength: 6 }),
				fc.integer({ min: 15, max: 40 }),
				fc.integer({ min: 1, max: 20 }),
				async (ops, maxRows, pruneBatchRows) => {
					const raw = await memoryDb()
					let fault: "prune" | "commit" | null = null
					const db = faultyDb(
						raw,
						sql =>
							fault === "prune"
								? /^DELETE FROM activity WHERE seq/.test(sql)
								: /^INSERT INTO activity \(/.test(sql.trim()),
						() => fault !== null,
					)
					const limits: ActivityLimits = smallLimits({
						maxRows,
						pruneBatchRows,
					})
					const session = createActivitySession(db, ":memory:", limits)
					const seen: string[] = []
					let serial = 0
					try {
						for (const step of ops) {
							const before = groupedScan(raw)
							if (step.type === "failing-commit") {
								fault = "commit"
								expect(() =>
									session.write([shareRow(`fc-${serial++}`, "aprs")], NOW),
								).toThrow(/injected/)
								fault = null
								expect(groupedScan(raw)).toEqual(before)
								expect(sharesOf(session.snapshot().retention.shares)).toEqual(
									before,
								)
								continue
							}
							const rows = buildBatch(step.rows, `p${serial++}`)
							if (step.type === "write") {
								for (let i = 0; i < step.duplicates && seen.length > 0; i++) {
									const eventId = seen[(serial + i) % seen.length] ?? "x"
									rows.push(shareRow(eventId, "pocsag"))
								}
								if (step.oversize)
									rows.push({
										...shareRow(`big-${serial}`, "readsb"),
										recordJson: "x".repeat(150 * 1024),
									})
								// An in-batch duplicate: only the first copy commits.
								const first = rows[0]
								if (first) rows.push({ ...first, decoderId: "aprs" })
							} else fault = "prune"
							const wrote = session.write(rows, NOW)
							fault = null
							expect(wrote.ok).toBe(true)
							if (!wrote.ok) return
							if (step.type === "failing-prune" && wrote.note !== undefined)
								expect(wrote.prune.deleted).toBe(0)
							for (const id of wrote.commit.committedEventIds) seen.push(id)
							const scan = groupedScan(raw)
							expect(sharesOf(wrote.snapshot.retention.shares)).toEqual(scan)
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

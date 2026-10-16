import { rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, describe, it } from "vitest"
import type { ActivityRetentionPolicy } from "../../../../../src/core/activity/storage/contract.js"
import { openSqliteFile } from "../../../../../src/core/activity/storage/probe.js"
import type { BuiltActivityRow } from "../../../../../src/core/activity/storage/row.js"
import type { SqliteDatabase } from "../../../../../src/core/activity/storage/sqlite.js"
import type { ActivityLimits } from "../../../../../src/core/activity/storage/limits.js"
import type { ActivitySession } from "../../../../../src/core/activity/storage/writer-session.js"
import { createActivitySession } from "../../../../../src/core/activity/storage/writer-session.js"
import { roots, tempDir } from "./helpers.js"
import { NOW, shareRow, smallLimits } from "./retention-helpers.js"

/**
 * Retention benchmark. Skipped unless WAVEKIT_RETENTION_BENCH is set; it prints a table to
 * stdout and asserts nothing.
 */

const MIX: readonly (readonly [string, number])[] = [
	["readsb", 1296],
	["aprs", 216],
	["meshtastic", 43],
	["pocsag", 6],
]
const MIX_TOTAL = MIX.reduce((sum, [, weight]) => sum + weight, 0)
const POLICIES: readonly ActivityRetentionPolicy[] = [
	"fair-share",
	"oldest-first",
]
const BATCH = 1_000

function decoderFor(index: number): string {
	let slot = index % MIX_TOTAL
	for (const [id, weight] of MIX) {
		if (slot < weight) return id
		slot -= weight
	}
	return "readsb"
}

function batch(
	tag: string,
	start: number,
	count: number,
	blob: number,
): BuiltActivityRow[] {
	const rows: BuiltActivityRow[] = []
	for (let i = start; i < start + count; i++)
		rows.push(shareRow(`${tag}-${i}`, decoderFor(i), NOW + i, blob))
	return rows
}

async function open(
	dir: string,
	limits: ActivityLimits,
): Promise<{ session: ActivitySession; db: SqliteDatabase; path: string }> {
	const path = join(dir, "activity.db")
	const db = await openSqliteFile(path)
	return { session: createActivitySession(db, path, limits), db, path }
}

function write(session: ActivitySession, rows: BuiltActivityRow[]): number {
	const result = session.write(rows, NOW + 10_000_000)
	if (!result.ok) throw new Error(result.message)
	return result.prune.deleted
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)] ?? 0
}

interface Result {
	policy: string
	seedMs: number
	deleteRowsPerSec: number
	fileMiB: number
	retainedRows: number
	retainedShares: string
}

const results: Result[] = []

afterAll(async () => {
	if (results.length === 0) return
	console.log(`retention bench\n${JSON.stringify(results, null, 2)}`)
	await Promise.all(
		roots.map(path => rm(path, { recursive: true, force: true })),
	)
})

describe.skipIf(!process.env["WAVEKIT_RETENTION_BENCH"])(
	"retention benchmark",
	() => {
		for (const policy of POLICIES) {
			it(`measures ${policy}`, { timeout: 1_800_000 }, async () => {
				// 1. seed time on a 250 000-row store.
				const seedDir = await tempDir()
				const seedLimits = smallLimits({ retentionPolicy: policy })
				const first = await open(seedDir, seedLimits)
				for (let i = 0; i < 250_000; i += BATCH)
					write(first.session, batch("seed", i, BATCH, 120))
				first.session.checkpoint("close")
				first.session.close()
				const seeds: number[] = []
				for (let n = 0; n < 3; n++) {
					const again = await open(seedDir, seedLimits)
					seeds.push(again.session.seedMs)
					again.session.close()
				}

				// 2. delete rows/s during cap bursts: 250k rows at the cap, 100k more arrive.
				const burstDir = await tempDir()
				const burstLimits = smallLimits({
					retentionPolicy: policy,
					maxRows: 250_000,
				})
				const burst = await open(burstDir, burstLimits)
				for (let i = 0; i < 250_000; i += BATCH)
					write(burst.session, batch("fill", i, BATCH, 120))
				let deleted = 0
				const started = performance.now()
				for (let i = 0; i < 100_000; i += BATCH)
					deleted += write(burst.session, batch("burst", i, BATCH, 120))
				const seconds = (performance.now() - started) / 1000
				burst.session.close()

				// 3. file size after 10 cap cycles of 50 000 rows.
				const cycleDir = await tempDir()
				const cycle = await open(
					cycleDir,
					smallLimits({ retentionPolicy: policy, maxRows: 50_000 }),
				)
				for (let c = 0; c < 10; c++)
					for (let i = 0; i < 50_000; i += BATCH)
						write(cycle.session, batch(`c${c}`, i, BATCH, 120))
				cycle.session.checkpoint("close")
				const fileBytes = (await stat(cycle.path)).size
				cycle.session.close()

				// 4. rows retained at a 64 MiB byte cap, same stream.
				const capDir = await tempDir()
				const cap = await open(
					capDir,
					smallLimits({
						retentionPolicy: policy,
						maxDbBytes: 64 * 1024 * 1024,
					}),
				)
				for (let i = 0; i < 400_000; i += BATCH)
					write(cap.session, batch("cap", i, BATCH, 300))
				const snap = cap.session.snapshot()
				const shares = snap.retention.shares
					.map(share => `${share.key}=${share.rows}`)
					.join(" ")
				const retainedRows = snap.rows
				cap.session.close()

				results.push({
					policy,
					seedMs: median(seeds),
					deleteRowsPerSec: Math.round(deleted / seconds),
					fileMiB: Math.round((fileBytes / 1048576) * 10) / 10,
					retainedRows,
					retainedShares: shares,
				})
			})
		}
	},
)

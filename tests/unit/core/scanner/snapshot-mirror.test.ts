/**
 * WG11 req 3.5/3.6: the snapshot mirror builds the text today's writeSnapshot builds.
 * Goldens were recorded from the frozen WG11 base (persistence.ts and discovery-store.ts at
 * 14f2feaa, before any SC change): seeded op sequences, fixed clocks, sha256 of discoveries.json.
 */
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type {
	JournalEntry,
	StoreSnapshot,
} from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import { PreparedRecordingOperationsSchema } from "../../../../src/core/scanner/store/recording-operation.js"
import {
	SnapshotMirror,
	snapshotHeadOf,
} from "../../../../src/core/scanner/store/snapshot-mirror.js"
import { createLogger } from "../../../../src/utils/logger.js"
import {
	applySeededOps,
	mulberry32,
	OPS_T0,
	seededStore,
} from "./snapshot-mirror-ops.js"

const logger = createLogger({ level: "fatal" })
const SAVED_AT = OPS_T0 + 7
const sha = (text: string): string =>
	createHash("sha256").update(text).digest("hex")

/** Seed, ops, maxDiscoveries, dense, then the frozen base's byte length and sha256. */
const GOLDENS: [number, number, number, boolean, number, string][] = [
	[
		1,
		0,
		40,
		false,
		139,
		"972d800bb561ddae09068cd00ed412979805a88c7abc67889b02c67f222d382e",
	],
	[
		2,
		40,
		40,
		false,
		21605,
		"247138462b3410c64033fc45f8f92b115206ea47043a2dd76c298f3ceb3da43f",
	],
	[
		3,
		400,
		40,
		false,
		35744,
		"f4c3ce14b41fbf5617d04117a9b3f89e5e220c39772fafe0a2e1008f4d86beb8",
	],
	[
		4,
		1500,
		12,
		false,
		38270,
		"0d43089e22fea6b236f9f063144e074281ad2c8a3482ff8ffa2633c16b1b0930",
	],
	[
		5,
		1200,
		200,
		false,
		68712,
		"5ec493568b75fd4849a3befd8ca47df7e55cc6c947f29584dbbdacf958fc6d48",
	],
	[
		6,
		700,
		40,
		true,
		390051,
		"bf50c6466c9335f37fcf80d99d6216b22f1ee66074b0af9d681823833473a0f4",
	],
]

const lineOf = (seq: number, e: Omit<JournalEntry, "seq">): string =>
	`${JSON.stringify({ seq, at: e.at, op: e.op, payload: e.payload })}\n`

/** The frozen writeSnapshot expression (persistence.ts at the WG11 base), for the property. */
function frozenText(
	s: StoreSnapshot,
	lastSeq: number,
	savedAtMs: number,
): string {
	const prepared = PreparedRecordingOperationsSchema.parse(
		s.recordingOperations ?? [],
	)
	return JSON.stringify({
		version: 1,
		lastSeq,
		savedAt: new Date(savedAtMs).toISOString(),
		discoveries: s.discoveries,
		observations: s.observations,
		corrections: s.corrections,
		recordingOperations: prepared,
		...(s.aliases && s.aliases.length > 0 ? { aliases: s.aliases } : {}),
	})
}

function mirrorText(
	mirror: SnapshotMirror,
	s: StoreSnapshot,
	lastSeq: number,
	savedAtMs: number,
): string {
	const prepared = PreparedRecordingOperationsSchema.parse(
		s.recordingOperations ?? [],
	)
	return mirror.build(snapshotHeadOf(s, prepared, lastSeq, savedAtMs))
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-mirror-"))
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

describe("snapshot mirror goldens (WG11 req 3.5)", () => {
	it.each(GOLDENS)(
		"seed %i: main path, writeSnapshotOf fallback and mirror text match the frozen base byte for byte",
		async (seed, n, max, dense, bytes, hash) => {
			const run = seededStore(max)
			applySeededOps(
				run,
				mulberry32(seed),
				n,
				dense ? { channels: 1, ingestShare: 0.99 } : {},
			)
			const mirror = new SnapshotMirror()
			run.entries.forEach((e, i) => mirror.applyLine(lineOf(i + 1, e)))
			const s = run.store.snapshot()
			const built = mirrorText(mirror, s, run.entries.length, SAVED_AT)
			expect([seed, built.length, sha(built)]).toEqual([seed, bytes, hash])
			expect(mirror.counts()).toEqual({
				discoveries: s.discoveries.length,
				observations: s.observations.length,
			})
			await withDir(async dir => {
				const p = new ScannerPersistence({
					dir,
					logger,
					now: () => SAVED_AT,
					snapshotWorker: { enabled: false },
				})
				await p.load()
				for (const e of run.entries) void p.append(e).catch(() => undefined)
				await p.writeSnapshot(run.store.snapshot())
				const main = await readFile(join(dir, "discoveries.json"), "utf8")
				expect(sha(main)).toBe(hash)
				await p.writeSnapshotOf(run.store)
				const fallback = await readFile(join(dir, "discoveries.json"), "utf8")
				expect(sha(fallback)).toBe(hash)
			})
		},
		30_000,
	)
})

describe("snapshot mirror property (WG11 req 3.5)", () => {
	// Feature: web-gaps-11, Property 8: worker snapshot text equals today's snapshot text
	// Validates: Requirements 3.5, 3.6
	it("matches JSON.stringify of today's snapshot after any op sequence, with resets mid-way", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 2 ** 31 - 1 }),
				fc.integer({ min: 0, max: 50 }),
				fc.integer({ min: 0, max: 50 }),
				fc.boolean(),
				fc.integer({ min: 0, max: 10_000_000 }),
				(seed, first, second, dense, savedOffset) => {
					const run = seededStore(dense ? 40 : 15)
					const rand = mulberry32(seed)
					const opts = dense ? { channels: 2, ingestShare: 0.9 } : {}
					applySeededOps(run, rand, first, opts)
					const mirror = new SnapshotMirror()
					run.entries.forEach((e, i) => mirror.applyLine(lineOf(i + 1, e)))
					const mid = run.entries.length
					// Reset from the main path's own text, then keep feeding.
					const midText = frozenText(run.store.snapshot(), mid, OPS_T0)
					const reset = new SnapshotMirror()
					reset.resetFromText(midText, mid)
					expect(mirrorText(reset, run.store.snapshot(), mid, OPS_T0)).toBe(
						midText,
					)
					applySeededOps(run, rand, second, { ...opts, obsBase: 100_000 })
					for (let i = mid; i < run.entries.length; i++) {
						const entry = run.entries[i]
						if (entry === undefined) continue
						mirror.applyLine(lineOf(i + 1, entry))
						reset.applyLine(lineOf(i + 1, entry))
					}
					const s = run.store.snapshot()
					const lastSeq = run.entries.length
					const savedAt = OPS_T0 + savedOffset
					const want = frozenText(s, lastSeq, savedAt)
					expect(mirrorText(mirror, s, lastSeq, savedAt)).toBe(want)
					expect(mirrorText(reset, s, lastSeq, savedAt)).toBe(want)
					expect(mirror.broken()).toBeNull()
					expect(mirror.lastSeq()).toBe(lastSeq)
				},
			),
			{ numRuns: 100 },
		)
	}, 30_000)

	// Feature: web-gaps-11, Property 8: worker snapshot text equals today's snapshot text
	// Validates: Requirements 3.5
	it("never changes on hostile input: malformed, out-of-order or non-object lines break it instead", () => {
		const run = seededStore()
		applySeededOps(run, mulberry32(9), 60)
		const s = run.store.snapshot()
		const lastSeq = run.entries.length
		const want = frozenText(s, lastSeq, SAVED_AT)
		fc.assert(
			fc.property(
				fc.oneof(
					fc.string({ maxLength: 200 }),
					fc.jsonValue({ maxDepth: 3 }).map(v => JSON.stringify(v) ?? ""),
					fc.constant(
						`${JSON.stringify({ seq: 1, at: "x", op: "observation", payload: { discoveries: [], observations: [], deleted: [] } })}\n`,
					),
					fc.constant(
						`${JSON.stringify({ seq: lastSeq + 1, payload: { discoveries: [{ noId: 1 }], observations: [], deleted: [] } })}\n`,
					),
					fc.constant(
						`${JSON.stringify({ seq: lastSeq + 1, payload: { discoveries: [], observations: [{ id: "o", discoveryId: 3, startedAt: "t" }], deleted: [] } })}\n`,
					),
				),
				fc.anything(),
				(line, removal) => {
					const mirror = new SnapshotMirror()
					run.entries.forEach((e, i) => mirror.applyLine(lineOf(i + 1, e)))
					const counts = mirror.counts()
					mirror.applyLine(line)
					if (mirror.broken() === null) {
						// Only a well-formed line with a later seq is applied.
						const parsed = JSON.parse(line) as { seq: number }
						expect(parsed.seq).toBeGreaterThan(lastSeq)
						return
					}
					expect(mirror.counts()).toEqual(counts)
					expect(mirror.lastSeq()).toBe(lastSeq)
					const other = new SnapshotMirror()
					run.entries.forEach((e, i) => other.applyLine(lineOf(i + 1, e)))
					other.applyRemoval(removal)
					if (other.broken() === null)
						expect(
							mirrorText(other, s, lastSeq, SAVED_AT).length,
						).toBeLessThanOrEqual(want.length)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("snapshot mirror copies (WG11 req 3.5)", () => {
	it("holds texts, not references: mutating the store's records or the journal payload changes nothing", () => {
		const run = seededStore()
		applySeededOps(run, mulberry32(11), 80)
		const mirror = new SnapshotMirror()
		run.entries.forEach((e, i) => mirror.applyEntry(i + 1, e.payload))
		const s = run.store.snapshot()
		const lastSeq = run.entries.length
		const before = mirrorText(mirror, s, lastSeq, SAVED_AT)
		for (const e of run.entries) {
			const payload = e.payload as {
				discoveries: { id: string; frequencyHz: number }[]
			}
			for (const d of payload.discoveries) d.frequencyHz = -1
		}
		const again = run.store.snapshot()
		for (const d of again.discoveries) d.frequencyHz = -2
		expect(mirrorText(mirror, s, lastSeq, SAVED_AT)).toBe(before)
		expect(before).toBe(frozenText(s, lastSeq, SAVED_AT))
	})

	it("applies a mirror removal as the store's silent removal (discovery with its observations)", () => {
		const run = seededStore()
		applySeededOps(run, mulberry32(12), 80)
		const mirror = new SnapshotMirror()
		run.entries.forEach((e, i) => mirror.applyLine(lineOf(i + 1, e)))
		const s = run.store.snapshot()
		const victim = s.discoveries[0]
		const obs = s.observations.find(o => o.discoveryId !== victim?.id)
		if (victim === undefined || obs === undefined) throw new Error("fixture")
		mirror.applyRemoval({ discoveries: [victim.id], observations: [obs.id] })
		const expected: StoreSnapshot = {
			...s,
			discoveries: s.discoveries.filter(d => d.id !== victim.id),
			observations: s.observations.filter(
				o => o.discoveryId !== victim.id && o.id !== obs.id,
			),
		}
		expect(mirrorText(mirror, s, run.entries.length, SAVED_AT)).toBe(
			frozenText(expected, run.entries.length, SAVED_AT),
		)
	})
})

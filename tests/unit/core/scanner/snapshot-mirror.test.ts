/**
 * WG11 req 3.5/3.6: the snapshot mirror builds the text today's writeSnapshot builds.
 * Seeded op sequences, fixed clocks, sha256 of discoveries.json. Seed 1 is the empty store.
 * Seeds 2-6 were refreshed when protocol and confidence stopped following hypotheses and a
 * discovery required a passed gate (requirements 2.5, 3.1, 3.2). Seeds 3-5 were refreshed
 * again when association and splitting started to follow the evidence-established family.
 * Association: an evidence-less observation can sticky-match a decoded discovery. Split: an
 * identity decode whose family cannot share a proof-established family (DMR beside a
 * CTCSS-proven analog card) goes to a linked co-channel discovery, and an identity decode
 * that conflicts with the discovery's identity moves its observation to the matching twin.
 * A family stored only from an identity-less decode does not split. Each of seeds 3-5
 * first diverges on an observation entry (a sticky join: entries 329, 492 and 358), and
 * the split rules change later entries. Seeds 1, 2 and 6 did not change. This file has no
 * record flag.
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
// WG15 DQ: re-baselined after the seeded ops moved undecoded SNR from 10..29 to 18..37 dB (DQ 1.3
// creation bar). Same op stream and structure (byte lengths unchanged); only the SNR fields moved.
// Re-baselined again for DQ.4-DQ.6: `class` is now the majority of the last 64 observations (3.4),
// cross-family sticky joins (2.1) and co-channel pruning (2.3) apply; the seeded ops use one
// OBW, so 3.1 never refuses. Each observation now also persists its `classVote` (DQ 3.4), which
// is why seeds 2 to 6 grew (seed 1 holds no observations). Seed 3 re-baselined for DQ 9.1: at entry 22
// an observation now joins the record on its key whose analog-fm label is an unconfirmed guess
// (association family unknown) instead of creating one beside it; byte length unchanged.
// Seeds 3 to 5 re-baselined again for DQ 9.3: an evidence-less sighting reaches a decoded record of
// another family only within 1 000 Hz and inside its band, so a few sightings land on the nearest
// same-family record instead (seed 5 text 4 293 bytes shorter, seeds 3 and 4 by 2 and 3 bytes).
// Scanner-redesign 3.11 adds the persisted `short` hint input on each observation: seeds 2 to 6
// grew again. With both, seeds 3 to 5 carry the DQ 9.1/9.3 association and the `short` input: each
// length is the DQ length plus the `short` bytes of the observations it keeps (seeds 3 and 4 the
// same +461 and +859 bytes as without DQ 9.3, seed 5 +912 instead of +964 as it keeps fewer).
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
		19860,
		"a75d40733bcafec93815f678f0ae7c9e1d490181fc7cd07e695c4b10a65e49e9",
	],
	[
		3,
		400,
		40,
		false,
		39900,
		"b23b2e4219617ea3842f6e79b4f3a868f51494949cbb277c9bc17a8e4422dddd",
	],
	[
		4,
		1500,
		12,
		false,
		64595,
		"28f7dd7d1c797a886287992d36fbc53fa499af6213f603f00c241481a4ab0d25",
	],
	[
		5,
		1200,
		200,
		false,
		68648,
		"4e124573513250f8de7bb3558d2e3bef7367d7a7b0cf3201d3abd03343b2b3f0",
	],
	[
		6,
		700,
		40,
		true,
		353110,
		"94e63c3bacc3d4eec6fe66c34dca1f12168147e60c487734c4bf19d6975c211b",
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

describe("snapshot mirror seq gaps (WG11 review)", () => {
	it("marks the mirror broken on a lost line between otherwise contiguous seqs", () => {
		const run = seededStore()
		applySeededOps(run, mulberry32(13), 40)
		expect(run.entries.length).toBeGreaterThan(3)
		const mirror = new SnapshotMirror()
		mirror.applyLine(lineOf(1, run.entries[0]!))
		// seq 2 is lost; seq 3 alone would leave lastSeq and possibly the counts matching
		run.entries.slice(2).forEach((e, i) => mirror.applyLine(lineOf(i + 3, e)))
		expect(mirror.broken()).toBe("seq gap")
	})

	it("accepts the line right after a reset's seq and refuses one past it", () => {
		const run = seededStore()
		applySeededOps(run, mulberry32(14), 20)
		const s = run.store.snapshot()
		const text = frozenText(s, 7, SAVED_AT)
		const next = run.entries[0]!
		const ok = new SnapshotMirror()
		ok.resetFromText(text, 7)
		ok.applyLine(lineOf(8, next))
		expect(ok.broken()).toBeNull()
		expect(ok.lastSeq()).toBe(8)
		const gap = new SnapshotMirror()
		gap.resetFromText(text, 7)
		gap.applyLine(lineOf(9, next))
		expect(gap.broken()).toBe("seq gap")
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

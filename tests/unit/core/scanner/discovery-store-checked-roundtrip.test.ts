import { setImmediate } from "node:timers/promises"
import fc from "fast-check"
import { expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"
import { legacySnapshot, T0 } from "./consolidation-fixtures.js"

const F = 123_456_000
const initial = (legacy: boolean, count = 5) => {
	const snapshot = legacySnapshot([
		{
			id: "d_seed",
			count,
			centreHz: F,
			family: "digital-voice",
			protocol: "dmr",
			identity: dmrCc(2),
		},
	])
	if (legacy)
		for (const o of snapshot.observations)
			for (const ev of o.decode ?? []) delete ev.contentVerified
	return snapshot
}
const create = (now = () => T0 + 31_003.7) =>
	new DiscoveryStore({ maxDiscoveries: 20, now, newId: counterIds() })

it.each([true, false])(
	"round-trips identity-less checked metadata (legacy: %s)",
	legacy => {
		const start = initial(legacy)
		const live = create()
		live.restore(start)
		const replayed = create()
		replayed.restore(start)
		let seq = 0
		live.on("mutation", (entry: Omit<JournalEntry, "seq">) =>
			replayed.replay({ ...entry, seq: ++seq }),
		)
		live.applyEvidence(
			"d_seed",
			evidence("dmr", T0 + 503.7, { talkgroups: ["1"] }),
		)
		const restored = create()
		restored.restore(live.snapshot())
		expect(restored.snapshot()).toEqual(live.snapshot())
		expect(replayed.snapshot()).toEqual(live.snapshot())
		expect(live.get("d_seed")?.metadata.talkgroups).toEqual(legacy ? [] : ["1"])
	},
)

it("persists checked co-channel observation provenance before retention", () => {
	const start = initial(true)
	const other = structuredClone(start.discoveries[0]!)
	other.id = "d_partner"
	other.coChannel = ["d_seed"]
	start.discoveries[0]!.coChannel = ["d_partner"]
	start.discoveries.push(other)
	const live = create()
	live.restore(start)
	live.appendObservationEvidence(
		"d_seed-o0",
		evidence("dmr", T0 + 73.7, { identity: dmrCc(2) }),
	)
	expect(
		live.snapshot().discoveries.every(d => d.contentVerified === true),
	).toBe(true)
	// Trim the checked row from the observation's bounded decode history.
	for (let i = 0; i < 20; i++)
		live.appendObservationEvidence(
			"d_seed-o0",
			evidence("dmr", T0 + 103.7 + i * 17, {
				contentVerified: false,
			}),
		)
	expect(
		live
			.snapshot()
			.observations[0]?.decode?.every(ev => ev.contentVerified !== true),
	).toBe(true)
	expect(
		live.snapshot().discoveries.every(d => d.contentVerified === true),
	).toBe(true)

	const restored = create()
	restored.restore(live.snapshot())
	expect(restored.snapshot()).toEqual(live.snapshot())
})

it.each([true, false])(
	"adopts only a checked identity onto a verified survivor (checked: %s)",
	checked => {
		const start = legacySnapshot([
			{
				id: "d_keep",
				centreHz: F,
				family: "digital-voice",
				protocol: "dmr",
				firstSeenMs: T0,
			},
			{
				id: "d_drop",
				centreHz: F,
				family: "digital-voice",
				protocol: "dmr",
				identity: dmrCc(2),
				firstSeenMs: T0 + 13,
			},
		])
		if (!checked)
			for (const o of start.observations)
				for (const ev of o.decode ?? []) delete ev.contentVerified
		start.discoveries[0]!.contentVerified = true
		start.discoveries[0]!.metadata.talkgroups = ["71"]
		const live = create()
		const replayed = create()
		live.restore(start)
		replayed.restore(start)
		let seq = 0
		live.on("mutation", (entry: Omit<JournalEntry, "seq">) =>
			replayed.replay({ ...entry, seq: ++seq }),
		)
		expect(live.get("d_drop")?.identity).toEqual(checked ? dmrCc(2) : undefined)
		const plan = checked
			? { groups: [{ survivor: "d_keep", members: ["d_drop"] }] }
			: live.consolidationPlan()
		expect(plan.groups).toEqual([{ survivor: "d_keep", members: ["d_drop"] }])
		live.applyConsolidation(plan)
		expect(live.snapshot().discoveries).toHaveLength(1)
		expect(live.get("d_keep")?.identity).toEqual(checked ? dmrCc(2) : undefined)
		expect(live.get("d_keep")?.metadata.talkgroups).toEqual(["71"])
		const restored = create()
		restored.restore(live.snapshot())
		expect(restored.snapshot()).toEqual(live.snapshot())
		expect(replayed.snapshot()).toEqual(live.snapshot())
	},
)

// Feature: dsd-fme checked content, Property 10: persisted verification survives store operations
// Validates: Requirements R2, R5
it(
	"restore and journal replay exactly reproduce random live mutations",
	{ timeout: 120_000 },
	async () => {
		const counts = {
			runs: 0,
			legacyStarts: 0,
			merges: 0,
			evictions: 0,
			trims: 0,
		}
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.record({
						kind: fc.integer({ min: 0, max: 7 }),
						slot: fc.integer({ min: 0, max: 5 }),
						cc: fc.integer({ min: 0, max: 3 }),
						checked: fc.boolean(),
						identity: fc.boolean(),
					}),
					{ minLength: 30, maxLength: 90 },
				),
				async ops => {
					// Keep long retention runs from blocking Vitest worker updates.
					await setImmediate()
					let clock = T0 + 31_003.7
					const live = create(() => clock)
					const replayed = create(() => clock)
					const legacy = counts.runs++ % 2 === 0
					if (legacy) counts.legacyStarts++
					const start = initial(legacy, 250)
					const partner = legacySnapshot([
						{
							id: "d_partner",
							centreHz: F + 25_000,
							family: "digital-voice",
							protocol: "dmr",
							identity: dmrCc(1),
						},
					])
					if (legacy)
						for (const o of partner.observations)
							for (const ev of o.decode ?? []) delete ev.contentVerified
					start.discoveries.push(...partner.discoveries)
					start.observations.push(...partner.observations)
					live.restore(start)
					replayed.restore(start)
					let seq = 0
					live.on("mutation", (entry: Omit<JournalEntry, "seq">) =>
						replayed.replay({ ...entry, seq: ++seq }),
					)
					live.on("evicted", (discoveries: unknown[]) => {
						counts.evictions += discoveries.length
					})
					const assertRoundTrip = () => {
						const snapshot = live.snapshot()
						const restored = create(() => clock)
						restored.restore(snapshot)
						expect(restored.snapshot()).toEqual(snapshot)
						expect(replayed.snapshot()).toEqual(snapshot)
						for (const d of snapshot.discoveries) {
							const published = (store: DiscoveryStore) => {
								const value = store.get(d.id)
								if (value !== undefined) delete value.revision
								return value
							}
							expect(published(restored)).toEqual(published(live))
							expect(published(replayed)).toEqual(published(live))
						}
					}
					const ingest = (id: string, centreHz: number) => {
						clock += 1003.7
						live.ingest(
							makeObs({
								id,
								centreHz,
								startedAt: clock,
								cls: "fsk4-12k5",
								hypotheses: [["dmr", 0.8]],
							}),
						)
					}
					// Guarantee a real two-member merge, capacity eviction, and a full retention window.
					counts.merges += live.applyConsolidation({
						groups: [{ survivor: "d_seed", members: ["d_seed", "d_partner"] }],
					}).absorbed
					assertRoundTrip()
					// Resume just below the bound, then ingest across it with checked/legacy rows retained.
					const beforeRetention = live.snapshot().observations.length
					for (let i = 0; i < 10; i++) {
						ingest("retention-" + i, F)
						assertRoundTrip()
					}
					const retained = live.snapshot().observations.length
					counts.trims += beforeRetention + 10 - retained
					expect(retained).toBe(256)
					live.setLimits({ maxDiscoveries: 1, minSurfaceBlocks: 2 })
					ingest("capacity", F + 100_000)
					assertRoundTrip()
					live.setLimits({ maxDiscoveries: 20, minSurfaceBlocks: 2 })
					for (const [step, op] of ops.entries()) {
						clock += 1003.7
						const snapshot = live.snapshot()
						const d =
							snapshot.discoveries[
								op.slot % Math.max(1, snapshot.discoveries.length)
							]
						const o =
							snapshot.observations[
								op.slot % Math.max(1, snapshot.observations.length)
							]
						const ev = evidence("dmr", clock, {
							contentVerified: op.checked,
							...(op.identity ? { identity: dmrCc(op.cc) } : {}),
							talkgroups: [String(op.slot)],
							encrypted: true,
						})
						switch (op.kind) {
							case 0:
							case 1:
								live.ingest(
									makeObs({
										id: "random-" + step,
										centreHz: F + op.slot * 3500,
										startedAt: clock,
										cls: "fsk4-12k5",
										hypotheses: [["dmr", 0.8]],
									}),
								)
								break
							case 2:
								if (d !== undefined) live.applyEvidence(d.id, ev)
								break
							case 3:
								if (o !== undefined) live.appendObservationEvidence(o.id, ev)
								break
							case 4:
								live.rekey("src-1", op.slot * 1000)
								break
							case 5:
								clock += 2 * 86_400_000
								live.pruneInactive(1)
								break
							case 6:
								live.setLimits({
									maxDiscoveries: 1 + op.slot,
									minSurfaceBlocks: 2,
								})
								break
							case 7:
								if (snapshot.discoveries.length >= 2) {
									const a =
										snapshot.discoveries[op.slot % snapshot.discoveries.length]!
									const b =
										snapshot.discoveries[
											(op.slot + 1) % snapshot.discoveries.length
										]!
									counts.merges += live.applyConsolidation({
										groups: [{ survivor: a.id, members: [a.id, b.id] }],
									}).absorbed
								}
								break
						}
						assertRoundTrip()
					}
				},
			),
			{ numRuns: 100, seed: 110027 },
		)
		expect(counts.legacyStarts).toBe(50)
		expect(counts.merges).toBeGreaterThanOrEqual(100)
		expect(counts.evictions).toBeGreaterThanOrEqual(100)
		expect(counts.trims).toBeGreaterThanOrEqual(500)
	},
)

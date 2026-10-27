import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import {
	ANCHOR_AIRCRAFT_WINDOW_MS,
	canAnchor,
} from "../../../../src/core/scanner/store/decode-anchor.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import { makeObs } from "../../../mocks/scanner/observations.js"
import { DiscoverySchema } from "../../../../src/core/scanner/store/schemas.js"
import type { DecodeEvidence } from "../../../../src/core/scanner/types.js"

const HZ = 1_090_000_000
const T0 = Date.UTC(2026, 9, 27)
const ev = (address: number, at = T0): DecodeEvidence => ({
	protocol: "adsb",
	origin: "ambient",
	crcClean: true,
	epoch: 1,
	at,
	identity: {
		kind: "icao",
		value: (0xf00000 + (address % 0x10000)).toString(16),
	},
	metadata: {},
})
const store = (now = () => T0) =>
	new DiscoveryStore({ maxDiscoveries: 10, now, newId: () => "anchor" })

describe("decode-anchored persistence and bounds", () => {
	it("publishes count expiry without a read and clears timers on stop and removal", () => {
		vi.useFakeTimers()
		vi.setSystemTime(T0)
		const s = store(() => Date.now())
		try {
			s.anchorDecode("rtl", HZ, ev(1), "commanded")
			expect(vi.getTimerCount()).toBe(1)
			const updates: number[] = []
			s.on("change", (id: string) => {
				const d = s.get(id)
				if (d) updates.push(d.aircraftCount!)
			})
			vi.advanceTimersByTime(60_000)
			expect(updates).toEqual([])
			vi.advanceTimersByTime(1)
			expect(updates).toEqual([0])
			expect(s.snapshot().discoveries[0]!.aircraftCount).toBe(0)
			expect(vi.getTimerCount()).toBe(0)
			s.anchorDecode("rtl", HZ, ev(2, Date.now()), "commanded")
			s.anchorDecode("rtl", HZ, ev(3, Date.now()), "commanded")
			expect(vi.getTimerCount()).toBe(1)
			s.stopAnchorExpiry()
			expect(vi.getTimerCount()).toBe(0)
			s.startAnchorExpiry()
			expect(vi.getTimerCount()).toBe(1)
			s.delete(s.snapshot().discoveries[0]!.id)
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			s.stopAnchorExpiry()
			vi.useRealTimers()
		}
	})

	it("keeps unavailable RF measurements as zero placeholders on anchors and observations", () => {
		const s = store()
		try {
			s.anchorDecode("rtl", HZ, ev(1), "commanded")
			const snapshot = s.snapshot()
			for (const key of ["bandwidthHz", "airtimeMs", "measuredOffsetHz"])
				expect(snapshot.discoveries[0]).toHaveProperty(key, 0)
			for (const key of [
				"snrDb",
				"peakDbfs",
				"meanDbfs",
				"floorDbfs",
				"obwHz",
				"thresholdDb",
				"dutyCycle",
			])
				expect(snapshot.observations[0]).toHaveProperty(key, 0)
		} finally {
			s.stopAnchorExpiry()
		}
	})

	it("preserves zero placeholders on restore and rebuilds aircraft count from fresh decodes", () => {
		vi.useFakeTimers()
		vi.setSystemTime(T0)
		const original = store(() => Date.now())
		const restored = store(() => Date.now())
		try {
			original.anchorDecode("rtl", HZ, ev(1), "commanded")
			const snapshot = original.snapshot()
			original.stopAnchorExpiry()
			const stats = { peakDbfs: 0, meanDbfs: 0, snrDb: 0, floorDbfs: 0 }
			Object.assign(snapshot.discoveries[0]!, {
				signal: { best: stats, last: stats },
				bandwidthHz: 0,
				airtimeMs: 0,
				measuredOffsetHz: 0,
			})
			Object.assign(snapshot.observations[0]!, {
				...stats,
				obwHz: 0,
				obwMethod: "on-bins",
				thresholdDb: 0,
				dutyCycle: 0,
			})
			restored.restore(snapshot)
			restored.startAnchorExpiry()
			expect(vi.getTimerCount()).toBe(0)
			expect(restored.get("d_anchor")?.aircraftCount).toBe(0)
			expect(restored.get("d_anchor")).toHaveProperty("signal.best.snrDb", 0)
			expect(restored.snapshot().observations[0]).toHaveProperty("snrDb", 0)
			vi.advanceTimersByTime(60_001)
			expect(restored.snapshot().discoveries[0]!.aircraftCount).toBe(0)
		} finally {
			original.stopAnchorExpiry()
			restored.stopAnchorExpiry()
			vi.useRealTimers()
		}
	})

	it.each([4095, 4096, 4097])(
		"bounds the production memory window at %s aircraft",
		n => {
			const s = store()
			try {
				for (let i = 0; i < n; i++)
					s.anchorDecode("rtl", HZ, ev(i), "commanded")
				s.stopAnchorExpiry()
				expect(s.get("d_anchor")?.aircraftCount).toBe(Math.min(n, 4096))
				expect(s.snapshot().observations[0]?.decode).toEqual([])
				expect(s.get("d_anchor")?.identity).toBeUndefined()
			} finally {
				s.stopAnchorExpiry()
			}
		},
	)

	it("flushes the latest count at the rate boundary and on stop", () => {
		vi.useFakeTimers()
		vi.setSystemTime(T0)
		const s = store(() => Date.now())
		const counts: (number | undefined)[] = []
		s.on("mutation", (entry: Omit<JournalEntry, "seq">) => {
			const payload = entry.payload as {
				discoveries: { aircraftCount?: number }[]
			}
			counts.push(payload.discoveries[0]?.aircraftCount)
		})
		try {
			s.anchorDecode("rtl", HZ, ev(1), "commanded")
			s.anchorDecode("rtl", HZ + 1000, ev(2), "commanded")
			expect(s.snapshot().discoveries).toHaveLength(1)
			vi.advanceTimersByTime(4999)
			expect(counts).toEqual([1])
			vi.advanceTimersByTime(1)
			expect(counts).toEqual([1, 2])
			s.anchorDecode("rtl", HZ, ev(3, Date.now()), "commanded")
			s.stopAnchorExpiry()
			expect(counts).toEqual([1, 2, 3])
		} finally {
			s.stopAnchorExpiry()
			vi.useRealTimers()
		}
	})

	it("keeps reads at the creation revision until the pending count publishes at 5 s", () => {
		vi.useFakeTimers()
		vi.setSystemTime(T0)
		const s = store(() => Date.now())
		const events: ReturnType<DiscoveryStore["get"]>[] = []
		s.on("change", (id: string) => events.push(s.get(id)))
		try {
			s.anchorDecode("rtl", HZ, ev(1), "commanded")
			const created = s.get("d_anchor")
			const snapshot = s.snapshot()
			vi.advanceTimersByTime(1000)
			s.anchorDecode("rtl", HZ, ev(2, Date.now()), "relay")
			expect(s.get("d_anchor")).toEqual(created)
			expect(s.snapshot()).toEqual(snapshot)
			expect(s.snapshot().observations[0]?.endedAt).toBe(
				new Date(T0).toISOString(),
			)
			vi.advanceTimersByTime(3999)
			expect(s.get("d_anchor")).toEqual(events.at(-1))
			expect(events).toHaveLength(1)
			vi.advanceTimersByTime(1)
			expect(events).toHaveLength(2)
			expect(s.get("d_anchor")).toEqual(events.at(-1))
			expect(s.get("d_anchor")?.aircraftCount).toBe(2)
			expect(s.get("d_anchor")?.revision).toBeGreaterThan(
				created?.revision ?? 0,
			)
			// Same-count, same-bucket refreshes remain private even after a rate slot.
			vi.advanceTimersByTime(1000)
			s.anchorDecode("rtl", HZ, ev(2, Date.now()), "commanded")
			vi.advanceTimersByTime(5000)
			expect(events).toHaveLength(2)
			expect(s.get("d_anchor")).toEqual(events.at(-1))
			s.stopAnchorExpiry()
			expect(s.get("d_anchor")?.lastSeenAt).toBe(
				new Date(T0 + 6000).toISOString(),
			)
			expect(s.get("d_anchor")).toEqual(events.at(-1))
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			s.stopAnchorExpiry()
			vi.useRealTimers()
		}
	})

	it("flushes pending state before removal and discards it on crash restore", () => {
		vi.useFakeTimers()
		vi.setSystemTime(T0)
		const s = store(() => Date.now())
		const restored = store(() => Date.now())
		const events: ReturnType<DiscoveryStore["get"]>[] = []
		s.on("change", (id: string) => events.push(s.get(id)))
		try {
			s.anchorDecode("rtl", HZ, ev(1), "commanded")
			vi.advanceTimersByTime(1000)
			s.anchorDecode("rtl", HZ, ev(2, Date.now()), "commanded")
			restored.restore(s.snapshot())
			expect(restored.get("d_anchor")).toMatchObject({
				aircraftCount: 0,
				observationCount: 1,
				lastSeenAt: new Date(T0).toISOString(),
			})
			s.delete("d_anchor")
			expect(events.at(-2)).toMatchObject({
				aircraftCount: 2,
				observationCount: 2,
				lastSeenAt: new Date(T0 + 1000).toISOString(),
			})
			expect(events.at(-1)).toBeUndefined()
			expect(vi.getTimerCount()).toBe(0)
			vi.advanceTimersByTime(65_000)
			expect(events).toHaveLength(3)
		} finally {
			s.stopAnchorExpiry()
			restored.stopAnchorExpiry()
			vi.useRealTimers()
		}
	})

	// Feature: band-inspection-ux, Property: decode anchor reads match the published revision
	// Validates: Requirements 3.3
	it("keeps every read identical to the last change event over random confirmation schedules", () => {
		vi.useFakeTimers()
		try {
			fc.assert(
				fc.property(
					fc.array(
						fc.record({
							delay: fc.integer({ min: 0, max: 65_000 }),
							address: fc.integer({ min: 1, max: 20 }),
						}),
						{ minLength: 1, maxLength: 40 },
					),
					steps => {
						vi.setSystemTime(T0)
						const s = store(() => Date.now())
						let last: ReturnType<DiscoveryStore["get"]>
						s.on("change", (id: string) => {
							last = s.get(id)
						})
						try {
							for (const step of steps) {
								vi.advanceTimersByTime(step.delay)
								expect(s.get("d_anchor")).toEqual(last)
								s.anchorDecode(
									"rtl",
									HZ,
									ev(step.address, Date.now()),
									"commanded",
								)
								expect(s.get("d_anchor")).toEqual(last)
							}
							s.stopAnchorExpiry()
							expect(s.get("d_anchor")).toEqual(last)
						} finally {
							s.stopAnchorExpiry()
						}
					},
				),
				{ numRuns: 100 },
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it.each([59_999, 60_000, 60_001])(
		"counts confirmations at the inclusive 60 s window boundary: %s",
		age => {
			vi.useFakeTimers()
			vi.setSystemTime(T0)
			const s = store(() => Date.now())
			try {
				s.anchorDecode("rtl", HZ, ev(1), "commanded")
				vi.advanceTimersByTime(age)
				expect(s.get("d_anchor")?.aircraftCount).toBe(
					age <= ANCHOR_AIRCRAFT_WINDOW_MS ? 1 : 0,
				)
			} finally {
				s.stopAnchorExpiry()
				vi.useRealTimers()
			}
		},
	)

	// Feature: decode-anchored, Property 1: one latest confirmation per ICAO
	// Validates: Requirements R3, R5
	it("refreshes rather than duplicates any confirmed ICAO", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 0xffff }), address => {
				const s = store()
				try {
					s.anchorDecode("rtl", HZ, ev(address), "commanded")
					s.anchorDecode("rtl", HZ, ev(address), "commanded")
					expect(s.get("d_anchor")?.aircraftCount).toBe(1)
				} finally {
					s.stopAnchorExpiry()
				}
			}),
			{ numRuns: 100 },
		)
	})

	it.each([999, 1000, 1001])(
		"uses readsb's inclusive frequency tolerance: %s",
		offset => {
			expect(canAnchor(ev(1), HZ + offset, "commanded")).toBe(offset <= 1000)
			expect(canAnchor(ev(1), HZ - offset, "commanded")).toBe(offset <= 1000)
		},
	)

	it("fails closed on ineligible protocols, malformed identities and untrusted tuning", () => {
		expect(canAnchor(ev(1), HZ, "unverified")).toBe(false)
		expect(canAnchor({ ...ev(1), protocol: "ais" }, HZ, "commanded")).toBe(
			false,
		)
		expect(
			canAnchor(
				{ ...ev(1), identity: { kind: "icao", value: "invalid" } },
				HZ,
				"commanded",
			),
		).toBe(false)
	})

	it("validates the additive persisted count bounds", () => {
		const s = store()
		s.anchorDecode("rtl", HZ, ev(1), "commanded")
		const d = s.snapshot().discoveries[0]!
		for (const n of [0, 4096])
			expect(
				DiscoverySchema.safeParse({ ...d, aircraftCount: n }).success,
			).toBe(true)
		for (const n of [-1, 4097])
			expect(
				DiscoverySchema.safeParse({ ...d, aircraftCount: n }).success,
			).toBe(false)
	})

	it("keeps source tuples separate and never absorbs a later carrier or frequency correction", () => {
		let n = 0
		const s = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => T0,
			newId: () => String(++n),
		})
		const a = s.anchorDecode("rtl", HZ, ev(1), "commanded").discoveryId!
		const b = s.anchorDecode("other", HZ, ev(1), "relay").discoveryId!
		expect(a).not.toBe(b)
		const carrier = s.ingest(
			makeObs({
				id: "carrier",
				sourceId: "rtl",
				centreHz: HZ + 10_000,
				obwHz: 2_000,
				startedAt: T0,
			}),
		).discoveryId
		expect(carrier).not.toBeNull()
		expect(carrier).not.toBe(a)
		expect(s.get(carrier!)?.protocol).toBe("unknown")
		expect(s.rekey("rtl", 20_000).merged).toEqual([])
		expect(s.get(a)).toMatchObject({
			frequencyHz: HZ,
			anchor: "decode",
			confidence: "decoded",
			aircraftCount: 1,
		})
		expect(s.consolidationPlan().groups).toEqual([])
	})

	it("writes and reloads both the snapshot and subsequent journal deep-equal", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wk-decode-anchor-"))
		const logger = pino({ level: "silent" })
		const p = new ScannerPersistence({
			dir,
			logger,
			now: () => T0,
			snapshotWorker: { enabled: false },
		})
		try {
			await p.load()
			const s = store()
			s.anchorDecode("rtl", HZ, ev(1), "commanded")
			await p.writeSnapshot(s.snapshot())
			const entries: Omit<JournalEntry, "seq">[] = []
			s.on("mutation", (entry: Omit<JournalEntry, "seq">) =>
				entries.push(entry),
			)
			s.anchorDecode("rtl", HZ, ev(2), "relay")
			s.stopAnchorExpiry()
			for (const entry of entries) await p.append(entry)
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			const replica = store()
			replica.restore(loaded)
			for (const entry of loaded.entries) replica.replay(entry)
			expect(replica.snapshot()).toEqual({
				...s.snapshot(),
				discoveries: s
					.snapshot()
					.discoveries.map(d => ({ ...d, aircraftCount: 0 })),
			})
			expect(replica.get("d_anchor")?.proof).toEqual(s.get("d_anchor")?.proof)
			replica.anchorDecode("rtl", HZ, ev(3), "commanded")
			expect(replica.snapshot().discoveries).toHaveLength(1)
			expect(replica.get("d_anchor")).toMatchObject({
				aircraftCount: 1,
				proof: { kind: "decoded" },
			})
		} finally {
			await p.closeSnapshotWorker()
			await rm(dir, { recursive: true, force: true })
		}
	})
})

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import {
	anchorDecodes,
	aircraftCount,
	ANCHOR_AIRCRAFT_MAX,
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
	identity: { kind: "icao", value: address.toString(16).padStart(6, "0") },
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

	it("preserves legacy zero placeholders on restore and resumes aircraft expiry", () => {
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
			expect(vi.getTimerCount()).toBe(1)
			expect(restored.snapshot()).toEqual(snapshot)
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

	it.each([
		ANCHOR_AIRCRAFT_MAX - 1,
		ANCHOR_AIRCRAFT_MAX,
		ANCHOR_AIRCRAFT_MAX + 1,
	])("retains at most 4096 latest distinct addresses: %s", n => {
		const rows = Array.from({ length: n }, (_, i) => ev(i, T0 + i))
		const next = anchorDecodes(rows.slice(0, -1), rows.at(-1)!)
		expect(next).toHaveLength(Math.min(n, ANCHOR_AIRCRAFT_MAX))
		expect(next.at(-1)).toEqual(rows.at(-1))
	})

	it.each([59_999, 60_000, 60_001])(
		"counts confirmations at the inclusive 60 s window boundary: %s",
		age => {
			expect(aircraftCount([ev(1)], T0 + age)).toBe(
				age <= ANCHOR_AIRCRAFT_WINDOW_MS ? 1 : 0,
			)
			expect(anchorDecodes([ev(1)], ev(2, T0 + age))).toHaveLength(
				age <= ANCHOR_AIRCRAFT_WINDOW_MS ? 2 : 1,
			)
		},
	)

	// Feature: decode-anchored, Property 1: one latest confirmation per ICAO
	// Validates: Requirements R3, R5
	it("refreshes rather than duplicates any confirmed ICAO", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 0xffffff }), address => {
				const first = ev(address)
				const second = ev(address, T0 + 1)
				expect(anchorDecodes([first], second)).toEqual([second])
			}),
			{ numRuns: 100 },
		)
	})

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
			for (const entry of entries) await p.append(entry)
			const loaded = await new ScannerPersistence({
				dir,
				logger,
				now: () => T0,
			}).load()
			const replica = store()
			replica.restore(loaded)
			for (const entry of loaded.entries) replica.replay(entry)
			expect(replica.snapshot()).toEqual(s.snapshot())
			expect(replica.get("d_anchor")?.proof).toEqual(s.get("d_anchor")?.proof)
			replica.anchorDecode("rtl", HZ, ev(3), "commanded")
			expect(replica.snapshot().discoveries).toHaveLength(1)
			expect(replica.get("d_anchor")).toMatchObject({
				aircraftCount: 3,
				proof: { kind: "decoded" },
			})
		} finally {
			await p.closeSnapshotWorker()
			await rm(dir, { recursive: true, force: true })
		}
	})
})

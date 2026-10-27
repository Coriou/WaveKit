import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
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

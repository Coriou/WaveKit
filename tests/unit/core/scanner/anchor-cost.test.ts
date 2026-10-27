import { it, expect } from "vitest"
import {
	DiscoveryStore,
	type JournalEntry,
} from "../../../../src/core/scanner/store/discovery-store.js"

it("bounds anchor journal cost independently of aircraft count", () => {
	for (const aircraft of [50, 200, 500]) {
		let now = 1_800_000_000_000
		const s = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => now,
			newId: () => "synthetic",
		})
		let lines = 0
		let bytes = 0
		s.on("mutation", (entry: Omit<JournalEntry, "seq">) => {
			lines++
			bytes += Buffer.byteLength(JSON.stringify(entry)) + 1
		})
		for (let tick = 0; tick < 30; tick++) {
			now = 1_800_000_000_000 + tick * 2000
			for (let i = 0; i < aircraft; i++)
				s.anchorDecode(
					"synthetic",
					1_090_000_000,
					{
						protocol: "adsb",
						origin: "ambient",
						crcClean: true,
						epoch: 1,
						at: now,
						identity: { kind: "icao", value: (0xf00000 + i).toString(16) },
						metadata: {},
					},
					"commanded",
				)
		}
		s.stopAnchorExpiry()
		// Creation + floor(60/5) rate slots + final stop flush <= 14, each <= 4096 bytes.
		expect(lines).toBeLessThanOrEqual(14)
		expect(bytes).toBeLessThanOrEqual(14 * 4096)
	}
})

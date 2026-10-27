import { describe, expect, it } from "vitest"
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

function snapshot(legacyFirst = true) {
	const s = legacySnapshot(
		["d_legacy", "d_checked"].map((id, i) => ({
			id,
			centreHz: F,
			family: "digital-voice" as const,
			protocol: "dmr" as const,
			identity: dmrCc(3),
			firstSeenMs: T0 + (legacyFirst ? i : 1 - i) * 13,
		})),
	)
	for (const d of s.discoveries) {
		if (d.id === "d_checked") d.contentVerified = true
		else {
			d.metadata.talkgroups = ["FAKE"]
			d.metadata.sources = ["FAKE"]
			d.encrypted = true
		}
	}
	for (const o of s.observations)
		if (o.discoveryId === "d_legacy")
			for (const ev of o.decode ?? []) {
				delete ev.contentVerified
				ev.metadata = { talkgroups: ["FAKE"], sources: ["FAKE"] }
				ev.encrypted = true
			}
	return s
}

function store() {
	return new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0 + 31_003.7,
		newId: counterIds(),
	})
}

describe("checked discovery content", () => {
	it.each([true, false])(
		"does not promote unchecked metadata when settling (legacy survivor: %s)",
		legacyFirst => {
			const initial = snapshot(legacyFirst)
			const live = store()
			live.restore(initial)
			const entries: JournalEntry[] = []
			live.on("mutation", (e: Omit<JournalEntry, "seq">) =>
				entries.push({ ...e, seq: entries.length + 1 }),
			)
			live.applyEvidence(
				"d_legacy",
				evidence("dmr", T0 + 317.3, {
					identity: dmrCc(3),
					contentVerified: false,
					talkgroups: ["FAKE"],
					encrypted: true,
				}),
			)
			// Updating the unchecked observation changes airtime and triggers settlement.
			live.ingest(
				makeObs({
					id: "d_legacy-o0",
					centreHz: F,
					startedAt: T0 + (legacyFirst ? 0 : 13),
					durationMs: 1317,
				}),
			)
			const items = live.list({}).items
			expect(items).toHaveLength(1)
			expect(items[0]?.identity).toEqual(dmrCc(3))
			expect(items[0]?.metadata.talkgroups).toEqual([])
			expect(items[0]?.metadata.sources).toEqual([])
			expect(items[0]?.encrypted).toBe(false)
			const restored = store()
			restored.restore(live.snapshot())
			const replayed = store()
			replayed.restore(initial)
			for (const entry of entries) replayed.replay(entry)
			expect(restored.snapshot()).toEqual(live.snapshot())
			expect(replayed.snapshot()).toEqual(live.snapshot())
		},
	)

	it("filters identity, search and encryption by the published values", () => {
		const s = snapshot()
		const checked = s.discoveries.find(d => d.id === "d_checked")
		if (checked !== undefined) checked.encrypted = true
		const live = store()
		live.restore(s)
		const ids = (items: { id: string }[]) => items.map(d => d.id).sort()
		expect(ids(live.list({ identity: dmrCc(3) }).items)).toEqual(["d_checked"])
		expect(ids(live.list({ q: "3" }).items)).toEqual(["d_checked"])
		expect(ids(live.list({ encrypted: true }).items)).toEqual(["d_checked"])
		expect(ids(live.list({ encrypted: false }).items)).toEqual(["d_legacy"])
		expect(live.get("d_legacy")?.identity).toBeUndefined()
		expect(
			live.snapshot().discoveries.find(d => d.id === "d_legacy")?.identity,
		).toEqual(dmrCc(3))
	})
})

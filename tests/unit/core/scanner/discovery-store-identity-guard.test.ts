import { describe, expect, it } from "vitest"
import {
	MAX_IDENTITY_VALUE_LENGTH,
	identityFitsProtocol,
} from "../../../../src/core/scanner/classify/label-from-evidence.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import type { DecodeEvidence } from "../../../../src/core/scanner/types.js"
import {
	counterIds,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

function newStore(): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
	})
}

function ingestPassed(store: DiscoveryStore): string {
	const res = store.ingest(
		makeObs({
			id: "o1",
			centreHz: CH,
			startedAt: T0,
			blocks: 1,
			gate: "passed",
		}),
	)
	expect(res.change).toBe("created")
	return res.discoveryId ?? ""
}

function watch(store: DiscoveryStore): Omit<JournalEntry, "seq">[] {
	const journal: Omit<JournalEntry, "seq">[] = []
	store.on("mutation", (entry: Omit<JournalEntry, "seq">) => {
		journal.push(entry)
	})
	return journal
}

describe("DiscoveryStore identity guard", () => {
	it("ignores a DMR decode whose identity does not fit, then a fitting decode confirms the same discovery", () => {
		const store = newStore()
		const id = ingestPassed(store)
		const before = store.snapshot()
		const journal = watch(store)
		const rejected: DecodeEvidence[] = [
			evidence("dmr", T0 + 10, {
				identity: { kind: "dmr-cc", value: "" },
				talkgroups: ["9"],
				encrypted: true,
			}),
			evidence("dmr", T0 + 11, {
				identity: {
					kind: "dmr-cc",
					value: "x".repeat(MAX_IDENTITY_VALUE_LENGTH + 1),
				},
				talkgroups: ["9"],
				encrypted: true,
			}),
			evidence("dmr", T0 + 12, {
				identity: { kind: "p25-nac", value: "1" },
				talkgroups: ["9"],
				encrypted: true,
			}),
		]
		for (const ev of rejected) {
			expect(store.applyEvidence(id, ev, { cap: "adjacent-leak" })).toBeNull()
			expect(store.snapshot()).toEqual(before)
		}
		expect(journal).toEqual([])
		expect(store.snapshot().discoveries).toHaveLength(1)
		expect(
			store.applyEvidence(
				id,
				evidence("dmr", T0 + 20, { identity: { kind: "dmr-cc", value: "1" } }),
			),
		).toBe("upgraded")
		expect(store.snapshot().discoveries).toHaveLength(1)
		const d = store.get(id)
		expect(d?.protocol).toBe("dmr")
		expect(d?.confidence).toBe("decoded")
		expect(d?.identity).toEqual({ kind: "dmr-cc", value: "1" })
		expect(d?.observationCount).toBe(1)
		expect(d?.metadata.talkgroups).toEqual([])
		expect(d?.encrypted).toBe(false)
	})

	it("ignores a carrier decode that carries a dmr colour code", () => {
		const store = newStore()
		const id = ingestPassed(store)
		const before = store.snapshot()
		const journal = watch(store)
		expect(
			store.applyEvidence(
				id,
				evidence("carrier", T0 + 10, {
					identity: { kind: "dmr-cc", value: "1" },
					talkgroups: ["9"],
					encrypted: true,
				}),
				{ cap: "adjacent-leak" },
			),
		).toBeNull()
		expect(store.snapshot()).toEqual(before)
		expect(journal).toEqual([])
		expect(store.snapshot().discoveries).toHaveLength(1)
		expect(store.get(id)?.protocol).toBe("unknown")
		expect(store.get(id)?.identity).toBeUndefined()
		expect(store.get(id)?.observationCount).toBe(1)
	})

	it("still applies a decode that carries no identity", () => {
		const store = newStore()
		const id = ingestPassed(store)
		expect(
			store.applyEvidence(id, evidence("dmr", T0 + 10, { talkgroups: ["9"] })),
		).toBe("updated")
		const d = store.get(id)
		expect(d?.protocol).toBe("dmr")
		expect(d?.confidence).toBe("activity")
		expect(d?.identity).toBeUndefined()
		expect(d?.metadata.talkgroups).toEqual(["9"])
		expect(store.snapshot().discoveries).toHaveLength(1)
		expect(d?.observationCount).toBe(1)
	})
})

describe("identityFitsProtocol on hostile input", () => {
	it("returns false when a getter throws", () => {
		const identity = {
			get kind(): string {
				throw new Error("boom")
			},
			value: "1",
		}
		expect(identityFitsProtocol("dmr", identity)).toBe(false)
	})
})

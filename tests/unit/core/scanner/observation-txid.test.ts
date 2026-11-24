/**
 * An observation's transmission id: carried from the ingest into the stored record and its
 * journal payload, kept through the journal schema, absent on records written before it.
 */
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	ObservationSchema,
	type StoreMutation,
} from "../../../../src/core/scanner/store/schemas.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const HZ = 100_000_000
const TX = `tx_01JTESTTX${"A".repeat(17)}`

function setup() {
	const store = new DiscoveryStore({
		maxDiscoveries: 10,
		now: () => 5_000_000,
		newId: counterIds(),
	})
	const entries: Omit<JournalEntry, "seq">[] = []
	store.on("mutation", (e: Omit<JournalEntry, "seq">) => entries.push(e))
	return { store, entries }
}

const fm = (id: string, extra: { txId?: string } = {}) => ({
	...makeObs({
		id,
		centreHz: HZ,
		startedAt: 1_000,
		cls: "analog-fm",
		hypotheses: [["analog-fm", 0.9]],
	}),
	...extra,
})

describe("observation txId", () => {
	it("the stored record and its journal payload carry the claimed txId and the schema keeps it", () => {
		const { store, entries } = setup()
		const id = store.ingest(fm("o1", { txId: TX })).discoveryId ?? ""
		const stored = store.observations(id, null, 10).items[0]
		expect(stored?.txId).toBe(TX)
		const journaled = entries
			.flatMap(e => (e.payload as StoreMutation).observations)
			.find(o => o.id === "o1")
		expect(journaled?.txId).toBe(TX)
		const replayed = ObservationSchema.parse(
			JSON.parse(JSON.stringify(journaled)),
		)
		expect(replayed.txId).toBe(TX)
	})

	it("an observation without one (an older record, or no registry) has no txId and still loads", () => {
		const { store, entries } = setup()
		const id = store.ingest(fm("o1")).discoveryId ?? ""
		expect(store.observations(id, null, 10).items[0]).not.toHaveProperty("txId")
		const journaled = entries
			.flatMap(e => (e.payload as StoreMutation).observations)
			.find(o => o.id === "o1")
		const parsed = ObservationSchema.parse(
			JSON.parse(JSON.stringify(journaled)),
		)
		expect(parsed).not.toHaveProperty("txId")
	})

	it("a malformed txId fails the journal schema", () => {
		const { store, entries } = setup()
		store.ingest(fm("o1"))
		const journaled = entries
			.flatMap(e => (e.payload as StoreMutation).observations)
			.find(o => o.id === "o1")
		expect(
			ObservationSchema.safeParse({ ...journaled, txId: "tx_lower" }).success,
		).toBe(false)
	})
})

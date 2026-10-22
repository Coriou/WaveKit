/**
 * Published identity and capacity eviction follow the proof-implied label get()
 * shows. Snapshot rows keep the stored protocol and confidence.
 */
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

function storeOf(max: number): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: max,
		now: () => T0,
		newId: counterIds(),
	})
}

function tone(at = T0): ProofAnalogInput {
	return {
		outcome: "decoded",
		mode: "nfm",
		voice: true,
		tone: { ctcssHz: 88.5, dcs: null },
		transport: "live",
		at,
	}
}

function heard(at = T0): ProofAnalogInput {
	return {
		outcome: "heard",
		mode: "nfm",
		voice: true,
		tone: { ctcssHz: null, dcs: null },
		transport: "live",
		at,
	}
}

function ingest(
	store: DiscoveryStore,
	id: string,
	centreHz: number,
	startedAt: number,
): string {
	return (
		store.ingest(
			makeObs({
				id,
				centreHz,
				startedAt,
				gate: "passed",
				jobIds: ["job-1"],
			}),
		).discoveryId ?? ""
	)
}

describe("proof-implied identity and eviction", () => {
	it("identityOf follows a commanded NFM CTCSS 88.5 tone", () => {
		const store = storeOf(4)
		const id = ingest(store, "o1", CH, T0)
		expect(store.recordAnalog("o1", tone())).toBe(true)
		const shown = store.get(id)
		expect(shown?.protocol).toBe("analog-fm")
		expect(shown?.family).toBe("analog")
		expect(shown?.confidence).toBe("classified")
		expect(shown?.proof?.kind).toBe("analog-tone")
		expect(store.identityOf(id)).toEqual({
			id,
			protocol: "analog-fm",
			confidence: "classified",
		})
		const stored = store.snapshot().discoveries.find(d => d.id === id)
		expect(stored?.protocol).toBe("unknown")
		expect(stored?.family).toBe("unknown")
		expect(stored?.confidence).toBe("activity")
		expect(stored?.identity).toBeUndefined()
		expect(stored?.proof).toBeUndefined()
	})

	it("evicts a newer activity discovery before an older classified tone", () => {
		const store = storeOf(2)
		const older = ingest(store, "o1", CH, T0)
		expect(store.recordAnalog("o1", tone())).toBe(true)
		const newer = ingest(store, "o2", CH + 100_000, T0 + 5_000)
		expect(store.get(older)?.confidence).toBe("classified")
		expect(store.get(newer)?.confidence).toBe("activity")
		expect(store.identityOf(older)?.confidence).toBe("classified")
		expect(
			store.list({ sort: "confidence", limit: 10 }).items.map(d => d.id),
		).toEqual([older, newer])
		const third = store.ingest(
			makeObs({
				id: "o3",
				centreHz: CH + 200_000,
				startedAt: T0 + 10_000,
				gate: "passed",
				jobIds: ["job-1"],
			}),
		)
		expect(third.change).toBe("created")
		expect(store.get(older)?.protocol).toBe("analog-fm")
		expect(store.get(older)?.confidence).toBe("classified")
		expect(store.identityOf(older)?.confidence).toBe("classified")
		expect(store.get(newer)).toBeUndefined()
		expect(store.get(third.discoveryId ?? "")?.confidence).toBe("activity")
		expect(store.snapshot().discoveries).toHaveLength(2)
		const stored = store.snapshot().discoveries.find(d => d.id === older)
		expect(stored?.protocol).toBe("unknown")
		expect(stored?.confidence).toBe("activity")
	})

	it("keeps a stored decoded discovery when a sink proof shows a weaker label", () => {
		const store = storeOf(1)
		const id = ingest(store, "o1", CH, T0)
		expect(
			store.applyEvidence(id, evidence("dmr", T0 + 1, { identity: dmrCc(1) })),
		).toBe("upgraded")
		expect(store.recordAnalog("o1", heard(T0 + 2))).toBe(true)
		expect(store.get(id)?.protocol).toBe("analog-fm")
		expect(store.get(id)?.confidence).toBe("candidate")
		expect(store.identityOf(id)).toEqual({
			id,
			protocol: "analog-fm",
			confidence: "candidate",
		})
		expect(store.snapshot().discoveries[0]?.confidence).toBe("decoded")
		expect(store.snapshot().discoveries[0]?.protocol).toBe("dmr")
		const next = store.ingest(
			makeObs({
				id: "o2",
				centreHz: CH + 100_000,
				startedAt: T0 + 5_000,
				gate: "passed",
				jobIds: ["job-1"],
			}),
		)
		expect(next.change).toBe("transient")
		expect(store.get(id)?.confidence).toBe("candidate")
		expect(store.snapshot().discoveries.map(d => d.id)).toEqual([id])
	})
})

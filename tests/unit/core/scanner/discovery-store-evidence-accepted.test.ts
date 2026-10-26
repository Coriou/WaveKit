import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

// applyEvidenceResult tells an accepted decode that changed nothing (a valid repeat) apart from
// a rejected one; applyEvidence keeps returning only the change.

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

function setup(): { store: DiscoveryStore; id: string } {
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
	})
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
	return { store, id: res.discoveryId ?? "" }
}

describe("DiscoveryStore.applyEvidenceResult", () => {
	it("a first decode is accepted with its change; a valid repeat is accepted with none", () => {
		const { store, id } = setup()
		const first = store.applyEvidenceResult(
			id,
			evidence("dmr", T0 + 1, { identity: dmrCc(1) }),
		)
		expect(first.accepted).toBe(true)
		expect(first.change).not.toBeNull()
		const repeat = store.applyEvidenceResult(
			id,
			evidence("dmr", T0 + 1, { identity: dmrCc(1) }),
		)
		expect(repeat).toEqual({ change: null, accepted: true })
		// applyEvidence still reports only the change.
		expect(
			store.applyEvidence(id, evidence("dmr", T0 + 1, { identity: dmrCc(1) })),
		).toBeNull()
	})

	it("rejected evidence is not accepted: CRC failure, unfit identity, other protocol, unknown record", () => {
		const { store, id } = setup()
		store.applyEvidence(id, evidence("dmr", T0 + 1, { identity: dmrCc(1) }))
		const rejected = [
			store.applyEvidenceResult(
				id,
				evidence("dmr", T0 + 2, { identity: dmrCc(1), crcClean: false }),
			),
			store.applyEvidenceResult(
				id,
				evidence("dmr", T0 + 3, {
					identity: { kind: "p25-nac", value: "1" },
				}),
			),
			// decoded as DMR: an identity-less decode of another protocol does not apply
			store.applyEvidenceResult(id, evidence("pocsag", T0 + 4)),
			store.applyEvidenceResult(
				"no-such-record",
				evidence("dmr", T0 + 5, { identity: dmrCc(1) }),
			),
		]
		for (const r of rejected)
			expect(r).toEqual({ change: null, accepted: false })
		// a rejection does not leak into the next call's answer
		expect(
			store.applyEvidenceResult(
				id,
				evidence("dmr", T0 + 6, { identity: dmrCc(1) }),
			).accepted,
		).toBe(true)
	})
})

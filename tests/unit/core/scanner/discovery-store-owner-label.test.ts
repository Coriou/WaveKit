/**
 * DiscoveryStore.ownerLabel: the published label (protocol, family, confidence) of a folder's
 * live owner, through merge aliases, without presenting (cloning) the discovery. It must match
 * what `get` presents for that owner, so the analog recorder's per-snapshot check
 * (voice-veto.ts ownerDecodedProtocol) sees exactly the label the API shows.
 */
import { describe, expect, it } from "vitest"
import { ownerDecodedProtocol } from "../../../../src/core/scanner/channel/voice-veto.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { createLogger } from "../../../../src/utils/logger.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const PMR = [{ spacingHz: 12_500, firstChannelHz: CH }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const quiet = createLogger({ level: "fatal" })

const dmrObs = (id: string, centreHz: number, startedAt: number) =>
	makeObs({
		id,
		centreHz,
		startedAt,
		cls: "fsk4-12k5",
		hypotheses: [["dmr", 0.8]],
	})

function newStore(): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
		rasters: () => PMR,
		logger: quiet,
	})
}

const labelOf = (
	d: { protocol: string; family: string; confidence: string } | undefined,
) =>
	d === undefined
		? undefined
		: { protocol: d.protocol, family: d.family, confidence: d.confidence }

describe("DiscoveryStore.ownerLabel", () => {
	it("an undecoded discovery: the label get presents (not decoded)", () => {
		const store = newStore()
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		expect(labelOf(store.ownerLabel(id))).toEqual(labelOf(store.get(id)))
		expect(store.ownerLabel(id)?.confidence).not.toBe("decoded")
		expect(ownerDecodedProtocol(store, id)).toBeNull()
	})

	it("a decoded discovery: its decoded protocol, as get presents it", () => {
		const store = newStore()
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		const decoded = evidence("dmr", T0 + 500, { identity: dmrCc(1) })
		expect(store.appendObservationEvidence("o1", decoded)).toBe(true)
		store.applyEvidence(id, decoded)
		expect(store.get(id)?.confidence).toBe("decoded")
		expect(labelOf(store.ownerLabel(id))).toEqual(labelOf(store.get(id)))
		expect(ownerDecodedProtocol(store, id)).toBe("dmr")
	})

	it("a merged discovery's folder resolves to the survivor's label", () => {
		const store = newStore()
		const survivor = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		const dropped =
			store.ingest(dmrObs("o2", CH + 3_500, T0 + 1_000)).discoveryId ?? ""
		expect(store.rekey("src-1", 3_000)).toEqual({
			merged: [[survivor, dropped]],
		})
		const decoded = evidence("dmr", T0 + 2_000, { identity: dmrCc(1) })
		expect(store.appendObservationEvidence("o1", decoded)).toBe(true)
		store.applyEvidence(survivor, decoded)
		expect(store.get(dropped)).toBeUndefined()
		expect(labelOf(store.ownerLabel(dropped))).toEqual(
			labelOf(store.get(survivor)),
		)
		expect(ownerDecodedProtocol(store, dropped)).toBe("dmr")
	})

	it("a folder nobody owns: undefined", () => {
		const store = newStore()
		expect(store.ownerLabel("d_nobody")).toBeUndefined()
		expect(ownerDecodedProtocol(store, "d_nobody")).toBeNull()
	})
})

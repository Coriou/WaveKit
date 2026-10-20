/**
 * A persisted decode's transport survives snapshot restore. Ambient origin
 * wins. A legacy row with no transport is live.
 */
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { DecodeEvidenceSchema } from "../../../../src/core/scanner/store/schemas.js"
import type { DecodeEvidence } from "../../../../src/core/scanner/types.js"
import type { Raster } from "../../../../src/core/spectrum/types.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const PMR: Raster[] = [{ spacingHz: 12_500, firstChannelHz: CH }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

function newStore(): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
		rasters: () => PMR,
	})
}

function planted(): { store: DiscoveryStore; id: string } {
	const store = newStore()
	const ingested = store.ingest(
		makeObs({ id: "o1", centreHz: CH, startedAt: T0 }),
	)
	return { store, id: ingested.discoveryId ?? "" }
}

function restoredTransport(
	ev: DecodeEvidence,
): "live" | "replay" | "ambient" | undefined {
	const { store, id } = planted()
	expect(store.appendObservationEvidence("o1", ev)).toBe(true)
	expect(store.applyEvidence(id, ev)).toBe("upgraded")
	const again = newStore()
	again.restore(store.snapshot())
	return again.get(id)?.proof?.transport
}

describe("decode transport through snapshot restore", () => {
	it("parses a legacy decode with no transport", () => {
		const parsed = DecodeEvidenceSchema.parse({
			protocol: "dmr",
			metadata: {},
			crcClean: true,
			at: T0,
			epoch: 1,
			origin: "probe",
		})
		expect(parsed.transport).toBeUndefined()
	})

	it("keeps an absent transport as live", () => {
		expect(
			restoredTransport(evidence("dmr", T0 + 10, { identity: dmrCc(1) })),
		).toBe("live")
	})

	it("keeps transport replay", () => {
		expect(
			restoredTransport({
				...evidence("dmr", T0 + 10, { identity: dmrCc(1) }),
				transport: "replay",
			}),
		).toBe("replay")
	})

	it("keeps ambient origin ahead of a replay transport", () => {
		expect(
			restoredTransport({
				...evidence("ais", T0 + 10, {
					identity: { kind: "ais-mmsi", value: "211234567" },
				}),
				origin: "ambient",
				transport: "replay",
			}),
		).toBe("ambient")
	})
})

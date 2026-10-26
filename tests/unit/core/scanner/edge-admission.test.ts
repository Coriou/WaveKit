import { describe, expect, it } from "vitest"
import {
	DQ_CREATE_SNR_DB,
	DQ_CREATE_TRACK_SNR_DB,
	DQ_SHORT_BURST_BLOCKS,
} from "../../../../src/core/scanner/detection-quality-contract.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { ObservationInput } from "../../../../src/core/scanner/types.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

// An edge track (past the 0.8 usable span) creates on the threshold only when its own track SNR
// also clears the noise maximum, however long it lasts; it is created flagged and unclassified.

const CH = 434_000_000
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0)

function obs(
	edge: boolean,
	channelSnr: number,
	trackSnr: number,
	blocks: number,
): ObservationInput {
	const o = makeObs({
		id: "e1",
		centreHz: CH,
		startedAt: T0,
		snrDb: trackSnr,
		blocks,
		gate: "passed",
		obwHz: 12_000,
		cls: "fsk2-wide",
	})
	o.track.channelSnrDb = channelSnr
	o.track.flags.edge = edge
	return o
}

function created(o: ObservationInput): DiscoveryStore {
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
	})
	store.ingest(o)
	return store
}

const count = (s: DiscoveryStore) => s.snapshot().discoveries.length

describe("edge tracks need the stronger threshold evidence", () => {
	it("a long track at the 18 dB threshold with an 8 dB track SNR creates mid-span, not at the edge", () => {
		const long = DQ_SHORT_BURST_BLOCKS * 3
		expect(count(created(obs(false, DQ_CREATE_SNR_DB, 8, long)))).toBe(1)
		expect(count(created(obs(true, DQ_CREATE_SNR_DB, 8, long)))).toBe(0)
	})

	it("boundary: an edge track creates at a 15 dB track SNR, not 14.99 dB, short or long", () => {
		for (const blocks of [DQ_SHORT_BURST_BLOCKS - 1, DQ_SHORT_BURST_BLOCKS]) {
			expect(
				count(
					created(obs(true, DQ_CREATE_SNR_DB, DQ_CREATE_TRACK_SNR_DB, blocks)),
				),
			).toBe(1)
			expect(
				count(
					created(
						obs(true, DQ_CREATE_SNR_DB, DQ_CREATE_TRACK_SNR_DB - 0.01, blocks),
					),
				),
			).toBe(0)
		}
	})

	it("boundary: an edge track under the 18 dB channel threshold does not create on its own", () => {
		expect(
			count(
				created(obs(true, DQ_CREATE_SNR_DB - 0.01, 30, DQ_SHORT_BURST_BLOCKS)),
			),
		).toBe(0)
	})

	it("the weak edge track of the field evidence (19.7 dB, short, weak own SNR) does not create", () => {
		expect(count(created(obs(true, 19.7, 9, 6)))).toBe(0)
	})

	it("a created edge discovery is unclassified and its observation keeps the edge flag", () => {
		const s = created(obs(true, 30, 25, DQ_SHORT_BURST_BLOCKS))
		const snap = s.snapshot()
		expect(snap.discoveries).toHaveLength(1)
		expect(snap.discoveries[0]!.class).toBe("unknown")
		expect(snap.observations.map(o => o.flags.edge)).toEqual([true])
	})
})

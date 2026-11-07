/**
 * A recording's discovery link through the real DiscoveryStore: a classed, voiced recording keeps
 * its placed observation over a late spur or IQ-image flag (ingest `artefactWaived`), and a
 * recording whose discovery merged mid-recording is reattached to the survivor (recordingOwner).
 * Anything else is retracted or refused as before.
 */
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	recordingAlias,
	recordingArtifact,
} from "../../../../src/core/scanner/store/recording-operation.js"
import type { PreparedRecordingMetadata } from "../../../../src/core/scanner/store/recording-operation.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const PMR = [{ spacingHz: 12_500, firstChannelHz: CH }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

const newStore = () =>
	new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
		rasters: () => PMR,
	})

const voice = (
	id: string,
	centreHz = CH,
	flags: Record<string, boolean> = {},
) =>
	makeObs({
		id,
		centreHz,
		startedAt: T0,
		cls: "analog-fm",
		open: true,
		// A live track keeps its gate pass when a sticky flag is raised later.
		gate: "passed",
		...flags,
	})

describe("a late artefact flag on a recording's observation", () => {
	for (const flag of ["spur", "iqImage"] as const) {
		it(`waived ${flag}: the placed observation stays on its discovery`, () => {
			const store = newStore()
			const id = store.ingest(voice("o1")).discoveryId
			expect(id).not.toBeNull()
			const res = store.ingest(voice("o1", CH, { [flag]: true }), {
				artefactWaived: true,
			})
			expect(res.discoveryId).toBe(id)
			expect(store.discoveryIdOf("o1")).toBe(id)
			expect(store.recordingAssociation(id!, "o1")).not.toBeNull()
			// Not remembered as flagged: a later waived snapshot still keeps it.
			expect(
				store.ingest(voice("o1", CH, { [flag]: true }), {
					artefactWaived: true,
				}).discoveryId,
			).toBe(id)
		})

		it(`${flag} without the waiver: retracted as before`, () => {
			const store = newStore()
			const id = store.ingest(voice("o1")).discoveryId
			expect(store.ingest(voice("o1", CH, { [flag]: true })).discoveryId).toBe(
				null,
			)
			expect(store.recordingAssociation(id!, "o1")).toBeNull()
		})
	}

	it("a truncated track is retracted even with the waiver", () => {
		const store = newStore()
		const id = store.ingest(voice("o1")).discoveryId
		const res = store.ingest(voice("o1", CH, { spur: true, truncated: true }), {
			artefactWaived: true,
		})
		expect(res.discoveryId).toBeNull()
		expect(store.recordingAssociation(id!, "o1")).toBeNull()
	})

	it("an observation not placed yet is never admitted flagged", () => {
		const store = newStore()
		const res = store.ingest(voice("o1", CH, { spur: true }), {
			artefactWaived: true,
		})
		expect(res.discoveryId).toBeNull()
		expect(store.list({}).items).toHaveLength(0)
	})

	it("an observation flagged once before stays retracted", () => {
		const store = newStore()
		store.ingest(voice("o1"))
		expect(
			store.ingest(voice("o1", CH, { iqImage: true })).discoveryId,
		).toBeNull()
		expect(
			store.ingest(voice("o1", CH, { iqImage: true }), {
				artefactWaived: true,
			}).discoveryId,
		).toBeNull()
	})
})

function prepared(
	discoveryId: string,
	observationId: string,
): PreparedRecordingMetadata {
	const operationId = randomUUID()
	return {
		version: 1,
		operationId,
		producerRecordingId: operationId,
		discoveryId,
		observationId,
		alias: recordingAlias(discoveryId, operationId),
		artifact: recordingArtifact(discoveryId, operationId),
		desiredState: "linked",
		binding: {
			sourceId: "src-1",
			engineInstanceId: randomUUID(),
			stream: 1,
			epoch: 1,
			channelId: "opaque",
			channelGeneration: 1,
			inputFormat: "cf32",
			inputSampleRateHz: 48000,
			groupDelayInputSamples: null,
			targetHz: CH,
			captureCentreHz: null,
			tuningTrust: "commanded",
		},
		expectedOutput: {
			sampleRateHz: 8000,
			channelCount: 1,
			outputFrames: 80,
			fileBytes: 204,
		},
	}
}

describe("a recording whose discovery merges mid-recording", () => {
	const dmr = (id: string, centreHz: number, startedAt: number) =>
		makeObs({
			id,
			centreHz,
			startedAt,
			cls: "fsk4-12k5",
			hypotheses: [["dmr", 0.8]],
		})

	it("is reattached to the survivor and commits there", () => {
		const store = newStore()
		const survivor = store.ingest(dmr("o1", CH, T0)).discoveryId!
		const dropped = store.ingest(dmr("o2", CH + 3_500, T0 + 1_000)).discoveryId!
		const metadata = prepared(dropped, "o2")
		store.prepareRecording(metadata)
		// S (first heard) and D (3.5 kHz up) merge once a 3 kHz correction lands: D into S.
		expect(store.rekey("src-1", 3_000)).toEqual({
			merged: [[survivor, dropped]],
		})
		expect(store.get(dropped)).toBeUndefined()
		expect(store.discoveryIdOf("o2")).toBe(survivor)
		expect(store.recordingAssociation(dropped, "o2")).not.toBeNull()
		const plan = store.buildRecordingCommitPlan(metadata.operationId)
		expect(plan?.discovery.id).toBe(survivor)
		expect(store.recordingCommitPlanCurrent(plan!)).toBe(true)
		store.applyRecordingCommitPlan(plan!)
		store.publishRecordingCommit(plan!)
		expect(store.get(survivor)?.evidence.recordings).toBe(1)
		expect(store.aliasOwner(dropped)).toBe(survivor)
	})

	it("a deleted discovery is not reattached", () => {
		const store = newStore()
		const id = store.ingest(dmr("o1", CH, T0)).discoveryId!
		const metadata = prepared(id, "o1")
		store.prepareRecording(metadata)
		expect(store.delete(id)).toBe(true)
		expect(store.recordingAssociation(id, "o1")).toBeNull()
		expect(store.buildRecordingCommitPlan(metadata.operationId)).toBeNull()
	})
})

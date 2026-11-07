/**
 * The late spur or IQ-image waiver of a voiced recording's observation, end to end through the
 * service's own ingest (ScannerService.ingest → DiscoveryStore) and the real WidebandAnalogRecorder,
 * in the service's order per snapshot: the ingest asks the recorder first (keepsOverArtefact,
 * with what the recorder's next call will be given), then the recorder sees the snapshot
 * (track(), or closed() after the closing ingest). The waiver lasts only while the recorder keeps
 * the recording: a refusal of the session, at the share bound or for another veto of the same
 * snapshot, retracts the observation on that ingest, and its closing ingest leaves it retracted.
 * Synthetic signals and observations only.
 */
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import type { WidebandAnalogRecorder } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	ObservationEndReason,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import {
	harness as recorderHarness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"

interface Internals {
	store: DiscoveryStore
	jobs: Map<string, unknown>
	widebandAnalog: WidebandAnalogRecorder
	ingest(
		live: LiveObservation,
		track: TrackSnapshot,
		endReason?: ObservationEndReason,
	): void
}

const CH = 446_006_250
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

type Veto = { encrypted?: boolean; recordAllowed?: boolean }

async function setup() {
	const svc = serviceHarness({
		patch: s => {
			s.passive.enabled = false
		},
	})
	cleanups.push(async () => {
		await svc.service.stop()
		await rm(svc.dir, { recursive: true, force: true })
	})
	const rec = recorderHarness()
	const internal = svc.service as unknown as Internals
	internal.widebandAnalog = rec.rec
	// The covering job (placement needs one): record.analog on, as by default.
	const job = {
		spec: { mode: "in-window", record: { analog: true } },
		counts: { observations: 0, transients: 0 },
	}
	internal.jobs.set("job-1", job)
	const live: LiveObservation = {
		observationId: "o",
		sourceId: "src-1",
		trackId: "t-o",
		epoch: 1,
		jobIds: ["job-1"],
		discoveryId: null,
		startedAt: 0,
		classification: { class: "analog-fm", hypotheses: [], tier: "spectral" },
		probeIds: new Set(),
		lastActivityAt: 0,
		lastIngestAt: 0,
		lastTrack: null,
		decoded: false,
		encrypted: false,
	}
	/** The store's view of the snapshot: the same flags the recorder's snapshot carries. */
	const storeTrack = (
		flags: Partial<TrackSnapshot["flags"]>,
	): TrackSnapshot => {
		const t = makeTrack({ id: "o", centreHz: CH, startedAt: 0, open: true })
		t.gate = "passed"
		Object.assign(t.flags, flags)
		return t
	}
	let onset = 0
	/**
	 * One snapshot in the service's order: the ingest (which asks the recorder), then the
	 * recorder's call with the same vetoes. Returns the discovery the observation has after it.
	 */
	const step = (
		flags: Partial<TrackSnapshot["flags"]>,
		veto: Veto = {},
		close = false,
	): string | null => {
		live.encrypted = veto.encrypted === true
		const t = snapshot("o", onset, rec.engine.liveEdge())
		Object.assign(t.flags, flags)
		internal.ingest(live, storeTrack(flags), close ? "quiet" : undefined)
		if (close)
			rec.rec.closed("o", t, null, {
				analogFm: true,
				discoveryId: live.discoveryId,
				encrypted: live.encrypted,
				recordAllowed: veto.recordAllowed !== false,
			})
		else rec.rec.track(input("o", t, veto))
		return internal.store.discoveryIdOf("o") ?? null
	}
	/** Placed, then 2 s of voice with a clean snapshot every 25 ms chunk: classed and voiced. */
	const voiced = async (): Promise<string> => {
		await rec.feed(0.5, false)
		onset = rec.engine.liveEdge()
		const placed = step({})
		expect(placed).not.toBeNull()
		await rec.feed(2, true, () => void step({}))
		return placed!
	}
	return { rec, internal, job, step, voiced }
}

describe("the artefact waiver of a voiced recording's observation", () => {
	it("a minority of late flags keeps the observation and its association to the close", async () => {
		const { rec, internal, step, voiced } = await setup()
		const id = await voiced()
		for (let i = 0; i < 5; i++) {
			await rec.feed(0.025, true)
			expect(step({ spur: true })).toBe(id)
		}
		expect(rec.rec.owns("o")).toBe(true)
		await rec.feed(0.6, false)
		expect(step({ spur: true }, {}, true)).toBe(id)
		expect(internal.store.recordingAssociation(id, "o")).not.toBeNull()
		// Past the hang the file finishes and is kept.
		await rec.feed(3.5, false)
		await rec.rec.idle()
		expect(rec.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 60_000)

	it("ends at the snapshot that reaches half: that ingest and the closing one retract it", async () => {
		const { rec, internal, step, voiced } = await setup()
		const id = await voiced()
		let kept = 0
		for (let i = 0; i < 400; i++) {
			await rec.feed(0.025, true)
			const after = step({ iqImage: true })
			// The ingest's answer is the recorder's for the same snapshot, before and at the bound.
			expect(after === id).toBe(rec.rec.owns("o"))
			if (after === null) break
			kept++
		}
		expect(kept).toBeGreaterThan(0)
		expect(rec.rec.owns("o")).toBe(false)
		expect(rec.rec.diagnostics().recent.at(-1)!.code).toBe("refused:unclean")
		// A later flagged snapshot and the close no longer keep it.
		await rec.feed(0.025, true)
		expect(step({ iqImage: true })).toBeNull()
		await rec.feed(0.6, false)
		expect(step({ iqImage: true }, {}, true)).toBeNull()
		expect(internal.store.recordingAssociation(id, "o")).toBeNull()
		await rec.rec.idle()
	}, 60_000)

	for (const [name, veto, code] of [
		["encrypted evidence", { encrypted: true }, "refused:encrypted"],
		[
			"a lost record.analog",
			{ recordAllowed: false },
			"refused:record-disabled",
		],
	] as const)
		it(`a first late spur snapshot that also carries ${name} is not waived`, async () => {
			const { rec, internal, job, step, voiced } = await setup()
			const id = await voiced()
			// The same snapshot without the veto would be waived (the minority case above).
			await rec.feed(0.025, true)
			// The covering job opts out with this snapshot: widebandRecordAllowed answers false.
			if (veto.recordAllowed === false) job.spec.record.analog = false
			expect(step({ spur: true }, veto)).toBeNull()
			expect(rec.rec.owns("o")).toBe(false)
			expect(rec.rec.diagnostics().recent.at(-1)!.code).toBe(code)
			await rec.feed(0.6, false)
			expect(step({ spur: true }, veto, true)).toBeNull()
			expect(internal.store.recordingAssociation(id, "o")).toBeNull()
			await rec.rec.idle()
		}, 60_000)
})

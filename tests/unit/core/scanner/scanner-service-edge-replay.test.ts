// DQ 1.4e: a finished IQ capture whose track turns edge while the replay queue waits for a decoder
// slot is never replayed, and one turning edge while its replay runs has its result dropped (real
// replay queue, a stateful capture port).
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { IQ_REPLAY_QUEUE_HOLDER } from "../../../../src/core/iq-capture/replay-queue.js"
import type { IqCaptureView } from "../../../../src/core/scanner/iq-capture-contract.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import type { ScannerServiceDeps } from "../../../../src/core/scanner/scanner-service.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

interface Internal {
	deps: ScannerServiceDeps
	live: Map<string, LiveObservation>
	iqCaptureOf: Map<string, unknown>
	requestIqCapture(live: LiveObservation, track: TrackSnapshot): void
	replayProbes(): unknown
	onTrack(
		sourceId: string,
		ev: { kind: "track-update"; track: TrackSnapshot },
	): void
}

/** The capture service's holder, claim, settle and discard rules, in memory. */
function statefulPort() {
	const entries = new Map<
		string,
		{
			view: IqCaptureView
			holder: string | null
			finished: boolean
			replaying?: boolean
			pendingDiscard?: boolean
		}
	>()
	const finished: ((v: IqCaptureView) => void)[] = []
	const removed: ((id: string, obs: string | null) => void)[] = []
	const remove = (id: string): void => {
		const e = entries.get(id)
		if (!e) return
		entries.delete(id)
		for (const l of removed) l(id, e.view.observationId)
	}
	const port = {
		near: () => [],
		capture: vi.fn((req: { observationId: string | null; rfHz: number }) => {
			entries.set("cap-1", {
				view: {
					captureId: "cap-1",
					sourceId: "rtl",
					observationId: req.observationId,
					epoch: 1,
					rfHz: req.rfHz,
					tuningTrust: "commanded",
					capturedAtMs: 0,
					durationMs: 4000,
					gapSamples: 0,
				},
				holder: null,
				finished: false,
			})
			return { captureId: "cap-1" }
		}),
		captureFor: () => ({ refused: "busy" as const }),
		view: (id: string) => {
			const e = entries.get(id)
			return e?.finished && !e.pendingDiscard ? e.view : null
		},
		holderOf: (id: string) => entries.get(id)?.holder,
		claim: (id: string, holder: string) => {
			const e = entries.get(id)
			if (!e?.finished || e.holder !== null) return false
			e.holder = holder
			return true
		},
		settle: (id: string, holder: string) => {
			if (entries.get(id)?.holder === holder) remove(id)
		},
		discard: vi.fn((id: string, _reason: string, holder?: string) => {
			const e = entries.get(id)
			if (!e || (e.holder !== null && e.holder !== holder)) return false
			// Deferred while a replay of it runs (the store's pending deletion).
			if (e.replaying) e.pendingDiscard = true
			else remove(id)
			return true
		}),
		end: vi.fn(),
		confirmLive: () => 0,
		openReplay: () => null,
		onFinished: (l: (v: IqCaptureView) => void) => {
			finished.push(l)
			return () => undefined
		},
		onRemoved: (l: (id: string, obs: string | null) => void) => {
			removed.push(l)
			return () => undefined
		},
		flush: vi.fn(),
		attachSource: vi.fn(),
		detachSource: vi.fn(),
		setShapes: vi.fn(),
	}
	/** The capture reached its cap: finished and stored. */
	const finish = (id: string): void => {
		const e = entries.get(id)
		if (!e) return
		e.finished = true
		for (const l of finished) l(e.view)
	}
	return { port, entries, finish }
}

const harnesses: ReturnType<typeof serviceHarness>[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const h of harnesses.splice(0)) {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
})

async function run(turnsEdge: boolean) {
	const h = serviceHarness({ patch: s => void (s.passive.enabled = false) })
	harnesses.push(h)
	const internal = h.service as unknown as Internal
	const { port, entries, finish } = statefulPort()
	internal.deps = { ...internal.deps, iqCapture: port as never }
	// Every decoder slot is busy until released.
	const releases: (() => void)[] = []
	const request = vi.fn(() => ({ deferred: "max-probes" }))
	internal.replayProbes = () => ({
		request,
		onSlotRelease: (l: () => void) => {
			releases.push(l)
			return () => undefined
		},
		dispose: () => undefined,
	})
	await h.service.start()
	// A running job starts the source's spectrum engine (the epoch the capture checks).
	await h.service.createJob({
		sourceId: "rtl",
		mode: "in-window",
		ranges: [{ startHz: 446_000_000, endHz: 446_100_000 }],
	})
	const track = trackOf({
		trackId: "t1",
		centreHz: CENTRE + 50_000,
		obwHz: 9000,
		epoch: 1,
	})
	track.gate = "passed"
	const live: LiveObservation = {
		observationId: "o_1",
		sourceId: "rtl",
		trackId: "t1",
		epoch: 1,
		jobIds: [],
		discoveryId: "d_1",
		startedAt: 0,
		classification: { class: "unknown", hypotheses: [], tier: "spectral" },
		probeIds: new Set(),
		lastActivityAt: 0,
		lastIngestAt: 0,
		lastTrack: track,
		decoded: false,
		encrypted: false,
	}
	internal.live.set("t1", live)
	internal.requestIqCapture(live, track)
	expect(port.capture).toHaveBeenCalledTimes(1)
	finish("cap-1")
	await new Promise(r => setTimeout(r, 0))
	// Finished: it left the open-writer map; the queue holds it and waits for a slot.
	expect(internal.iqCaptureOf.has("o_1")).toBe(false)
	expect(entries.get("cap-1")?.holder).toBe(IQ_REPLAY_QUEUE_HOLDER)
	expect(request).toHaveBeenCalledTimes(1)
	internal.onTrack("rtl", {
		kind: "track-update",
		track: { ...track, flags: { ...track.flags, edge: turnsEdge } },
	})
	for (const l of releases.splice(0)) l()
	await new Promise(r => setTimeout(r, 0))
	return { request, entries, port }
}

describe("finished IQ capture turning edge (DQ 1.4e)", () => {
	it("is discarded while queued and no trial is requested after the slot frees", async () => {
		const { request, entries, port } = await run(true)
		expect(port.discard).toHaveBeenCalledWith(
			"cap-1",
			"invalid",
			IQ_REPLAY_QUEUE_HOLDER,
		)
		expect(entries.has("cap-1")).toBe(false)
		expect(request).toHaveBeenCalledTimes(1)
	})

	it("a control that stays inside keeps its capture and asks again for its trial", async () => {
		const { request, entries, port } = await run(false)
		expect(port.discard).not.toHaveBeenCalled()
		expect(entries.has("cap-1")).toBe(true)
		expect(request).toHaveBeenCalledTimes(2)
	})
})

interface Spied {
	applyEvidence(live: LiveObservation, ev: unknown): boolean
	rememberReplayTrials(...args: unknown[]): void
}

/** The replay is running (a probe holds the capture) when the track turns edge. */
async function runWhileReplaying(turnsEdge: boolean) {
	const h = serviceHarness({ patch: s => void (s.passive.enabled = false) })
	harnesses.push(h)
	const internal = h.service as unknown as Internal
	const { port, entries, finish } = statefulPort()
	internal.deps = { ...internal.deps, iqCapture: port as never }
	let answer: ((a: unknown) => void) | null = null
	const asked: { protocol: string }[] = []
	const request = vi.fn((req: { captureId: string; protocol: string }) => {
		asked.push(req)
		const e = entries.get(req.captureId)
		if (e) e.replaying = true
		return {
			run: {
				result: new Promise(resolve => {
					answer = a => {
						if (e) e.replaying = false
						resolve(a)
					}
				}),
				cancel: () => answer?.({ outcome: "cancelled", decoded: null }),
			},
		}
	})
	internal.replayProbes = () => ({
		request,
		onSlotRelease: () => () => undefined,
		dispose: () => undefined,
	})
	await h.service.start()
	await h.service.createJob({
		sourceId: "rtl",
		mode: "in-window",
		ranges: [{ startHz: 446_000_000, endHz: 446_100_000 }],
	})
	const track = trackOf({
		trackId: "t1",
		centreHz: CENTRE + 50_000,
		obwHz: 9000,
		epoch: 1,
	})
	track.gate = "passed"
	const live: LiveObservation = {
		observationId: "o_1",
		sourceId: "rtl",
		trackId: "t1",
		epoch: 1,
		jobIds: [],
		discoveryId: "d_1",
		startedAt: 0,
		classification: { class: "unknown", hypotheses: [], tier: "spectral" },
		probeIds: new Set(),
		lastActivityAt: 0,
		lastIngestAt: 0,
		lastTrack: track,
		decoded: false,
		encrypted: false,
	}
	internal.live.set("t1", live)
	internal.requestIqCapture(live, track)
	finish("cap-1")
	await new Promise(r => setTimeout(r, 0))
	// The first trial is running on the capture.
	expect(request).toHaveBeenCalledTimes(1)
	expect(entries.get("cap-1")?.replaying).toBe(true)
	internal.onTrack("rtl", {
		kind: "track-update",
		track: { ...track, flags: { ...track.flags, edge: turnsEdge } },
	})
	const protocol = asked[0]?.protocol
	const spied = h.service as unknown as Spied
	const applied = vi.spyOn(spied, "applyEvidence")
	const remembered = vi.spyOn(spied, "rememberReplayTrials")
	const results = vi.spyOn(h.service, "applyReplayResult")
	;(answer as ((a: unknown) => void) | null)?.({
		outcome: "decoded",
		decoded: { protocol, identity: { kind: "dmr-cc", value: "1" } },
	})
	await new Promise(r => setTimeout(r, 0))
	// The decode reached the scanner's result sink either way.
	expect(results).toHaveBeenCalledTimes(1)
	expect(results.mock.calls[0]?.[0].decoded).not.toBeNull()
	return { live, entries, port, protocol, applied, remembered }
}

describe("IQ replay running when its track turns edge (DQ 1.4e)", () => {
	it("its decode is dropped: no identity, no trial memory, the capture is not kept", async () => {
		const { live, entries, port, protocol, applied, remembered } =
			await runWhileReplaying(true)
		expect(protocol).toBe("dmr")
		expect(port.discard).toHaveBeenCalledWith(
			"cap-1",
			"invalid",
			IQ_REPLAY_QUEUE_HOLDER,
		)
		expect(applied).not.toHaveBeenCalled()
		expect(remembered).not.toHaveBeenCalled()
		expect(live.decoded).toBe(false)
		// The pending deletion completed when the queue settled the capture.
		expect(entries.has("cap-1")).toBe(false)
	})

	it("a control that stays inside keeps its decode", async () => {
		const { live, port, protocol, applied, remembered } =
			await runWhileReplaying(false)
		expect(protocol).toBe("dmr")
		expect(port.discard).not.toHaveBeenCalled()
		expect(applied).toHaveBeenCalledWith(
			live,
			expect.objectContaining({ protocol: "dmr", transport: "replay" }),
		)
		expect(remembered).toHaveBeenCalledTimes(1)
	})
})

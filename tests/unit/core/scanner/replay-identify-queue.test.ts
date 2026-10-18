// WG11 req 6.4, 6.8 (Main review M2 and the once-recording integration): the replay queue never
// takes a capture identify asked for, nor one of an observation an identify target works on.
// Real IdentifyRunner, real ProbePool, real pool adapter, real replay queue, real capture store.
import { PassThrough, type Readable } from "node:stream"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import type { ScannerIdentifyEventData } from "@wavekit/api-types"
import { createPoolReplayProbes } from "../../../../src/core/iq-capture/pool-adapter.js"
import {
	createIqReplayQueue,
	IQ_REPLAY_QUEUE_HOLDER,
} from "../../../../src/core/iq-capture/replay-queue.js"
import {
	IqCaptureStore,
	viewOf as entryView,
} from "../../../../src/core/iq-capture/store.js"
import {
	IdentifyRunner,
	normaliseIdentify,
	type IdentifyTrackView,
} from "../../../../src/core/scanner/identify.js"
import type {
	IqCaptureDiscardReason,
	IqCaptureRequest,
	IqCaptureView,
	IqReplayResult,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import { createKnownProtocolMemory } from "../../../../src/core/scanner/known-protocol.js"
import {
	offsetTransport,
	REPLAY_PROBE_PRIORITY,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { createReplayTransport } from "../../../../src/core/scanner/probes/replay-transport.js"
import { planReplayTrials } from "../../../../src/core/scanner/replay-plan.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	TARGET_HZ,
	fakeInner,
	identifyRecord,
	summaryOf,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import {
	flushAsync,
	linkLine,
	poolHarness,
} from "../../../mocks/scanner/probe-fakes.js"

/** The capture service's port semantics over the real store; `end` finishes a capture (3 s, no gap). */
class StorePort {
	readonly store: IqCaptureStore
	private seq = 0
	private readonly listeners = new Set<(v: IqCaptureView) => void>()
	readonly claims: [string, string, boolean][] = []
	constructor(
		now: () => number,
		private readonly shape = { samples: 3 * 48_000, gapSamples: 0 },
	) {
		this.store = new IqCaptureStore({
			capBytes: 64 * 1_536_000,
			maxCaptureMs: 4000,
			now,
			onRemove: e => this.store.released(e.bytes),
		})
	}
	capture(req: IqCaptureRequest, holder: string | null = null) {
		const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`
		const res = this.store.admit(req, id, req.epoch)
		if ("captureId" in res && holder !== null) this.store.reserve(id, holder)
		return res
	}
	captureFor(req: IqCaptureRequest, holder: string) {
		return this.capture(req, holder)
	}
	end(id: string) {
		if (this.store.get(id)?.state !== "capturing") return
		this.store.captured(id, this.shape.samples, this.shape.gapSamples)
		const view = this.store.ready(id)
		if (view) for (const l of this.listeners) l(view)
	}
	near(
		sourceId: string,
		hz: number,
		tol: number,
		opts: { observationId: string | null; limit: number },
	) {
		return this.store.near(sourceId, hz, tol, opts)
	}
	claim(id: string, holder: string) {
		const ok = this.store.claim(id, holder)
		this.claims.push([id, holder, ok])
		return ok
	}
	settle(id: string, holder: string) {
		const e = this.store.get(id)
		if (e?.state === "capturing" && e.holder === holder) this.store.fail(id)
		else this.store.settle(id, holder)
	}
	confirmLive(sourceId: string, observationId: string) {
		return this.store.confirmLive(sourceId, observationId)
	}
	openReplay(id: string): Readable | null {
		if (!this.store.beginReplay(id)) return null
		const s = new PassThrough()
		s.end()
		s.once("close", () => this.store.endReplay(id))
		return s
	}
	view(id: string) {
		const e = this.store.get(id)
		return e && e.state === "ready" && e.pendingDiscard === null
			? entryView(e)
			: null
	}
	holderOf(id: string) {
		const e = this.store.get(id)
		return e ? e.holder : undefined
	}
	discard(id: string, reason: IqCaptureDiscardReason, holder?: string) {
		const e = this.store.get(id)
		if (!e || (e.holder !== null && e.holder !== holder)) return false
		return this.store.discard(id, reason)
	}
	onFinished(l: (v: IqCaptureView) => void) {
		this.listeners.add(l)
		return () => this.listeners.delete(l)
	}
}

function harness(shape?: { samples: number; gapSamples: number }) {
	const settings = testSettings()
	let port!: StorePort
	const pool = poolHarness({
		settings,
		transports: [
			offsetTransport,
			createReplayTransport({ openReplay: id => port.openReplay(id) }),
		],
	})
	port = new StorePort(() => pool.clock.now, shape)
	const memory = createKnownProtocolMemory({
		discovery: () => ({ protocol: "dmr", confidence: "decoded" }),
	})
	const recordDecode = vi.spyOn(memory, "recordDecode")
	const recordMiss = vi.spyOn(memory, "recordMiss")
	const recheck: { fn: (() => void) | null } = { fn: null }
	const record = identifyRecord()
	const tracks: IdentifyTrackView[] = []
	const events: ScannerIdentifyEventData[] = []
	const runner = new IdentifyRunner({
		record,
		identify: normaliseIdentify({
			target: { frequencyHz: TARGET_HZ },
			record: false,
		}),
		inner: fakeInner(record, () => pool.clock.now),
		probes: pool.pool,
		engine: () => pool.engine,
		artefactAt: () => Promise.resolve(null),
		liveTracks: () => tracks,
		lastSummary: () => summaryOf(),
		discoveryOf: () => ({ id: "d_1" }) as never,
		priorsAt: () => ({}),
		format: () => "U8_IQ",
		channelizer: () => false,
		settings: () => settings,
		// As the scanner does (setReplayRecheck): every identify update re-checks the parked captures.
		emit: d => {
			events.push(structuredClone(d))
			recheck.fn?.()
		},
		logger: pino({ level: "silent" }),
		now: () => pool.clock.now,
		knownProtocols: memory,
		iqCapture: port,
	})
	const sink = vi.fn((_r: IqReplayResult) => undefined)
	const probes = createPoolReplayProbes(pool.pool as never, {
		priority: REPLAY_PROBE_PRIORITY,
		jobId: IQ_REPLAY_QUEUE_HOLDER,
	})
	const queue = createIqReplayQueue({
		port,
		probes,
		planner: planReplayTrials,
		sink,
		planInput: capture => ({
			capture,
			track: null,
			knownProtocol: "dmr",
			priors: { dmr: 1 },
			narrowRaster: false,
		}),
		skip: capture => runner.worksOn(capture),
		logger: pino({ level: "silent" }),
	})
	queue.start()
	recheck.fn = () => queue.recheck()
	const queueRequests: unknown[] = []
	const request = pool.pool.request.bind(pool.pool)
	pool.pool.request = req => {
		if (req.jobId === IQ_REPLAY_QUEUE_HOLDER) queueRequests.push(req)
		return request(req)
	}
	const exited = new Set<string>()
	const replayDecoders = () =>
		[...pool.decoders.created.entries()].filter(
			([, d]) => d.config.options["inputIqFormat"] === "cf32",
		)
	const advance = async (ms: number): Promise<void> => {
		pool.clock.now += ms
		runner.tick(pool.clock.now)
		pool.pool.pump()
		await flushAsync()
		await flushAsync()
	}
	/** Runs to the job's end; each replay decoder decodes DMR (H2: two lines) and exits cleanly. */
	const run = async (onStep?: (i: number) => void): Promise<void> => {
		for (let i = 0; i < 120 && record.state !== "completed"; i++) {
			onStep?.(i)
			await advance(1000)
			for (const [id, d] of replayDecoders()) {
				if (exited.has(id)) continue
				exited.add(id)
				pool.decoders.emitLink(id, linkLine(1, pool.clock.now))
				pool.decoders.emitLink(id, linkLine(1, pool.clock.now + 30))
				d.emit("exit", 0, null)
				await new Promise(r => setTimeout(r, 300))
				await flushAsync()
			}
		}
	}
	return {
		pool,
		port,
		record,
		tracks,
		events,
		runner,
		queue,
		queueRequests,
		sink,
		probes,
		recordDecode,
		recordMiss,
		replayDecoders,
		run,
	}
}

describe("identify keeps its captures from the replay queue (review M2)", () => {
	it("identify's own capture is replayed in its target's trials; the queue never takes it", async () => {
		const h = harness()
		await h.runner.start()
		h.tracks.push(viewOf(trackOf({ obwHz: 12_000 })))
		await h.run()
		const last = h.events.at(-1)!
		expect(last.state).toBe("identified")
		const dmr = last.trials.find(t => t.protocol === "dmr")!
		expect(dmr).toMatchObject({ outcome: "decoded", transport: "replay" })
		// The capture identify requested finished while held by the job: the queue skipped it.
		expect(h.queue.counters().skipped).toBe(1)
		expect(h.queueRequests).toEqual([])
		expect(h.sink).not.toHaveBeenCalled()
		expect(
			h.port.claims.filter(
				([, holder, ok]) => holder === IQ_REPLAY_QUEUE_HOLDER && ok,
			),
		).toEqual([])
		// INTEGRATION: the identify replay decode is recorded exactly once.
		expect(h.recordDecode).toHaveBeenCalledTimes(1)
		expect(h.recordDecode).toHaveBeenCalledWith("d_1")
		expect(h.port.store.all()).toEqual([])
		await h.queue.stop()
		h.probes.dispose()
	})

	it("a detection capture of the target's observation finishing during identify is left to identify", async () => {
		const h = harness()
		await h.runner.start()
		const track = trackOf({ obwHz: 12_000 })
		h.tracks.push(viewOf(track))
		let detection: string | null = null
		await h.run(i => {
			if (i !== 2) return
			const res = h.port.capture({
				sourceId: "rtl",
				observationId: `o_${track.trackId}`,
				epoch: 1,
				rfHz: TARGET_HZ,
				tuningTrust: "commanded",
				fromSample: 0,
				reason: "detection",
			})
			if ("captureId" in res) {
				detection = res.captureId
				h.port.end(res.captureId)
			}
		})
		expect(detection).not.toBeNull()
		expect(h.queue.counters().skipped).toBeGreaterThanOrEqual(1)
		expect(h.queueRequests).toEqual([])
		expect(h.sink).not.toHaveBeenCalled()
		expect(h.port.claims).toContainEqual([detection, "j_ident", true])
		expect(h.events.at(-1)!.state).toBe("identified")
		expect(h.port.store.all()).toEqual([])
		await h.queue.stop()
		h.probes.dispose()
	})
})

describe("identify's replay miss needs the full hold, gap-free (Astra MAJOR f)", () => {
	async function missesDuringReplay(
		shape: {
			samples: number
			gapSamples: number
		},
		clean = true,
	) {
		const h = harness(shape)
		const exited = new Set<string>()
		await h.runner.start()
		h.tracks.push(viewOf(trackOf({ obwHz: 12_000 })))
		let before = -1
		let sawReplay = false
		for (let i = 0; i < 120 && h.record.state !== "completed"; i++) {
			h.pool.clock.now += 1000
			h.runner.tick(h.pool.clock.now)
			h.pool.pool.pump()
			await flushAsync()
			await flushAsync()
			if (
				!sawReplay &&
				h.pool.pool.status().some(p => p.transport === "replay")
			) {
				before = h.recordMiss.mock.calls.length
				sawReplay = true
			}
			// The replay decoder reaches its clean end (input EOF, exit 0), or never exits.
			if (clean)
				for (const [id, d] of h.replayDecoders()) {
					if (exited.has(id)) continue
					exited.add(id)
					d.emit("exit", 0, null)
					await new Promise(r => setTimeout(r, 300))
					await flushAsync()
				}
		}
		const after = h.recordMiss.mock.calls.length
		const replayTrials = (h.events.at(-1)?.trials ?? []).filter(
			t => t.transport === "replay",
		).length
		await h.queue.stop()
		h.probes.dispose()
		return { sawReplay, replayMisses: after - before, replayTrials }
	}

	it("a 100 ms capture with a gap whose replay reaches the wall-clock hold adds no known miss", async () => {
		expect(
			await missesDuringReplay({ samples: 4800, gapSamples: 1 }),
		).toMatchObject({ sawReplay: true, replayMisses: 0 })
	})

	it("a gap-free 100 ms capture adds no known miss either", async () => {
		expect(
			await missesDuringReplay({ samples: 4800, gapSamples: 0 }),
		).toMatchObject({ sawReplay: true, replayMisses: 0 })
	})

	it("a gap-free 4 s capture still counts the known protocol's miss", async () => {
		expect(
			await missesDuringReplay({ samples: 4 * 48_000, gapSamples: 0 }),
		).toMatchObject({ sawReplay: true, replayMisses: 1 })
	})

	it("a replay decoder that never exits: the hold expiry is no verdict and no miss (Astra re-review 3 #2)", async () => {
		expect(
			await missesDuringReplay({ samples: 4 * 48_000, gapSamples: 0 }, false),
		).toEqual({ sawReplay: true, replayMisses: 0, replayTrials: 0 })
	})
})

describe("a parked capture rejoins the queue when identify lets go (Astra MAJOR c)", () => {
	it("identify cancelled before it claimed the detection capture: the queue replays it", async () => {
		const h = harness()
		await h.runner.start()
		const track = trackOf({ obwHz: 12_000 })
		h.tracks.push(viewOf(track))
		for (let i = 0; i < 2; i++) {
			h.pool.clock.now += 1000
			h.runner.tick(h.pool.clock.now)
			await flushAsync()
		}
		const res = h.port.capture({
			sourceId: "rtl",
			observationId: `o_${track.trackId}`,
			epoch: 1,
			rfHz: TARGET_HZ,
			tuningTrust: "commanded",
			fromSample: 0,
			reason: "detection",
		})
		const id = "captureId" in res ? res.captureId : ""
		h.port.end(id)
		await flushAsync()
		// Parked: identify works on the observation and has not claimed it (its live runs go first).
		expect(h.queue.counters().parked).toBeGreaterThanOrEqual(1)
		expect(h.port.holderOf(id)).toBeNull()
		await h.runner.dispatch({ type: "cancel" })
		await flushAsync()
		await flushAsync()
		expect(h.port.claims).toContainEqual([id, IQ_REPLAY_QUEUE_HOLDER, true])
		expect(h.queueRequests.length).toBeGreaterThanOrEqual(1)
		await h.queue.stop()
		h.probes.dispose()
	})
})

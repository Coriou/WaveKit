// WG11 req 6.4, 6.7 (Main review M1): replay deferrals never preempt live probes, and live requests never
// preempt a replay. Real ProbePool, real pool adapter and real replay queue.
import { PassThrough } from "node:stream"
import pino from "pino"
import { describe, expect, it } from "vitest"
import { createPoolReplayProbes } from "../../../../src/core/iq-capture/pool-adapter.js"
import {
	createIqReplayQueue,
	IQ_REPLAY_QUEUE_HOLDER,
	type IqReplayQueuePort,
} from "../../../../src/core/iq-capture/replay-queue.js"
import type {
	IqCaptureDiscardReason,
	IqCaptureView,
	IqReplayPlanInput,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import {
	offsetTransport,
	REPLAY_PROBE_PRIORITY,
	type ProbeMode,
	type ProbeRequest,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { createReplayTransport } from "../../../../src/core/scanner/probes/replay-transport.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	flushAsync,
	poolHarness,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"

const MODE: ProbeMode = {
	decoderType: "multimon-ng",
	protocol: "pocsag",
	covers: ["pocsag"],
	options: {},
	holdMs: 4000,
}

class Port implements IqReplayQueuePort {
	entries = new Map<string, { view: IqCaptureView; holder: string | null }>()
	add(id: string): IqCaptureView {
		const view: IqCaptureView = {
			captureId: id,
			sourceId: "rtl",
			observationId: "o9",
			epoch: 1,
			rfHz: 446_125_000,
			tuningTrust: "commanded",
			capturedAtMs: 0,
			durationMs: 1000,
			gapSamples: 0,
		}
		this.entries.set(id, { view, holder: null })
		return view
	}
	onFinished() {
		return () => undefined
	}
	view(id: string) {
		return this.entries.get(id)?.view ?? null
	}
	holderOf(id: string) {
		const e = this.entries.get(id)
		return e ? e.holder : undefined
	}
	claim(id: string, holder: string) {
		const e = this.entries.get(id)
		if (!e || e.holder !== null) return false
		e.holder = holder
		return true
	}
	settle(id: string, holder: string) {
		if (this.entries.get(id)?.holder === holder) this.entries.delete(id)
	}
	discard(id: string, _r: IqCaptureDiscardReason, holder?: string) {
		const e = this.entries.get(id)
		if (!e || (e.holder !== null && e.holder !== holder)) return false
		this.entries.delete(id)
		return true
	}
}

async function settleAll(): Promise<void> {
	for (let i = 0; i < 6; i++) await flushAsync()
}

function setup(budgetCores?: number) {
	const h = poolHarness({
		transports: [
			offsetTransport,
			createReplayTransport({ openReplay: () => new PassThrough() }),
		],
		...(budgetCores !== undefined
			? {
					settings: testSettings(s => {
						s.cpuBudgetCores = budgetCores
					}),
				}
			: {}),
	})
	const stops: { probeId: string; why: string }[] = []
	h.pool.on("probe-state", (probeId: string, state: string) => {
		if (state === "stopped") stops.push({ probeId, why: state })
	})
	const port = new Port()
	const probes = createPoolReplayProbes(h.pool as never, {
		priority: REPLAY_PROBE_PRIORITY,
		jobId: IQ_REPLAY_QUEUE_HOLDER,
	})
	const queue = createIqReplayQueue({
		port,
		probes,
		planner: () => [{ protocol: "pocsag", mode: MODE, known: false }],
		sink: () => undefined,
		planInput: capture => ({ capture }) as unknown as IqReplayPlanInput,
		logger: pino({ level: "silent" }),
	})
	const replayReq = (over: Partial<ProbeRequest> = {}): ProbeRequest =>
		probeRequest({
			jobId: "identify-1",
			priority: 110,
			trackId: "replay-cap-id",
			modes: [MODE],
			replay: { captureId: "cap-id" },
			...over,
		})
	return { h, stops, port, probes, queue, replayReq }
}

describe("replay preemption (review M1)", () => {
	it("a queue replay deferred on the replay slot stops no live passive probe (no cascade)", async () => {
		const s = setup()
		const live = s.h.pool.request(probeRequest({ priority: 50, modes: [MODE] }))
		expect(live).toHaveProperty("started")
		expect(s.h.pool.request(s.replayReq())).toHaveProperty("started")
		await settleAll()
		s.queue.enqueue(s.port.add("cap-q"))
		await settleAll()
		// The queue's trial waits for the replay slot; the live probe is untouched.
		expect(s.stops).toEqual([])
		expect(
			s.h.pool
				.status()
				.map(p => p.transport)
				.sort(),
		).toEqual(["offset", "replay"])
		await s.queue.stop()
		s.probes.dispose()
	})

	it("an identify replay deferred on the slot does not preempt the queue's replay", async () => {
		const s = setup()
		s.queue.enqueue(s.port.add("cap-q"))
		await settleAll()
		expect(s.h.pool.status().map(p => p.transport)).toEqual(["replay"])
		expect(s.h.pool.request(s.replayReq())).toEqual({ deferred: "max-probes" })
		await settleAll()
		expect(s.stops).toEqual([])
		expect(s.h.pool.status()).toHaveLength(1)
		await s.queue.stop()
		s.probes.dispose()
	})

	it("a live identify request deferred on the budget does not preempt the queue's replay", async () => {
		const s = setup(0.5)
		s.queue.enqueue(s.port.add("cap-q"))
		await settleAll()
		expect(s.h.pool.status().map(p => p.transport)).toEqual(["replay"])
		const res = s.h.pool.request(
			probeRequest({ jobId: "identify-1", priority: 110, modes: [MODE] }),
		)
		expect(res).toEqual({ deferred: "budget" })
		await settleAll()
		expect(s.stops).toEqual([])
		expect(s.h.pool.status().map(p => p.transport)).toEqual(["replay"])
		await s.queue.stop()
		s.probes.dispose()
	})

	it("a live request still preempts a lower-priority live probe", async () => {
		const s = setup()
		const settings = s.h.settings
		const n = settings.maxProbes.offset
		for (let i = 0; i < n; i++)
			expect(
				s.h.pool.request(
					probeRequest({ trackId: `t${i}`, priority: 10, modes: [MODE] }),
				),
			).toHaveProperty("started")
		await settleAll()
		expect(
			s.h.pool.request(
				probeRequest({ trackId: "tx", priority: 110, modes: [MODE] }),
			),
		).toEqual({ deferred: "max-probes" })
		await settleAll()
		expect(s.stops).toHaveLength(1)
		s.probes.dispose()
	})
})

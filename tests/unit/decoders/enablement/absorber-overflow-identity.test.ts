import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import pino from "pino"
import { expect, it, vi } from "vitest"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../../../src/core/source-fanout-router.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import { createBurstAbsorber } from "../../../../src/core/link-burst/absorber.js"
import type {
	BurstAbsorber,
	IngestRecorder,
	LinkBurstFactories,
} from "../../../../src/core/link-burst/contract.js"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type {
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

/**
 * The real burst absorber behind the real source router, read by the real
 * monitor and gate. Source "s" carries a tuned-band readsb on probation
 * (`decoder-readsb`) and live audio (`live-demod-s`, read by no placement).
 * The absorber is 128 bytes; the test chooses which branches it sees
 * congested and drives its ingest on its own clock (`absMono`). Overflow
 * held by live audio only must never suspend readsb.
 */
function harness() {
	const stream = new PassThrough()
	const sources = Object.assign(new EventEmitter(), {
		getAllStatus: () => [{ id: "s", connected: false }],
		getStatus: () => ({ connected: true }),
		getStream: () => stream,
		getCaps: () => ({ format: "U8_IQ", sampleRate: 2_048_000 }),
		getConfig: () => ({
			host: "example.invalid",
			type: "rtl_tcp",
			burstAbsorber: { seconds: 2 },
		}),
	})
	const recorder = {
		configure: vi.fn(),
		recovery: () => null,
		resetArrival: vi.fn(),
		observeChunk: vi.fn(),
		noteHolding: vi.fn(),
	} as unknown as IngestRecorder
	let absMono = 0
	const congested = new Set<string>()
	let absorber: (BurstAbsorber & { overflowGatedBy(): unknown }) | null = null
	const factories: LinkBurstFactories = {
		createRecorder: () => recorder,
		createAbsorber: (_id, deps) => {
			const real = createBurstAbsorber({
				...deps,
				fanout: {
					distribute: () => {},
					activeBranchIds: out => deps.fanout.activeBranchIds(out),
					congestedBranchIds: out => {
						out.clear()
						for (const id of congested) out.add(id)
					},
					on: (event, listener) => {
						deps.fanout.on(event, listener)
						return undefined as never
					},
					off: (event, listener) => {
						deps.fanout.off(event, listener)
						return undefined as never
					},
				} as typeof deps.fanout,
				frameBytes: 2,
			})
			absorber = { ...real, configure: () => real.configure(128) }
			return absorber
		},
		monoNow: () => absMono,
	}
	const logger = pino({ level: "silent" })
	const primary = new FanoutManager(logger)
	const router = new SourceFanoutRouter(
		sources as unknown as SourceManager,
		primary,
		logger,
		"s",
		{ linkBurst: factories },
	)
	sources.emit("connected", "s")
	primary.addBranch({ id: "decoder-readsb" })
	primary.addBranch({ id: "live-demod-s" })
	expect(absorber).not.toBeNull()

	let mono = 0
	const cpu = { normalisedPercent: 10 }
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: id => router.branchDropCounters(id),
		topology: id => router.branchTopology(id),
		cpu,
		now: () => mono,
		monoNow: () => mono,
		setInterval: () => ({ cancel() {} }),
	})
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: 99 },
		{ drops: monitor },
	)
	const tick = () => {
		mono += 2_000
		gate.record(monitor.sampleNow())
	}
	for (let i = 0; i < 32; i++) tick()
	const running: RunningPlacement[] = []
	const placement: WantedPlacement = {
		key: "readsb",
		decoderId: "readsb",
		sourceId: "s",
		reach: "raw",
		channelHz: null,
		costCores: 0.1,
		origin: "band",
		primary: true,
		sampleRateHz: 2_048_000,
		tunedBand: true,
	}
	expect(gate.admit(placement, running, mono).admit).toBe(true)
	running.push({
		key: "readsb",
		sourceId: "s",
		reach: "raw",
		costCores: 0.1,
		sampleRateHz: 2_048_000,
		admittedAtMs: mono,
		mode: "auto",
		startMode: "auto",
		inputBranch: "decoder-readsb",
		tunedBand: true,
	})
	/** One sample with host-level CPU; returns the probation verdicts. */
	const sample = () => {
		cpu.normalisedPercent = 95
		tick()
		return gate.probation(running, mono)
	}
	return {
		absorber: absorber!,
		congested,
		primary,
		advance: (ms: number) => {
			absMono += ms
		},
		sample,
		monitor,
		close() {
			router.destroy()
			primary.destroy()
			stream.destroy()
		},
	}
}

it("overflow at a live-audio laggard's deadline is charged to live audio, not the source", () => {
	const h = harness()
	try {
		h.congested.add("live-demod-s")
		h.absorber.ingest(Buffer.alloc(128))
		// The laggard deadline (500 ms) expires at this ingest, before its
		// timer callback runs.
		h.advance(500)
		h.absorber.ingest(Buffer.alloc(4))
		expect(h.absorber.counters().overflowBytesTotal).toBe(4)
		expect(h.sample()).toEqual([])
		expect(h.monitor.chargedDropsBetweenMono("s", 0, Infinity)).toEqual([
			expect.objectContaining({ branches: ["live-demod-s"] }),
		])
	} finally {
		h.close()
	}
})

it("a re-created live-audio branch overflowing the same total is still charged to it", () => {
	const h = harness()
	try {
		h.congested.add("live-demod-s")
		// 200 bytes into 128: 72 lost while live audio holds.
		h.absorber.ingest(Buffer.alloc(200))
		expect(h.sample()).toEqual([])
		// Live audio is removed and re-created; its absorber total restarts.
		h.congested.clear()
		h.primary.removeBranch("live-demod-s")
		h.primary.addBranch({ id: "live-demod-s" })
		expect(h.absorber.counters().heldBytes).toBe(0)
		h.congested.add("live-demod-s")
		h.absorber.ingest(Buffer.alloc(200))
		expect(h.absorber.counters().overflowBytesTotal).toBe(144)
		expect(h.sample()).toEqual([])
		const charged = h.monitor.chargedDropsBetweenMono("s", 0, Infinity)
		expect(charged).toHaveLength(2)
		for (const drop of charged) expect(drop.branches).toEqual(["live-demod-s"])
	} finally {
		h.close()
	}
})

it("overflow held only by a live-audio branch removed before the sample is still charged to it: nobody is shed", () => {
	const h = harness()
	try {
		h.congested.add("live-demod-s")
		// 200 bytes into 128: 72 lost while live audio alone holds.
		h.absorber.ingest(Buffer.alloc(200))
		expect(h.absorber.counters().overflowBytesTotal).toBe(72)
		// The listener leaves before the monitor samples.
		h.congested.clear()
		h.primary.removeBranch("live-demod-s")
		expect(h.sample()).toEqual([])
		expect(h.monitor.chargedDropsBetweenMono("s", 0, Infinity)).toEqual([
			expect.objectContaining({ branches: ["live-demod-s"] }),
		])
	} finally {
		h.close()
	}
})

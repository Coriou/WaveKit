import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import pino from "pino"
import { expect, it, vi } from "vitest"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../../../src/core/source-fanout-router.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	AbsorberCounters,
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
 * Burst absorber overflow is charged to the branches that held the absorber
 * when it overflowed, read through the real source router's counters. One
 * network source "a" with readsb's own branch (`decoder-readsb`) and live
 * audio (`live-demod-a`, read by no placement). The absorber is a stand-in
 * whose overflow totals the test raises, with the branch holding it. The
 * monitor and the gate read one fake monotonic clock (`mono`); samples are
 * taken on it every 2000 ms.
 */
function harness(options: { tuned?: boolean } = {}) {
	const stream = new PassThrough()
	const sources = Object.assign(new EventEmitter(), {
		getAllStatus: () => [{ id: "a", connected: false }],
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
	let overflow = 0
	const gatedBy: Record<string, number> = {}
	const absorber = {
		configure: vi.fn(),
		ingest: vi.fn(),
		flush: vi.fn(),
		counters: () =>
			({
				overflowBytesTotal: overflow,
				overflowChunksTotal: overflow,
			}) as AbsorberCounters,
		overflowGatedBy: () => ({ ...gatedBy }),
		dispose: vi.fn(),
	}
	const factories: LinkBurstFactories = {
		createRecorder: () => recorder,
		createAbsorber: () => absorber,
		monoNow: () => 0,
	}
	const logger = pino({ level: "silent" })
	const primary = new FanoutManager(logger)
	const router = new SourceFanoutRouter(
		sources as unknown as SourceManager,
		primary,
		logger,
		"a",
		{ linkBurst: factories },
	)
	sources.emit("connected", "a")
	primary.addBranch({ id: "decoder-readsb" })
	primary.addBranch({ id: "live-demod-a" })

	let mono = 0
	const cpu = { normalisedPercent: 10 }
	const monitor = createEfficiencyMonitor({
		sources: () => ["a"],
		branchCounters: id => router.branchDropCounters(id),
		topology: id => router.branchTopology(id),
		cpu,
		now: () => mono,
		monoNow: () => mono,
		setInterval: () => ({ cancel() {} }),
	})
	// The gate's CPU guard is above the monitor's 90 %: CPU between them makes
	// overflow host loss without CPU loss of its own.
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: 99 },
		{ drops: monitor },
	)
	const tick = () => {
		mono += 2_000
		gate.record(monitor.sampleNow())
	}
	const running: RunningPlacement[] = []
	const admit = (key: string, tuned: boolean) => {
		const placement: WantedPlacement = {
			key,
			decoderId: key,
			sourceId: "a",
			reach: "raw",
			channelHz: null,
			costCores: 0.1,
			origin: "band",
			primary: true,
			sampleRateHz: 2_048_000,
			...(tuned ? { tunedBand: true as const } : {}),
		}
		expect(gate.admit(placement, running, mono).admit).toBe(true)
		running.push({
			key,
			sourceId: "a",
			reach: "raw",
			costCores: 0.1,
			sampleRateHz: placement.sampleRateHz,
			admittedAtMs: mono,
			mode: "auto",
			startMode: "auto",
			inputBranch: `decoder-${key}`,
			...(tuned ? { tunedBand: true as const } : {}),
		})
	}
	for (let i = 0; i < 32; i++) tick()
	admit("readsb", options.tuned === true)
	// Graduate (17 samples = 34 s > 30 s) unless the test needs a probationer.
	if (!options.tuned)
		for (let i = 0; i < 17; i++) {
			tick()
			expect(gate.probation(running, mono)).toEqual([])
		}
	/** Overflow while `holder` holds the absorber, every sample for `ms`. */
	const overflowFor = (holder: string | null, ms: number) => {
		cpu.normalisedPercent = 95
		const verdicts: { key: string; detail: string }[] = []
		for (let t = 0; t < ms; t += 2_000) {
			overflow++
			if (holder !== null) gatedBy[holder] = (gatedBy[holder] ?? 0) + 1
			tick()
			for (const verdict of gate.probation(running, mono)) {
				verdicts.push(verdict)
				running.splice(
					running.findIndex(p => p.key === verdict.key),
					1,
				)
				gate.forget(verdict.key)
			}
		}
		return verdicts
	}
	return {
		overflowFor,
		monitor,
		close() {
			router.destroy()
			primary.destroy()
			stream.destroy()
		},
	}
}

it("overflow held by a congested live audio branch leaves readsb untouched", () => {
	const h = harness()
	try {
		expect(h.overflowFor("live-demod-a", 120_000)).toEqual([])
		expect(h.monitor.latestAttribution("a")).toBe("host")
		expect(h.monitor.lateWindows("a").at(-1)).toMatchObject({
			condemning: true,
			condemnedBranches: ["live-demod-a"],
		})
	} finally {
		h.close()
	}
})

it("overflow held by readsb's own congested branch is charged to readsb", () => {
	const h = harness()
	try {
		expect(h.overflowFor("decoder-readsb", 40_000)[0]).toEqual({
			key: "readsb",
			detail: "late-drops",
		})
		expect(h.monitor.lateWindows("a").at(-1)).toMatchObject({
			condemning: true,
			condemnedBranches: ["decoder-readsb"],
		})
	} finally {
		h.close()
	}
})

it("overflow with no holding branch known still condemns the whole source", () => {
	const h = harness()
	try {
		expect(h.overflowFor(null, 40_000)[0]).toEqual({
			key: "readsb",
			detail: "late-drops",
		})
		expect(h.monitor.lateWindows("a").at(-1)).toMatchObject({
			condemnedBranches: "source",
		})
	} finally {
		h.close()
	}
})

it("a tuned probationer is judged by overflow its own branch held, not live audio's", () => {
	const live = harness({ tuned: true })
	try {
		expect(live.overflowFor("live-demod-a", 20_000)).toEqual([])
	} finally {
		live.close()
	}
	const own = harness({ tuned: true })
	try {
		expect(own.overflowFor("decoder-readsb", 20_000)).toEqual([
			{ key: "readsb", detail: "drops" },
		])
	} finally {
		own.close()
	}
})

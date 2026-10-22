import type { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import fc from "fast-check"
import { SourceManager } from "../../../src/core/source-manager.js"
import { SourceFanoutRouter } from "../../../src/core/source-fanout-router.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { createLogger } from "../../../src/utils/logger.js"
import { createEfficiencyMonitor } from "../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../src/decoders/enablement/efficiency-gate.js"
import type {
	RunningPlacement,
	WantedPlacement,
} from "../../../src/decoders/enablement/contract.js"

const transport = vi.hoisted(() => ({ sockets: [] as EventEmitter[] }))
vi.mock("node:net", async () => {
	const { EventEmitter: Base } = await import("node:events")
	return {
		Socket: class extends Base {
			constructor() {
				super()
				transport.sockets.push(this)
			}
			connect() {}
			setTimeout() {}
			setKeepAlive() {}
			pause() {}
			resume() {}
			isPaused() {
				return false
			}
			destroy() {
				this.emit("close")
			}
		},
	}
})
afterEach(() => {
	vi.useRealTimers()
	transport.sockets = []
})
const placement: WantedPlacement = {
	key: "decoder#raw@s",
	decoderId: "decoder",
	sourceId: "s",
	reach: "raw",
	costCores: 0.1,
	sampleRateHz: 2048000,
	channelHz: null,
	origin: "band",
	primary: true,
}
const running: RunningPlacement = {
	...placement,
	admittedAtMs: 0,
	mode: "auto",
	startMode: "auto",
}

async function scenario(graduated: boolean, outage: number, phase: number) {
	vi.useFakeTimers()
	const log = createLogger({ level: "fatal" })
	const sources = new SourceManager(log)
	const fanout = new FanoutManager(log)
	const router = new SourceFanoutRouter(sources, fanout, log, "s")
	let dropped = 0
	let branch = "original"
	// Counter injection models a slow consumer independently of the transport fake.
	const monitor = createEfficiencyMonitor({
		sourceEvents: sources,
		sources: () => sources.getAllStatus().map(s => s.id),
		branchCounters: () =>
			new Map([
				[branch, { droppedBytesTotal: dropped, droppedChunksTotal: dropped }],
				["sibling", { droppedBytesTotal: 0, droppedChunksTotal: 0 }],
			]),
		topology: () => branch,
		attributionApplies: () => true,
		ingest: () => ({ maxGapMs: 0, catchupBytes: 0, chunks: 1 }),
		loopDelay: () => ({ maxMs: 0, p99Ms: 0 }),
		shortfall: () => false,
		cpu: { normalisedPercent: 1 },
		now: Date.now,
		monoNow: () => performance.now(),
		setInterval: () => ({ cancel() {} }),
	})
	monitor.start()
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: 90 },
		{ drops: monitor },
	)
	const payload = () => {
		const header = Buffer.alloc(12)
		header.write("RTL0")
		transport.sockets
			.at(-1)!
			.emit("data", Buffer.concat([header, Buffer.alloc(32, 128)]))
	}
	const sample = () => {
		gate.record(monitor.sampleNow())
	}
	const advance = async (ms: number) => {
		await vi.advanceTimersByTimeAsync(ms)
		sample()
	}
	try {
		const connecting = sources.connect({
			id: "s",
			type: "rtl_tcp",
			host: "test.invalid",
			port: 1234,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: 2048000,
				exclusive: false,
			},
		})
		transport.sockets.at(-1)!.emit("connect")
		await connecting
		payload()
		sample()
		for (let i = 0; i < 33; i++) {
			payload()
			await advance(2000)
		}
		expect(gate.admit(placement, [], Date.now()).admit).toBe(true)
		for (let i = 0; i < (graduated ? 16 : 3); i++) {
			payload()
			await advance(2000)
			expect(gate.probation([running], Date.now())).toEqual([])
		}
		expect(
			gate.view([running], [], Date.now()).sources[0]!.admitted[0]!.probation,
		).toBe(!graduated)
		await vi.advanceTimersByTimeAsync(phase)
		transport.sockets.at(-1)!.emit("close")
		// During the absence of the process/branch, retain the logical admission.
		dropped += 10
		branch = "recreated"
		sample()
		expect(gate.probation([], Date.now())).toEqual([])
		expect(monitor.coveredSinceMono("s", 0)).toBe(0)
		expect(monitor.lateWindows("s")).toEqual([])
		expect(gate.admit({ ...placement, key: "new" }, [], Date.now()).admit).toBe(
			false,
		)
		await advance(outage + 4001)
		expect(transport.sockets.length).toBeGreaterThanOrEqual(2)
		const next = transport.sockets.at(-1)!
		next.emit("connect")
		expect(sources.getStatus("s")?.connected).toBe(true)
		// A TCP connection without payload is not delivery.
		await advance(2000)
		expect(monitor.coveredSinceMono("s", 0)).toBe(0)
		payload()
		expect(gate.admit(placement, [], Date.now()).admit).toBe(true)
		expect(gate.probation([running], Date.now())).toEqual([])
		dropped += 20
		await advance(2000)
		expect(monitor.coveredSinceMono("s", 0)).toBe(0)
		expect(monitor.droppedSinceMono("s", 0)).toBe(false)
		expect(gate.probation([running], Date.now())).toEqual([])
		expect(
			gate.admit({ ...placement, key: "new" }, [running], Date.now()).admit,
		).toBe(false)
		await advance(1) // First post-settle read only establishes fresh baselines.
		await advance(2000)
		expect(
			gate.view([running], [], Date.now()).sources[0]!.admitted[0]!.probation,
		).toBe(!graduated)
		if (!graduated) {
			dropped++
			payload()
			await advance(2000)
			expect(
				monitor.latestAttribution("s"),
				JSON.stringify(sources.getStatus("s")),
			).toBe("consumer")
			expect(gate.probation([running], Date.now())).toEqual([
				{ key: placement.key, detail: "drops" },
			])
		} else {
			expect(
				gate.view([running], [], Date.now()).sources[0]!.lateDrops!.sheddable,
			).toBe(1)
			let shed = false
			for (let i = 0; i < 20 && !shed; i++) {
				dropped++
				payload()
				await advance(2000)
				const verdict = gate.probation([running], Date.now())
				if (verdict.length) {
					expect(verdict).toEqual([
						{ key: placement.key, detail: "late-drops" },
					])
					shed = true
				}
			}
			expect(shed).toBe(true)
		}
	} finally {
		monitor.stop()
		router.destroy()
		fanout.destroy()
		await sources.disconnectAll()
		vi.useRealTimers()
	}
}

it("keeps graduation through source reconnect and still sheds subsequent consumer drops", async () => {
	await scenario(true, 4000, 731)
})
it("neither credits nor condemns a probationer for reconnect drops", async () => {
	await scenario(false, 4000, 731)
})
// Feature: link-burst-resilience, Property 10: Late shed
// Validates: Requirements 5.1, 5.2, 5.4; decoder-enablement 4.4, 4.6
it("isolates reconnect loss at arbitrary outage lengths and monitor phases", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.boolean(),
			fc.integer({ min: 1, max: 5000 }),
			fc.integer({ min: 0, max: 1999 }),
			scenario,
		),
		{ numRuns: 100 },
	)
}, 20000)

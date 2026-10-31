/**
 * A paused receiver feed is no loss: across SourceManager.pause / resume the efficiency gate charges a
 * graduated placement no drops or late drops (so no shed and no loss backoff follows), the monitor
 * records no late windows, and the source schedules no reconnect backoff while paused.
 */
import type { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
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
			destroyed = false
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
			// The peer answers the pause's FIN at once.
			end() {
				this.destroy()
			}
			destroy() {
				if (this.destroyed) return
				this.destroyed = true
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
	inputBranch: "decoder-decoder",
	admittedAtMs: 0,
	mode: "auto",
	startMode: "auto",
}

it("charges no drops, late drops or reconnect backoff across a pause and resume", async () => {
	vi.useFakeTimers()
	const log = createLogger({ level: "fatal" })
	const sources = new SourceManager(log)
	const fanout = new FanoutManager(log)
	const router = new SourceFanoutRouter(sources, fanout, log, "s")
	let dropped = 0
	let branch = "original"
	const monitor = createEfficiencyMonitor({
		sourceEvents: sources,
		sources: () => sources.getAllStatus().map(s => s.id),
		branchCounters: () =>
			new Map([
				[
					`decoder-decoder#${branch}`,
					{ droppedBytesTotal: dropped, droppedChunksTotal: dropped },
				],
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
	const advance = async (ms: number) => {
		await vi.advanceTimersByTimeAsync(ms)
		gate.record(monitor.sampleNow())
	}
	const charged = () => {
		const view = gate.view([running], [], Date.now()).sources[0]
		return {
			probation: gate.probation([running], Date.now()),
			graduatedStill: view?.admitted[0]?.probation === false,
			lateWindows: view?.lateDrops?.windows ?? 0,
			condemning: view?.lateDrops?.condemningWindows ?? 0,
		}
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
		gate.record(monitor.sampleNow())
		for (let i = 0; i < 33; i++) {
			payload()
			await advance(2000)
		}
		expect(gate.admit(placement, [], Date.now()).admit).toBe(true)
		// Graduate the placement (16 clean samples).
		for (let i = 0; i < 16; i++) {
			payload()
			await advance(2000)
		}
		expect(charged()).toEqual({
			probation: [],
			graduatedStill: true,
			lateWindows: 0,
			condemning: 0,
		})

		await sources.pause("s")
		const socketsAtPause = transport.sockets.length
		// The decoder's branch is torn down while paused; its counters restart under a new instance.
		dropped += 10
		branch = "recreated"
		// Far past the longest reconnect backoff (30 s), sampled throughout.
		for (let i = 0; i < 60; i++) await advance(2000)
		expect(transport.sockets.length).toBe(socketsAtPause)
		expect(sources.getStatus("s")).toMatchObject({
			connected: false,
			reconnectAttempts: 0,
			feed: { state: "paused" },
		})
		expect(monitor.lateWindows("s")).toEqual([])
		expect(monitor.droppedSinceMono("s", 0)).toBe(false)
		expect(charged()).toEqual({
			probation: [],
			graduatedStill: true,
			lateWindows: 0,
			condemning: 0,
		})

		const resuming = sources.resume("s")
		// Exactly one connection attempt, no backoff (the timers do not move).
		await vi.advanceTimersByTimeAsync(0)
		expect(transport.sockets.length).toBe(socketsAtPause + 1)
		transport.sockets.at(-1)!.emit("connect")
		expect(await resuming).toMatchObject({ feed: { state: "live" } })
		payload()
		// Whatever the recreated branch dropped while the feed came back is reconnect loss, not the decoder's.
		dropped += 20
		for (let i = 0; i < 5; i++) {
			payload()
			await advance(2000)
		}
		expect(monitor.lateWindows("s")).toEqual([])
		expect(charged()).toEqual({
			probation: [],
			graduatedStill: true,
			lateWindows: 0,
			condemning: 0,
		})
		expect(sources.getStatus("s")?.reconnectAttempts).toBe(0)
	} finally {
		monitor.stop()
		router.destroy()
		fanout.destroy()
		await sources.disconnectAll()
		vi.useRealTimers()
	}
})

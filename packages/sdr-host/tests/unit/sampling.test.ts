import { describe, it, expect, beforeEach } from "vitest"
import {
	MIN_EVIDENCE_BYTES,
	SamplingMonitor,
	type RtlmuxStatsSnapshot,
} from "../../src/telemetry/sampling.js"

const RATE = 2_048_000
const EXPECTED = RATE * 2
const MUX = 200
const TCP = 100

function stats(
	dataIn: number,
	clients: Array<{
		host?: string
		port?: number
		dataIn?: number
		dataOut?: number
		dropped?: number
		chunks?: number
		connected?: number
	}> = [],
): RtlmuxStatsSnapshot {
	return {
		server: { dataIn, dataOut: 0 },
		clients: clients.map(client => ({
			client: {
				host: client.host ?? "::ffff:192.168.1.10",
				port: client.port ?? 50000,
			},
			dataIn: client.dataIn ?? 0,
			dataOut: client.dataOut ?? 0,
			dropped: { size: client.dropped ?? 0, count: client.chunks ?? 0 },
			connected: client.connected ?? 1_700_000_000,
		})),
	}
}

describe("SamplingMonitor", () => {
	let mono: number
	let wall: number
	let monitor: SamplingMonitor
	let dataIn: number

	/** One 2 s poll: processes, then (optionally) a stats observation. */
	const poll = (
		bytes: number | null,
		clients: Parameters<typeof stats>[1] = [],
		pid = MUX,
		tcp = TCP,
	): void => {
		mono += 2000
		wall += 2000
		monitor.observeProcesses(pid, tcp)
		if (bytes === null) {
			monitor.observeFailure("timeout")
			return
		}
		dataIn += bytes
		monitor.observeStats(stats(dataIn, clients), pid)
	}
	const flowing = EXPECTED * 2

	beforeEach(() => {
		mono = 1_000
		wall = 1_700_000_000_000
		dataIn = 0
		monitor = new SamplingMonitor({
			sampleRate: RATE,
			now: () => mono,
			wallNow: () => wall,
		})
		monitor.observeProcesses(MUX, TCP)
	})

	it("reports streaming with zero downstream clients while upstream grows", () => {
		for (let i = 0; i < 4; i++) poll(flowing)
		const sampling = monitor.sampling()
		expect(sampling.state).toBe("streaming")
		expect(sampling.upstream.bytesPerSec).toBeCloseTo(EXPECTED, -3)
		expect(sampling.upstream.rateStatus).toBe("nominal")
		expect(monitor.delivery().state).toBe("idle")
	})

	it("goes stale when stats keep arriving but the upstream counter is frozen", () => {
		for (let i = 0; i < 3; i++) poll(flowing)
		expect(monitor.sampling().state).toBe("streaming")
		for (let i = 0; i < 4; i++) poll(0)
		expect(monitor.sampling().state).toBe("streaming")
		poll(0)
		const sampling = monitor.sampling()
		expect(sampling.state).toBe("stale")
		expect(sampling.reason).toBe("upstream byte count stopped growing")
		expect(sampling.stats.state).toBe("ok")
	})

	it("never treats header-sized or sub-threshold growth as sample evidence", () => {
		poll(0)
		for (let i = 0; i < 6; i++) poll(i % 2 === 0 ? 12 : MIN_EVIDENCE_BYTES - 1)
		const sampling = monitor.sampling()
		expect(sampling.state).toBe("stale")
		expect(sampling.reason).toBe("no samples since receiver start")
		expect(sampling.lastSampleAt).toBeNull()
	})

	it("waits during start-up instead of reporting unknown", () => {
		const fresh = new SamplingMonitor({
			sampleRate: RATE,
			now: () => mono,
			wallNow: () => wall,
		})
		fresh.observeProcesses(MUX, TCP)
		expect(fresh.sampling().state).toBe("waiting")
		mono += 10_001
		expect(fresh.sampling().state).toBe("unknown")
	})

	it("expires stats: ok, then stale, then unknown sampling and dropped values", () => {
		for (let i = 0; i < 3; i++) poll(flowing)
		for (let i = 0; i < 3; i++) poll(null)
		expect(monitor.sampling().stats.state).toBe("ok")
		poll(null)
		expect(monitor.sampling().stats.state).toBe("stale")
		expect(monitor.sampling().state).toBe("streaming")
		poll(null)
		poll(null)
		const unknown = monitor.sampling()
		expect(unknown.state).toBe("unknown")
		expect(unknown.reason).toBe("rtlmux stats timeout")
		expect(unknown.upstream.bytesTotal).not.toBeNull()
		for (let i = 0; i < 10; i++) poll(null)
		const expired = monitor.sampling()
		expect(expired.stats.state).toBe("unavailable")
		expect(expired.upstream.bytesTotal).toBeNull()
		expect(expired.upstream.bytesPerSec).toBeNull()
		expect(monitor.delivery().state).toBe("unknown")
	})

	it("starts a new epoch on rtlmux restart without negative or inflated rates", () => {
		for (let i = 0; i < 4; i++) poll(flowing)
		dataIn = 0
		poll(flowing, [], MUX + 1)
		let sampling = monitor.sampling()
		expect(sampling.state).toBe("waiting")
		expect(sampling.epoch).toMatchObject({
			rtlmuxPid: MUX + 1,
			resets: 1,
			lastResetReason: "rtlmux-restart",
		})
		expect(sampling.upstream.bytesPerSec).toBeNull()
		for (let i = 0; i < 3; i++) poll(flowing, [], MUX + 1)
		sampling = monitor.sampling()
		expect(sampling.state).toBe("streaming")
		expect(sampling.upstream.bytesPerSec).toBeCloseTo(EXPECTED, -3)
	})

	it("starts a new epoch when the counter decreases under the same PID", () => {
		for (let i = 0; i < 3; i++) poll(flowing)
		dataIn = 1000
		poll(0)
		const sampling = monitor.sampling()
		expect(sampling.epoch.lastResetReason).toBe("counter-decrease")
		expect(sampling.state).toBe("waiting")
		expect(
			monitor.recentHistory().every(([, rate]) => rate === null || rate >= 0),
		).toBe(true)
	})

	it("re-earns evidence after an rtl_tcp restart but keeps the counter baseline", () => {
		for (let i = 0; i < 3; i++) poll(flowing)
		poll(0, [], MUX, TCP + 1)
		let sampling = monitor.sampling()
		expect(sampling.state).toBe("waiting")
		expect(sampling.lastSampleAt).toBeNull()
		expect(sampling.epoch.resets).toBe(0)
		// rtl_tcp holding a dead USB handle never produces evidence.
		for (let i = 0; i < 5; i++) poll(0, [], MUX, TCP + 1)
		expect(monitor.sampling().state).toBe("stale")
		poll(flowing, [], MUX, TCP + 1)
		sampling = monitor.sampling()
		expect(sampling.state).toBe("streaming")
		expect(sampling.epoch.rtlTcpPid).toBe(TCP + 1)
	})

	it("reports disconnected when a supervised process is gone", () => {
		poll(flowing)
		monitor.observeProcesses(MUX, undefined)
		expect(monitor.sampling()).toMatchObject({
			state: "disconnected",
			reason: "rtl_tcp not running",
		})
		monitor.observeProcesses(undefined, undefined)
		expect(monitor.sampling()).toMatchObject({
			state: "disconnected",
			reason: "rtlmux not running",
		})
	})

	it("flags a sustained low rate, and stops judging once a client controls the tuner", () => {
		for (let i = 0; i < 6; i++) poll(EXPECTED)
		expect(monitor.sampling().upstream.rateStatus).toBe("low")
		poll(EXPECTED, [{ dataIn: 5 }])
		const sampling = monitor.sampling()
		expect(sampling.upstream.rateBasis).toBe("client-controlled")
		expect(sampling.upstream.expectedBytesPerSec).toBeNull()
		expect(sampling.upstream.rateStatus).toBe("unknown")
	})

	it("is unaffected by wall-clock jumps (no RTC before NTP sync)", () => {
		for (let i = 0; i < 3; i++) poll(flowing)
		wall += 3_600_000
		poll(flowing)
		wall -= 7_200_000
		poll(flowing)
		const sampling = monitor.sampling()
		expect(sampling.state).toBe("streaming")
		expect(sampling.upstream.bytesPerSec).toBeCloseTo(EXPECTED, -3)
	})

	it("keeps departed clients' drops, ignores first-seen counters, and keys port reuse separately", () => {
		poll(flowing, [{ dataOut: 1_000_000, dropped: 999_999, chunks: 9 }])
		expect(monitor.delivery().droppedBytesSinceMonitorStart).toBe(0)
		poll(flowing, [
			{ dataOut: 9_000_000, dropped: 999_999 + 65_536, chunks: 10 },
		])
		let delivery = monitor.delivery()
		expect(delivery.state).toBe("dropping")
		expect(delivery.clients[0]).toMatchObject({
			address: "192.168.1.10:50000",
			queuedBytesPerSec: 4_000_000,
		})
		expect(delivery.droppedBytesLast60s).toBe(65_536)
		// Client leaves; a new connection reuses the port with a later connect time.
		poll(flowing, [{ dataOut: 10, connected: 1_700_000_100 }])
		delivery = monitor.delivery()
		expect(delivery.clients).toHaveLength(1)
		expect(delivery.clients[0]?.queuedBytesPerSec).toBeNull()
		expect(delivery.droppedBytesLast60s).toBe(65_536)
		const legacy = monitor.legacyStats()
		expect(legacy).toMatchObject({
			clients: 1,
			bytesPerSec: 0,
			totalBytesSent: 10,
		})
		for (let i = 0; i < 31; i++)
			poll(flowing, [{ dataOut: 10 + i, connected: 1_700_000_100 }])
		delivery = monitor.delivery()
		expect(delivery.droppedBytesLast60s).toBe(0)
		expect(delivery.droppedBytesSinceMonitorStart).toBe(65_536)
		expect(delivery.state).toBe("delivering")
	})

	it("reaches stale for a crash-looping rtl_tcp instead of waiting forever", () => {
		// s6 restarts a receiver that cannot open the dongle about every second.
		for (let i = 0; i < 60; i++) poll(0, [], MUX, TCP + 1 + i)
		expect(monitor.sampling()).toMatchObject({
			state: "stale",
			reason: "no samples since receiver start",
		})
	})

	it("never credits the old rtl_tcp's bytes to its replacement", () => {
		for (let i = 0; i < 3; i++) poll(flowing)
		// The old instance delivered a last burst, then a silent replacement starts.
		dataIn += flowing
		poll(0, [], MUX, TCP + 1)
		for (let i = 0; i < 5; i++) {
			poll(0, [], MUX, TCP + 1)
			expect(monitor.sampling().state).not.toBe("streaming")
		}
		expect(monitor.sampling().state).toBe("stale")
	})

	it("does not count growth across an observation gap as current evidence", () => {
		poll(0)
		for (let i = 0; i < 30; i++) poll(null)
		// A brief trickle during the 60 s outage, then the upstream stalls.
		dataIn += 100_000
		poll(0)
		expect(monitor.sampling().state).not.toBe("streaming")
		expect(monitor.recentHistory().at(-1)?.[1]).toBeNull()
	})

	it("keeps the start-up grace after a restart that followed real samples", () => {
		for (let i = 0; i < 3; i++) poll(flowing)
		poll(0, [], MUX, TCP + 1)
		poll(0, [], MUX, TCP + 1)
		expect(monitor.sampling().state).toBe("waiting")
	})

	it("keeps a bounded five-minute history with explicit gaps", () => {
		for (let i = 0; i < 200; i++) {
			if (i % 50 === 0) {
				// The fetch failed, but upstream kept growing meanwhile.
				poll(null)
				dataIn += flowing
			} else {
				poll(flowing)
			}
		}
		const history = monitor.recentHistory()
		expect(history.length).toBeLessThanOrEqual(151)
		expect(Math.max(...history.map(([age]) => age))).toBeLessThanOrEqual(
			300_000,
		)
		expect(history.some(([, rate]) => rate === null)).toBe(true)
		expect(
			history
				.filter(([, rate]) => rate !== null)
				.every(([, rate]) => Math.abs((rate ?? 0) - flowing / 2) < 1),
		).toBe(true)
	})
})

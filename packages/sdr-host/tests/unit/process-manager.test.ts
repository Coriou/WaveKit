import { describe, it, expect, vi, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { createLogger } from "@wavekit/shared"
import { SdrHostConfigSchema } from "../../src/config.js"
import { ProcessManager } from "../../src/supervisor/process-manager.js"

function writeProc(procRoot: string, pid: number, name: string): void {
	const dir = path.join(procRoot, pid.toString())
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, "comm"), `${name}\n`, "utf8")
	fs.writeFileSync(path.join(dir, "cmdline"), `${name}\0`, "utf8")
}

describe("ProcessManager", () => {
	const logger = createLogger({ level: "fatal" })
	let procRoot: string | null = null

	afterEach(() => {
		if (procRoot) {
			fs.rmSync(procRoot, { recursive: true, force: true })
			procRoot = null
		}
		vi.useRealTimers()
	})

	it("tracks restarts based on process lifecycle", () => {
		vi.useFakeTimers()
		procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdr-host-proc-"))

		writeProc(procRoot, 100, "rtl_tcp")
		writeProc(procRoot, 200, "rtlmux")

		let now = 1_700_000_000_000
		const config = SdrHostConfigSchema.parse({})
		const manager = new ProcessManager(config, logger, {
			procRoot,
			now: () => now,
			wallNow: () => now,
			processPollIntervalMs: 1000,
			statsPollIntervalMs: 100000,
			fetchFn: vi.fn(async () => ({ ok: false })) as unknown as typeof fetch,
		})

		manager.startMonitoring()

		let state = manager.getRtlTcpState()
		expect(state.running).toBe(true)
		expect(state.pid).toBe(100)
		expect(state.restartCount).toBe(0)

		fs.rmSync(path.join(procRoot, "100"), { recursive: true, force: true })
		writeProc(procRoot, 300, "rtl_tcp")
		now += 5000
		vi.advanceTimersByTime(1000)

		state = manager.getRtlTcpState()
		expect(state.running).toBe(true)
		expect(state.pid).toBe(300)
		expect(state.restartCount).toBe(1)
		expect(state.lastRestartAt?.toISOString()).toBe(new Date(now).toISOString())

		fs.rmSync(path.join(procRoot, "300"), { recursive: true, force: true })
		vi.advanceTimersByTime(1000)

		state = manager.getRtlTcpState()
		expect(state.running).toBe(false)
		expect(state.lastError).toBe("rtl_tcp not running")

		void manager.shutdown()
	})
})

it("does not mistake s6 supervisors or arguments mentioning a service for the service", async () => {
	const procRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "sdr-host-supervisor-"),
	)
	const logger = createLogger({ level: "fatal" })
	const manager = new ProcessManager(SdrHostConfigSchema.parse({}), logger, {
		procRoot,
	})
	try {
		writeProc(procRoot, 10, "s6-supervise")
		fs.writeFileSync(
			path.join(procRoot, "10", "cmdline"),
			"/command/s6-supervise\0rtlmux\0",
		)
		writeProc(procRoot, 20, "sh")
		fs.writeFileSync(
			path.join(procRoot, "20", "cmdline"),
			"/bin/sh\0-c\0rtl_tcp -a 0.0.0.0\0",
		)
		writeProc(procRoot, 30, "rtlmux-backup")
		manager.startMonitoring()
		expect(manager.getRtlmuxState().running).toBe(false)
		expect(manager.getRtlTcpState().running).toBe(false)
	} finally {
		await manager.shutdown()
		fs.rmSync(procRoot, { recursive: true, force: true })
	}
})

it("matches an executable path in argv[0] when comm cannot be read", async () => {
	const procRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "sdr-host-executable-"),
	)
	const logger = createLogger({ level: "fatal" })
	const manager = new ProcessManager(SdrHostConfigSchema.parse({}), logger, {
		procRoot,
	})
	try {
		writeProc(procRoot, 10, "s6-supervise")
		fs.writeFileSync(
			path.join(procRoot, "10", "cmdline"),
			"/command/s6-supervise\0rtlmux\0",
		)
		writeProc(procRoot, 200, "rtlmux")
		fs.rmSync(path.join(procRoot, "200", "comm"))
		fs.writeFileSync(
			path.join(procRoot, "200", "cmdline"),
			"/usr/local/bin/rtlmux\0--listen\0:5555\0",
		)
		manager.startMonitoring()
		expect(manager.getRtlmuxState().pid).toBe(200)
	} finally {
		await manager.shutdown()
		fs.rmSync(procRoot, { recursive: true, force: true })
	}
})

it("normalizes canonical rtlmux client arrays and derives byte throughput", async () => {
	vi.useFakeTimers()
	const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdr-host-stats-"))
	const logger = createLogger({ level: "fatal" })
	writeProc(procRoot, 200, "rtlmux")
	let now = 0
	let clients = [
		{
			client: { host: "192.168.1.10", port: 50000 },
			dataOut: 1000,
			dropped: { size: 64, count: 1 },
		},
	]
	const manager = new ProcessManager(SdrHostConfigSchema.parse({}), logger, {
		procRoot,
		now: () => now,
		fetchFn: vi.fn(
			async () =>
				new Response(
					JSON.stringify({ server: { dataIn: 1000, dataOut: 5 }, clients }),
				),
		) as unknown as typeof fetch,
		statsPollIntervalMs: 1000,
	})
	try {
		manager.startMonitoring()
		now = 1000
		await vi.advanceTimersByTimeAsync(1000)
		expect(manager.getRtlmuxStats()).toEqual({
			clients: 1,
			bytesPerSec: 0,
			totalBytesSent: 1000,
			clientDetails: [
				{ id: 0, address: "192.168.1.10:50000", bytesDropped: 64 },
			],
		})
		clients[0]!.dataOut = 3000
		now = 2000
		await vi.advanceTimersByTimeAsync(1000)
		expect(manager.getRtlmuxStats()).toMatchObject({
			clients: 1,
			bytesPerSec: 2000,
			totalBytesSent: 3000,
		})
		clients = []
		now = 3000
		await vi.advanceTimersByTimeAsync(1000)
		expect(manager.getRtlmuxStats()).toEqual({
			clients: 0,
			bytesPerSec: 0,
			totalBytesSent: 0,
			clientDetails: [],
		})
	} finally {
		await manager.shutdown()
		fs.rmSync(procRoot, { recursive: true, force: true })
		vi.useRealTimers()
	}
})

describe("ProcessManager rtlmux stats polling", () => {
	it("aborts a hung stats request and never overlaps polls", async () => {
		vi.useFakeTimers()
		const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdr-host-hung-"))
		writeProc(procRoot, 100, "rtl_tcp")
		writeProc(procRoot, 200, "rtlmux")
		let inFlight = 0
		let maxInFlight = 0
		let calls = 0
		const fetchFn = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					calls += 1
					inFlight += 1
					maxInFlight = Math.max(maxInFlight, inFlight)
					init?.signal?.addEventListener("abort", () => {
						inFlight -= 1
						reject(new DOMException("aborted", "AbortError"))
					})
				}),
		)
		let now = 0
		const manager = new ProcessManager(
			SdrHostConfigSchema.parse({}),
			createLogger({ level: "fatal" }),
			{
				procRoot,
				now: () => now,
				fetchFn: fetchFn as unknown as typeof fetch,
				statsPollIntervalMs: 2000,
				statsTimeoutMs: 1500,
				processPollIntervalMs: 100_000,
			},
		)
		try {
			manager.startMonitoring()
			for (let i = 0; i < 20; i++) {
				now += 500
				await vi.advanceTimersByTimeAsync(500)
			}
			expect(maxInFlight).toBe(1)
			// 10 s at a 2 s start-to-start cadence: about five polls, not more.
			expect(calls).toBeGreaterThanOrEqual(4)
			expect(calls).toBeLessThanOrEqual(5)
			expect(manager.getSampling().stats.lastError).toBe("timeout")
			expect(manager.getSampling().state).toBe("unknown")
		} finally {
			await vi.advanceTimersByTimeAsync(2000)
			await manager.shutdown()
			fs.rmSync(procRoot, { recursive: true, force: true })
			vi.useRealTimers()
		}
	})

	it("discards a sample when rtlmux restarts during the request", async () => {
		vi.useFakeTimers()
		const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdr-host-race-"))
		writeProc(procRoot, 100, "rtl_tcp")
		writeProc(procRoot, 200, "rtlmux")
		let now = 0
		const fetchFn = vi.fn(async () => {
			// rtlmux 200 exits while its stats are in flight.
			fs.rmSync(path.join(procRoot, "200"), { recursive: true, force: true })
			writeProc(procRoot, 201, "rtlmux")
			return new Response(
				JSON.stringify({ server: { dataIn: 9e9, dataOut: 0 }, clients: [] }),
			)
		})
		const manager = new ProcessManager(
			SdrHostConfigSchema.parse({}),
			createLogger({ level: "fatal" }),
			{
				procRoot,
				now: () => now,
				fetchFn: fetchFn as unknown as typeof fetch,
				statsPollIntervalMs: 2000,
				processPollIntervalMs: 100_000,
			},
		)
		try {
			manager.startMonitoring()
			now += 2000
			await vi.advanceTimersByTimeAsync(2000)
			expect(fetchFn).toHaveBeenCalledTimes(1)
			expect(manager.getSampling().upstream.bytesTotal).toBeNull()
			expect(manager.getSampling().epoch.rtlmuxPid).toBeNull()
		} finally {
			await manager.shutdown()
			fs.rmSync(procRoot, { recursive: true, force: true })
			vi.useRealTimers()
		}
	})

	it("stops reading an oversized stats body at the cap", async () => {
		vi.useFakeTimers()
		const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdr-host-big-"))
		writeProc(procRoot, 100, "rtl_tcp")
		writeProc(procRoot, 200, "rtlmux")
		let pulled = 0
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1
				controller.enqueue(new Uint8Array(64 * 1024).fill(32))
			},
		})
		let now = 0
		const manager = new ProcessManager(
			SdrHostConfigSchema.parse({}),
			createLogger({ level: "fatal" }),
			{
				procRoot,
				now: () => now,
				fetchFn: vi.fn(
					async () => new Response(endless),
				) as unknown as typeof fetch,
				statsPollIntervalMs: 2000,
				processPollIntervalMs: 100_000,
			},
		)
		try {
			manager.startMonitoring()
			now += 2000
			await vi.advanceTimersByTimeAsync(2000)
			expect(manager.getSampling().stats.lastError).toBe("invalid")
			// 256 KiB cap: a handful of 64 KiB chunks, never the endless stream.
			expect(pulled).toBeLessThanOrEqual(8)
		} finally {
			await manager.shutdown()
			fs.rmSync(procRoot, { recursive: true, force: true })
			vi.useRealTimers()
		}
	})

	it("rejects malformed stats instead of caching them", async () => {
		vi.useFakeTimers()
		const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdr-host-invalid-"))
		writeProc(procRoot, 100, "rtl_tcp")
		writeProc(procRoot, 200, "rtlmux")
		let now = 0
		const manager = new ProcessManager(
			SdrHostConfigSchema.parse({}),
			createLogger({ level: "fatal" }),
			{
				procRoot,
				now: () => now,
				fetchFn: vi.fn(
					async () => new Response('{"clients":"x"}'),
				) as unknown as typeof fetch,
				statsPollIntervalMs: 2000,
				processPollIntervalMs: 100_000,
			},
		)
		try {
			manager.startMonitoring()
			now += 2000
			await vi.advanceTimersByTimeAsync(2000)
			expect(manager.getSampling().stats).toMatchObject({
				state: "unavailable",
				lastError: "invalid",
			})
			expect(manager.getRtlmuxStats().clients).toBe(0)
		} finally {
			await manager.shutdown()
			fs.rmSync(procRoot, { recursive: true, force: true })
			vi.useRealTimers()
		}
	})
})

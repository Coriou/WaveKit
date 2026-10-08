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
		fetchFn: vi.fn(async () => ({
			ok: true,
			json: async () => ({ server: { dataIn: 1000, dataOut: 5 }, clients }),
		})) as unknown as typeof fetch,
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

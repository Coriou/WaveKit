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

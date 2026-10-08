import { describe, it, expect, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { HostCollector } from "../../src/telemetry/host.js"
import { readSetupStatus } from "../../src/telemetry/setup-status.js"

const roots: string[] = []

function tree(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdr-host-tree-"))
	roots.push(root)
	for (const [file, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
		fs.writeFileSync(path.join(root, file), content)
	}
	return root
}

function write(root: string, file: string, content: string): void {
	fs.writeFileSync(path.join(root, file), content)
}

afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true })
})

const NET_DEV_HEADER =
	"Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n"
const netDev = (rx: number, tx: number): string =>
	`${NET_DEV_HEADER}  wlan0: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0\n    lo: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n`

function piTree(): { proc: string; sys: string } {
	const proc = tree({
		uptime: "7200.50 1000.00\n",
		loadavg: "0.42 0.50 0.61 1/200 999\n",
		meminfo:
			"MemTotal: 906000 kB\nMemAvailable: 500000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
		stat: "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 0\ncpu1 0\ncpu2 0\ncpu3 0\n",
		"1/stat": `1 (s6-svscan) S ${"0 ".repeat(18)}360000 0 0\n`,
		"self/cgroup": "0::/\n",
		"net/dev": netDev(1000, 1000),
		"net/wireless": "h1\nh2\n wlan0: 0000   58.  -52.  -256 0 0 0 0 0 0\n",
		"sys/kernel/random/boot_id": "boot-b\n",
	})
	const sys = tree({
		"fs/cgroup/memory.current": "52428800\n",
		"fs/cgroup/memory.max": "max\n",
		"fs/cgroup/cpu.stat": "usage_usec 1000000\n",
		"class/thermal/thermal_zone0/type": "cpu-thermal\n",
		"class/thermal/thermal_zone0/temp": "61234\n",
		"class/hwmon/hwmon0/name": "rpi_volt\n",
		"class/hwmon/hwmon0/in0_lcrit_alarm": "0\n",
		"class/net/wlan0/device/uevent": "",
		"class/net/wlan0/operstate": "up\n",
		"class/net/wlan0/type": "1\n",
		"class/net/wlan0/wireless/.keep": "",
		"class/net/veth1234/operstate": "up\n",
	})
	return { proc, sys }
}

describe("HostCollector", () => {
	it("reports host, container and storage readings with their scopes", () => {
		const { proc, sys } = piTree()
		let mono = 0
		const collector = new HostCollector({
			procRoot: proc,
			sysRoot: sys,
			statusDir: path.join(proc, "missing"),
			statfsPath: os.tmpdir(),
			networkInterfaces: () => ({
				wlan0: [
					{
						address: "192.0.2.23",
						family: "IPv4",
						internal: false,
					} as os.NetworkInterfaceInfo,
					{
						address: "fe80::1",
						family: "IPv6",
						internal: false,
					} as os.NetworkInterfaceInfo,
				],
			}),
			now: () => mono,
			wallNow: () => 1_700_000_000_000 + mono,
		})
		collector.collectAll()
		mono += 2000
		write(
			proc,
			"stat",
			"cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 0\ncpu1 0\ncpu2 0\ncpu3 0\n",
		)
		write(proc, "net/dev", netDev(1000 + 4_000, 1000 + 8_192_000))
		write(sys, "fs/cgroup/cpu.stat", "usage_usec 1400000\n")
		collector.collectAll()
		const t = collector.snapshot()

		expect(t.uptime).toMatchObject({
			state: "ok",
			scope: "host",
			value: { hostSec: 7201, containerSec: 3601 },
		})
		expect(t.cpu.value).toEqual({ busyPercent: 50, cores: 4, windowMs: 2000 })
		expect(t.load.value).toEqual({ one: 0.42, five: 0.5, fifteen: 0.61 })
		expect(t.memory.scope).toBe("host")
		expect(t.container).toMatchObject({
			scope: "container",
			value: { memoryBytes: 52428800, memoryLimitBytes: null, cpuPercent: 5 },
		})
		expect(t.disk).toMatchObject({ state: "ok", scope: "docker-storage" })
		expect(t.temperature.value).toEqual({ celsius: 61.2, zone: "cpu-thermal" })
		expect(t.network.value).toEqual([
			{
				name: "wlan0",
				kind: "wireless",
				operstate: "up",
				addresses: ["192.0.2.23"],
				rxBytesPerSec: 2000,
				txBytesPerSec: 4_096_000,
				wireless: { linkQuality: 58, signalDbm: -52 },
			},
		])
		expect(t.power.throttling).toMatchObject({
			state: "unavailable",
			value: null,
		})
		expect(t.power.throttling.reason).toMatch(/vcgencmd/)
		expect(t.setup).toMatchObject({
			state: "unavailable",
			reason: "not provided by this install",
		})
	})

	it("counts undervoltage rising edges as service-observed history, never since boot", () => {
		const { proc, sys } = piTree()
		let mono = 0
		const collector = new HostCollector({
			procRoot: proc,
			sysRoot: sys,
			statusDir: proc,
			statfsPath: os.tmpdir(),
			now: () => mono,
		})
		const alarm = path.join("class/hwmon/hwmon0/in0_lcrit_alarm")
		for (const value of ["0", "1", "1", "0", "1", "0"]) {
			write(sys, alarm, `${value}\n`)
			mono += 1000
			collector.collectAll()
		}
		const power = collector.snapshot().power
		expect(power.undervoltageNow).toMatchObject({
			state: "ok",
			scope: "host",
			value: false,
		})
		expect(power.undervoltageObserved.scope).toBe("service")
		expect(power.undervoltageObserved.value?.events).toBe(2)
		expect(power.undervoltageObserved.value?.lastAt).not.toBeNull()
	})

	it("marks everything unavailable, with reasons, when nothing is visible", () => {
		const collector = new HostCollector({
			procRoot: "/nonexistent/proc",
			sysRoot: "/nonexistent/sys",
			statusDir: "/nonexistent/status",
			statfsPath: "/nonexistent",
			networkInterfaces: () => ({}),
		})
		collector.collectAll()
		const t = collector.snapshot()
		for (const reading of [
			t.uptime,
			t.cpu,
			t.load,
			t.memory,
			t.container,
			t.disk,
			t.temperature,
			t.network,
			t.setup,
			t.power.undervoltageNow,
			t.power.undervoltageObserved,
		]) {
			expect(reading.state).toBe("unavailable")
			expect(reading.value).toBeNull()
			expect(reading.reason).toBeTruthy()
		}
		expect(t.network.reason).toBe("network interfaces not visible")
		expect(t.power.undervoltageNow.reason).toBe(
			"rpi_volt hwmon sensor not visible",
		)
	})

	it("does not claim host networking when only virtual interfaces are visible", () => {
		const { proc, sys } = piTree()
		fs.rmSync(path.join(sys, "class/net/wlan0"), { recursive: true })
		const collector = new HostCollector({
			procRoot: proc,
			sysRoot: sys,
			statusDir: proc,
			statfsPath: os.tmpdir(),
		})
		collector.collectAll()
		expect(collector.snapshot().network).toMatchObject({
			state: "unavailable",
			reason: "host network namespace not visible",
		})
	})

	it("ages readings to stale and then expires them", () => {
		const { proc, sys } = piTree()
		let mono = 0
		const collector = new HostCollector({
			procRoot: proc,
			sysRoot: sys,
			statusDir: proc,
			statfsPath: os.tmpdir(),
			now: () => mono,
		})
		collector.collectAll()
		mono += 6000
		expect(collector.snapshot().load.state).toBe("ok")
		mono += 1
		expect(collector.snapshot().load.state).toBe("stale")
		mono += 30_000
		expect(collector.snapshot().load).toMatchObject({
			state: "unavailable",
			value: null,
			reason: "expired",
		})
		// Disk is sampled every 30 s, so it stays fresh longer.
		expect(collector.snapshot().disk.state).toBe("ok")
	})

	it("resets network rates when interface counters go backwards", () => {
		const { proc, sys } = piTree()
		let mono = 0
		const collector = new HostCollector({
			procRoot: proc,
			sysRoot: sys,
			statusDir: proc,
			statfsPath: os.tmpdir(),
			now: () => mono,
		})
		write(proc, "net/dev", netDev(9_000_000, 9_000_000))
		collector.collectAll()
		mono += 2000
		write(proc, "net/dev", netDev(10, 10))
		collector.collectAll()
		expect(collector.snapshot().network.value?.[0]).toMatchObject({
			rxBytesPerSec: null,
			txBytesPerSec: null,
		})
	})
})

describe("readSetupStatus", () => {
	const record = (fields: Record<string, unknown>): string =>
		JSON.stringify({
			schema: 1,
			state: "running",
			phase: "install",
			updatedAt: "2026-10-08T10:00:00+00:00",
			bootId: "boot-a",
			exitCode: null,
			...fields,
		})

	it("reports progress, completion and failure from the sanitized record", () => {
		const dir = tree({ "setup.json": record({}) })
		expect(readSetupStatus(dir, "boot-a").value).toMatchObject({
			state: "running",
			phase: "install",
		})
		write(
			dir,
			"setup.json",
			record({ state: "failed", phase: null, exitCode: 23 }),
		)
		expect(readSetupStatus(dir, "boot-a").value).toMatchObject({
			state: "failed",
			exitCode: 23,
		})
	})

	it("measures setup age on the Pi's own clock and never reports a negative age", () => {
		const dir = tree({
			"setup.json": record({ updatedAt: "2026-10-08T10:00:00+00:00" }),
		})
		const at = Date.parse("2026-10-08T10:05:00Z")
		expect(readSetupStatus(dir, "boot-a", at).value?.updatedAgeMs).toBe(300_000)
		// Written after an NTP jump forward, read before: no negative age.
		expect(
			readSetupStatus(dir, "boot-a", at - 600_000).value?.updatedAgeMs,
		).toBeNull()
	})

	it("flags setup interrupted by a reboot using the boot id", () => {
		const dir = tree({ "setup.json": record({ bootId: "boot-a" }) })
		expect(readSetupStatus(dir, "boot-b").value?.state).toBe("interrupted")
		write(
			dir,
			"setup.json",
			record({
				state: "complete",
				phase: "done",
				bootId: "boot-a",
				exitCode: 0,
			}),
		)
		expect(readSetupStatus(dir, "boot-b").value?.state).toBe("complete")
	})

	it("refuses missing, oversized, invalid and symlinked records", () => {
		const dir = tree({})
		expect(readSetupStatus(dir, null)).toEqual({
			value: null,
			reason: "not provided by this install",
		})
		write(dir, "setup.json", " ".repeat(5000))
		expect(readSetupStatus(dir, null).reason).toBe(
			"setup status file too large",
		)
		write(dir, "setup.json", "{nope")
		expect(readSetupStatus(dir, null).reason).toBe(
			"setup status is not valid JSON",
		)
		write(dir, "setup.json", record({ state: "pwned" }))
		expect(readSetupStatus(dir, null).reason).toBe(
			"setup status has an unknown format",
		)
		fs.rmSync(path.join(dir, "setup.json"))
		const secret = tree({ "network-config": "psk: secret" })
		fs.symlinkSync(
			path.join(secret, "network-config"),
			path.join(dir, "setup.json"),
		)
		expect(readSetupStatus(dir, null)).toEqual({
			value: null,
			reason: "setup status is a symlink",
		})
	})
})

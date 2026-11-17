import { describe, expect, it } from "vitest"
import {
	descendantsOf,
	nonLoopbackListeners,
	parseLsofListeners,
	parseProcLines,
	parsePs,
	parsePsTime,
	PROC_TICK_MS,
} from "../../../scripts/bench/budget-manifest.js"
// @ts-expect-error plain ESM script without types
import * as preload from "../../../scripts/bench/budget-preload.mjs"

interface ProcStat {
	pid: number
	comm: string
	ppid: number
	utime: number
	stime: number
	ticks: number
}
const parseProcStat = preload.parseProcStat as (text: string) => ProcStat | null
const toolTargetRefusal = preload.toolTargetRefusal as (
	host: unknown,
	port: unknown,
) => string | null
const splitHostPort = preload.splitHostPort as (
	text: string,
) => { host: string; port: number } | null

/** A /proc/<pid>/stat line: comm, then fields 3 to 52 (utime is field 14, stime field 15). */
function statLine(
	pid: number,
	comm: string,
	ppid: number,
	utime: number,
	stime: number,
): string {
	const after = [
		"S",
		ppid,
		pid,
		pid,
		0,
		-1,
		4194560,
		1200,
		0,
		3,
		0,
		utime,
		stime,
		0,
		0,
		20,
		0,
		11,
		0,
		12345,
		1_000_000,
		900,
	]
	return `${pid} (${comm}) ${after.join(" ")}\n`
}

describe("/proc stat parsing", () => {
	it("reads pid, ppid, utime and stime around a comm with spaces and parentheses", () => {
		const r = parseProcStat(statLine(4242, "a (b) c)", 17, 321, 45))
		expect(r).toEqual({
			pid: 4242,
			comm: "a (b) c)",
			ppid: 17,
			utime: 321,
			stime: 45,
			ticks: 366,
		})
		expect(parseProcStat(statLine(9, "node", 1, 0, 0))?.ticks).toBe(0)
	})

	it("refuses a line that does not parse", () => {
		expect(parseProcStat("")).toBeNull()
		expect(parseProcStat("12 node S 1")).toBeNull()
		expect(parseProcStat("12 (node) S x")).toBeNull()
	})

	it("reads the procstat listing as 10 ms ticks", () => {
		const rows = parseProcLines(
			"10 1 node 250\n11 10 multimon_ng 7\nbad line\n",
		)
		expect(rows).toEqual([
			{ pid: 10, ppid: 1, comm: "node", cpuMs: 250 * PROC_TICK_MS },
			{ pid: 11, ppid: 10, comm: "multimon_ng", cpuMs: 70 },
		])
		expect([...descendantsOf(rows, 10)]).toEqual([11])
	})
})

describe("ps time parsing", () => {
	it("reads the Linux [dd-]hh:mm:ss form", () => {
		expect(parsePsTime("00:01:02")).toBe(62_000)
		expect(parsePsTime("1-02:03:04")).toBe(
			((24 + 2) * 3600 + 3 * 60 + 4) * 1000,
		)
	})

	it("reads the macOS m:ss.cc form", () => {
		expect(parsePsTime("0:01.23")).toBeCloseTo(1230, 9)
		expect(parsePsTime("12:34.50")).toBeCloseTo((12 * 60 + 34.5) * 1000, 9)
	})

	it("refuses other text", () => {
		expect(parsePsTime("")).toBeNull()
		expect(parsePsTime("1.5")).toBeNull()
		expect(parsePsTime("a:b")).toBeNull()
	})

	it("reads pid ppid time comm lines and walks children by parent links", () => {
		const rows = parsePs(
			"  100     1 0:01.00 /usr/bin/node\n  101   100 0:00.50 /tmp/bin/csdr\n  102   101 00:00:02 python3\n  200     1 0:09.00 other\n",
		)
		expect(rows.map(r => [r.pid, r.comm, r.cpuMs])).toEqual([
			[100, "node", 1000],
			[101, "csdr", 500],
			[102, "python3", 2000],
			[200, "other", 9000],
		])
		expect([...descendantsOf(rows, 100)].sort()).toEqual([101, 102])
	})
})

describe("tool target guard", () => {
	it("allows loopback hosts on other ports", () => {
		for (const host of ["127.0.0.1", "[::1]", "::1", "localhost", "LOCALHOST"])
			expect(toolTargetRefusal(host, 40_000)).toBeNull()
		// The tier B API port inside the isolated container.
		expect(toolTargetRefusal("127.0.0.1", 5173)).toBeNull()
		expect(toolTargetRefusal("127.0.0.1", 9229)).toBeNull()
	})

	it("refuses any other host", () => {
		for (const host of [
			"0.0.0.0",
			"192.0.2.1",
			"198.51.100.7",
			"host.docker.internal",
			"example.org",
			"127.0.0.2",
			"",
			undefined,
		])
			expect(toolTargetRefusal(host, 40_000)).toMatch(/refused host/)
	})

	it("refuses the shared ports and malformed ports", () => {
		for (const port of [
			1234, 4713, 5555, 5556, 8080, 8081, 8082, 9000, 15555, 15556, 18080,
		])
			expect(toolTargetRefusal("127.0.0.1", port)).toMatch(/shared port/)
		for (const port of [0, -1, 65_536, 1.5, "x", Number.NaN])
			expect(toolTargetRefusal("127.0.0.1", port)).toMatch(/refused port/)
	})

	it("splits HOST:PORT including a bracketed IPv6 host", () => {
		expect(splitHostPort("127.0.0.1:9229")).toEqual({
			host: "127.0.0.1",
			port: 9229,
		})
		expect(splitHostPort("[::1]:9229")).toEqual({ host: "[::1]", port: 9229 })
		expect(splitHostPort("127.0.0.1")).toBeNull()
		expect(splitHostPort("::1:9229")).toBeNull()
	})
})

describe("listener check", () => {
	it("flags every listener not on 127.0.0.1 or [::1]", () => {
		const text = [
			"COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
			"node    12345  u   23u  IPv4 0x1      0t0  TCP 127.0.0.1:41000 (LISTEN)",
			"node    12345  u   24u  IPv6 0x2      0t0  TCP [::1]:41001 (LISTEN)",
			"node    12345  u   25u  IPv6 0x3      0t0  TCP *:41002 (LISTEN)",
			"node    12345  u   26u  IPv4 0x4      0t0  TCP 0.0.0.0:41003 (LISTEN)",
		].join("\n")
		const all = parseLsofListeners(text)
		expect(all).toHaveLength(4)
		expect(nonLoopbackListeners(all)).toEqual([
			{ address: "*", port: 41002 },
			{ address: "0.0.0.0", port: 41003 },
		])
		expect(nonLoopbackListeners(all.slice(0, 2))).toEqual([])
	})
})

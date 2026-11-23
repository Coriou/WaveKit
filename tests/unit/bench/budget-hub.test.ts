import { spawn } from "node:child_process"
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { connect, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	accountStages,
	buildStages,
	byteCheckOf,
	frontDelta,
	hubGapsOf,
	hubStages,
	nearestStats,
	parseHubStats,
	type HubStatsLine,
} from "../../../scripts/bench/budget-manifest.js"

const RATE = 1000

function line(
	utcMs: number,
	o: {
		pid?: number
		sourcePos: number
		arrivals: number
		fronts?: {
			sink: string
			sinkBytes: number
			droppedBytes?: number
			state?: string
		}[]
		closed?: {
			sink: string
			sinkBytes: number
			droppedBytes?: number
			discardedBytes?: number
		}[]
		cpuUs?: number
	},
): HubStatsLine {
	const entry = (f: {
		sink: string
		sinkBytes: number
		droppedBytes?: number
		discardedBytes?: number
		state?: string
	}) => ({
		sink: f.sink,
		kind: "front",
		state: f.state ?? "active",
		sinkBytes: f.sinkBytes,
		droppedBytes: f.droppedBytes ?? 0,
		discardedBytes: f.discardedBytes ?? 0,
		gaps: (f.droppedBytes ?? 0) > 0 ? 1 : 0,
	})
	return {
		type: "stats",
		utcMs,
		pid: o.pid ?? 4242,
		sourcePos: o.sourcePos,
		arrivals: { bytes: o.arrivals },
		sinks: (o.fronts ?? []).map(entry),
		closedFronts: (o.closed ?? []).map(f => ({ ...entry(f), state: "closed" })),
		rusage: { userUs: o.cpuUs ?? 0, sysUs: 0, maxRssBytes: 60_000_000 },
	}
}

describe("hub stats and stages", () => {
	it("parses stats lines, skipping torn and foreign lines, and picks the nearest to an edge", () => {
		const a = line(1000, { sourcePos: 0, arrivals: 0 })
		const b = line(2000, { sourcePos: 2000, arrivals: 2000 })
		const text = `${JSON.stringify(a)}\n{"type":"other"}\n${JSON.stringify(b)}\n{"type":"st`
		const lines = parseHubStats(text)
		expect(lines).toHaveLength(2)
		expect(nearestStats(lines, 1400)?.utcMs).toBe(1000)
		expect(nearestStats(lines, 1600)?.utcMs).toBe(2000)
	})

	it("hub-upstream is ok within 1 s in flight; hub-node counts the skips as its loss", () => {
		const a = line(0, {
			sourcePos: 1000,
			arrivals: 1000,
			fronts: [{ sink: "front-1", sinkBytes: 1000 }],
		})
		const b = line(10_000, {
			sourcePos: 21_000,
			arrivals: 21_000,
			fronts: [{ sink: "front-1", sinkBytes: 17_000, droppedBytes: 4000 }],
		})
		const stages = hubStages({ rateHz: RATE, fakeSentBytes: 21_500, a, b })
		const acc = accountStages(stages)
		const up = acc.stages.find(s => s.id === "hub-upstream")!
		const node = acc.stages.find(s => s.id === "hub-node")!
		expect(up.lostSamples).toBe(750)
		expect(up.losing).toBe(false)
		expect(node).toMatchObject({
			inSamples: 10_000,
			outSamples: 8000,
			lostSamples: 2000,
			losing: true,
		})
		expect(acc.firstLosing?.id).toBe("hub-node")
	})

	it("a front that started inside the window counts whole; one gone from B makes the delta unknown", () => {
		const a = line(0, {
			sourcePos: 0,
			arrivals: 0,
			fronts: [{ sink: "front-1", sinkBytes: 0 }],
		})
		const b = line(1, {
			sourcePos: 100,
			arrivals: 100,
			closed: [{ sink: "front-1", sinkBytes: 40 }],
			fronts: [{ sink: "front-2", sinkBytes: 60 }],
		})
		expect(frontDelta(a, b)).toMatchObject({ sinkBytes: 100 })
		expect(frontDelta(b, a)).toBeNull()
	})

	it("a respawned hub (pid change) leaves both hub stages unknown", () => {
		const a = line(0, { pid: 1, sourcePos: 0, arrivals: 0 })
		const b = line(1, { pid: 2, sourcePos: 10, arrivals: 10 })
		const stages = accountStages(
			hubStages({ rateHz: RATE, fakeSentBytes: 10, a, b }),
		).stages
		expect(stages.every(s => s.losing === null)).toBe(true)
	})

	it("buildStages in hub mode puts the hub stages first and feeds source-socket from the front", () => {
		const a = line(0, {
			sourcePos: 0,
			arrivals: 0,
			fronts: [{ sink: "front-1", sinkBytes: 0 }],
		})
		const b = line(1, {
			sourcePos: 200,
			arrivals: 200,
			fronts: [{ sink: "front-1", sinkBytes: 200 }],
		})
		const stages = buildStages({
			rateHz: RATE,
			windowSeconds: 1,
			sourceId: "bench0",
			socketBytes: null,
			hub: { a, b },
			fakeA: { bytes: 0, skippedSeconds: 0, monoMs: 0, behindMs: 0 },
			fakeB: { bytes: 200, skippedSeconds: 0, monoMs: 100, behindMs: 0 },
			edgeA: null,
			edgeB: null,
			autoA: undefined,
			autoB: undefined,
		})
		const ids = stages.map(s => s.id)
		expect(ids.slice(0, 4)).toEqual([
			"fake-schedule",
			"hub-upstream",
			"hub-node",
			"source-socket",
		])
		expect(stages.find(s => s.id === "source-socket")).toMatchObject({
			inSamples: 100,
			outSamples: null,
		})
		expect(stages.find(s => s.id === "source-manager")?.inSamples).toBe(100)
	})
})

describe("the exact end-of-run byte check", () => {
	const front = {
		sink: "front-1",
		kind: "front",
		state: "closed",
		sinkBytes: 9000,
		droppedBytes: 1000,
		discardedBytes: 0,
		gaps: 1,
	}

	it("hub: U = N + G + D + K holds with D = K = 0", () => {
		expect(
			byteCheckOf({
				mode: "hub",
				clients: [{ bytesWritten: 12 + 10_000 + 1, graceful: true }],
				coreBytesReceived: 12 + 9000,
				front,
			}),
		).toEqual({
			mode: "hub",
			upstream: 10_000,
			node: 9000,
			gaps: 1000,
			discarded: 0,
			abandoned: 0,
			exact: true,
			reason: null,
		})
	})

	it("hub: abandoned bytes, a discarded tail or unreported loss are not exact", () => {
		expect(
			byteCheckOf({
				mode: "hub",
				clients: [{ bytesWritten: 12 + 10_000, graceful: true }],
				coreBytesReceived: 12 + 8000,
				front,
			}),
		).toMatchObject({ abandoned: 1000, exact: false })
		expect(
			byteCheckOf({
				mode: "hub",
				clients: [{ bytesWritten: 12 + 10_002, graceful: true }],
				coreBytesReceived: 12 + 9000,
				front,
			}).exact,
		).toBe(false)
		expect(
			byteCheckOf({
				mode: "hub",
				clients: [{ bytesWritten: 12 + 10_000, graceful: true }],
				coreBytesReceived: 12 + 9000,
				front: { ...front, droppedBytes: 900, discardedBytes: 100 },
			}).exact,
		).toBe(false)
	})

	it("socket: U = N; reconnects and missing inputs are not checkable", () => {
		expect(
			byteCheckOf({
				mode: "socket",
				clients: [{ bytesWritten: 5012, graceful: true }],
				coreBytesReceived: 5012,
				front: null,
			}).exact,
		).toBe(true)
		expect(
			byteCheckOf({
				mode: "socket",
				clients: [{ bytesWritten: 1 }, { bytesWritten: 2 }],
				coreBytesReceived: 3,
				front: null,
			}).reason,
		).toContain("reconnect")
		expect(
			byteCheckOf({
				mode: "hub",
				clients: null,
				coreBytesReceived: 1,
				front,
			}).reason,
		).toContain("stopped")
	})
})

describe("the byte check needs every fake client's graceful close", () => {
	const front = {
		sink: "front-1",
		kind: "front",
		state: "closed",
		sinkBytes: 9000,
		droppedBytes: 1000,
		discardedBytes: 0,
		gaps: 1,
	}

	it("a forced, errored or unknown close is never exact, whatever the counts", () => {
		for (const clients of [
			[{ bytesWritten: 12 + 10_000, graceful: false }],
			[{ bytesWritten: 12 + 10_000 }],
		]) {
			const check = byteCheckOf({
				mode: "hub",
				clients,
				coreBytesReceived: 12 + 9000,
				front,
			})
			expect(check.exact).toBe(false)
			expect(check.reason).toContain("gracefully")
		}
		expect(
			byteCheckOf({
				mode: "socket",
				clients: [{ bytesWritten: 5012, graceful: false }],
				coreBytesReceived: 5012,
				front: null,
			}).exact,
		).toBe(false)
	})

	it("the fake logs graceful per client: a client that closes after the FIN is graceful, one that never closes is forced", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wk-fake-rtl-"))
		const iq = join(dir, "iq.cu8")
		writeFileSync(iq, Buffer.alloc(64 * 1024, 127))
		const playlist = join(dir, "playlist.txt")
		writeFileSync(playlist, "iq.cu8 64000\n")
		const logFile = join(dir, "fake.jsonl")
		const fake = spawn(
			process.execPath,
			["scripts/bench/budget-fake-rtltcp.mjs", "0", playlist, logFile],
			{ stdio: ["ignore", "pipe", "inherit"] },
		)
		const sockets: Socket[] = []
		try {
			const port = await new Promise<number>((resolve, reject) => {
				fake.once("error", reject)
				fake.stdout.once("data", (d: Buffer) =>
					resolve(
						(JSON.parse(d.toString().split("\n")[0]!) as { port: number }).port,
					),
				)
			})
			const connectClient = () =>
				new Promise<Socket>(resolve => {
					const s = connect({ host: "127.0.0.1", port, allowHalfOpen: true })
					s.on("error", () => {})
					sockets.push(s)
					s.once("connect", () => resolve(s))
				})
			// Reads everything and closes once the fake's FIN arrives.
			const polite = await connectClient()
			polite.on("data", () => {})
			polite.on("end", () => polite.end())
			// Never reads and never closes: the fake destroys it after 5 s.
			const stuck = await connectClient()
			stuck.pause()
			await new Promise(resolve => setTimeout(resolve, 200))
			fake.kill("SIGUSR1")
			const deadline = Date.now() + 9000
			let stopped: { clients: { graceful: boolean }[] } | null = null
			while (stopped === null && Date.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, 100))
				const lines = existsSync(logFile)
					? readFileSync(logFile, "utf8").trim().split("\n")
					: []
				for (const l of lines) {
					const parsed = JSON.parse(l) as {
						ev?: string
						clients?: { graceful: boolean }[]
					}
					if (parsed.ev === "stopped" && parsed.clients)
						stopped = { clients: parsed.clients }
				}
			}
			expect(stopped?.clients.map(c => c.graceful)).toEqual([true, false])
		} finally {
			for (const s of sockets) s.destroy()
			fake.kill("SIGTERM")
			await new Promise(resolve => {
				if (fake.exitCode !== null) resolve(null)
				else fake.once("exit", resolve)
			})
			rmSync(dir, { recursive: true, force: true })
		}
	}, 15_000)
})

describe("hub gaps from the core log", () => {
	it("keeps the window's gap lines and ignores others", () => {
		const gap = (time: number) =>
			JSON.stringify({
				level: 30,
				time,
				msg: "IQ hub front skipped samples (counted loss)",
				cause: "lag",
				atSinkByte: 10,
				atSourcePos: 20,
				droppedBytes: 30,
			})
		const iso = JSON.stringify({
			level: 30,
			time: new Date(60).toISOString(),
			msg: "IQ hub front skipped samples (counted loss)",
			cause: "start",
			atSinkByte: 0,
			atSourcePos: 0,
			droppedBytes: 2,
		})
		const log = [
			gap(5),
			"not json IQ hub front skipped samples",
			gap(50),
			iso,
			gap(500),
		].join("\n")
		const r = hubGapsOf(log, 10, 100)
		expect(r.total).toBe(2)
		expect(r.gaps[0]).toMatchObject({ cause: "lag", droppedBytes: 30 })
		expect(r.gaps[1]).toMatchObject({ cause: "start", droppedBytes: 2 })
	})
})

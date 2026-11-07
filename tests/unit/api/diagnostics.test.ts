import { DIAGNOSTICS_LIMITS, type DiagnosticsChannel } from "@wavekit/api-types"
import Fastify from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import {
	DiagnosticsSampler,
	diagnosticsRoutes,
	parseThreadStat,
	type DiagnosticsDeps,
} from "../../../src/api/routes/diagnostics.js"
import type { ChannelizerManager } from "../../../src/core/channelizer/channelizer-manager.js"
import type { EventLoopMeter } from "../../../src/core/link-burst/contract.js"

/** A thread's stat line with the CPU fields where the kernel puts them. */
const stat = (tid: number, name: string, utime: number, stime = 0): string =>
	`${tid} (${name}) R 1 1 1 0 -1 4194304 10 0 0 0 ${utime} ${stime} 0 0 20 0 8 0 100 0\n`

function harness(patch: Partial<DiagnosticsDeps> = {}) {
	let mono = 10_000
	const ticks = new Map<string, number>()
	const listThreads = vi.fn(() => Promise.resolve([...ticks.keys()]))
	const readThreadStat = vi.fn((tid: string) =>
		Promise.resolve(stat(Number(tid), "worker", ticks.get(tid) ?? 0)),
	)
	const usage = { user: 1_000_000, system: 500_000 }
	const deps: DiagnosticsDeps = {
		platform: "linux",
		listThreads,
		readThreadStat,
		cpuUsage: () => ({ ...usage }),
		utilization: (a, b) =>
			a && b
				? { idle: 0, active: 0, utilization: 0.25 }
				: { idle: 1, active: 1, utilization: 0.5 },
		monoNow: () => mono,
		now: () => 1_800_000_000_000,
		loopDelay: undefined,
		channels: undefined,
		containerCpuCores: undefined,
		...patch,
	}
	return {
		sampler: new DiagnosticsSampler(deps),
		ticks,
		usage,
		listThreads,
		readThreadStat,
		advance: (ms: number) => {
			mono += ms
		},
	}
}

describe("parseThreadStat", () => {
	it("reads the CPU fields after a name with spaces and parentheses", () => {
		expect(parseThreadStat(stat(7, "a) b (c", 120, 30))).toEqual({
			name: "a) b (c",
			ticks: 150,
		})
	})

	it("never passes a control character or a long name through", () => {
		const parsed = parseThreadStat(stat(7, `a\u0007\n${"x".repeat(40)}`, 1))
		expect(parsed?.name).toBe(`a??${"x".repeat(12)}`)
	})

	it.each([
		["no parentheses", "7 worker R 1"],
		["a truncated line", "7 (worker) R 1 1"],
		["negative ticks", stat(7, "w", -1)],
		["non-numeric ticks", "7 (w) R 1 1 1 0 -1 4 10 0 0 0 x y 0"],
	])("reads %s as nothing", (_name, line) => {
		expect(parseThreadStat(line)).toBeNull()
	})
})

describe("DiagnosticsSampler", () => {
	it("averages CPU over the window from the second sample", async () => {
		const h = harness()
		h.ticks.set("10", 1000)
		const first = await h.sampler.read()
		expect(first.process.cpuCores).toBeNull()
		expect(first.process.windowMs).toBeNull()
		expect(first.eventLoopUtilization).toBeNull()
		expect(first.threads?.rows[0]).toEqual({
			tid: 10,
			name: "worker",
			cpuSeconds: 10,
			cpuCores: null,
		})
		h.advance(2_000)
		// 100 ticks = 1 s of CPU over a 2 s window = 0.5 core.
		h.ticks.set("10", 1100)
		h.usage.user += 1_000_000
		h.usage.system += 1_000_000
		const second = await h.sampler.read()
		expect(second.process.windowMs).toBe(2_000)
		expect(second.process.cpuCores).toBeCloseTo(1, 9)
		expect(second.threads?.rows[0]?.cpuCores).toBeCloseTo(0.5, 9)
		expect(second.eventLoopUtilization).toBe(0.25)
	})

	it("shares one sample up to the cache bound and takes a new one at it", async () => {
		const h = harness()
		h.ticks.set("10", 1)
		await Promise.all(Array.from({ length: 50 }, () => h.sampler.read()))
		h.advance(DIAGNOSTICS_LIMITS.cacheMs - 1)
		await h.sampler.read()
		expect(h.listThreads).toHaveBeenCalledTimes(1)
		expect(h.readThreadStat).toHaveBeenCalledTimes(1)
		h.advance(1)
		await h.sampler.read()
		expect(h.listThreads).toHaveBeenCalledTimes(2)
	})

	it("reads every thread at the cap and one fewer than the list past it", async () => {
		const at = harness()
		for (let tid = 1; tid <= DIAGNOSTICS_LIMITS.threadsMax; tid++)
			at.ticks.set(String(tid), 1)
		const whole = await at.sampler.read()
		expect(whole.threads?.rows).toHaveLength(DIAGNOSTICS_LIMITS.threadsMax)
		expect(whole.threads?.truncated).toBe(false)

		const past = harness()
		for (let tid = 1; tid <= DIAGNOSTICS_LIMITS.threadsMax + 1; tid++)
			past.ticks.set(String(tid), 1)
		const cut = await past.sampler.read()
		expect(past.readThreadStat).toHaveBeenCalledTimes(
			DIAGNOSTICS_LIMITS.threadsMax,
		)
		expect(cut.threads?.truncated).toBe(true)
		// The lowest ids are kept: the main thread is the lowest.
		expect(cut.threads?.rows.some(row => row.tid === 1)).toBe(true)
	})

	it("starts no further read past the budget, and one at it", async () => {
		const run = async (spentMs: number) => {
			const h = harness()
			h.ticks.set("1", 1)
			h.ticks.set("2", 1)
			h.readThreadStat.mockImplementationOnce(tid => {
				h.advance(spentMs)
				return Promise.resolve(stat(Number(tid), "worker", 1))
			})
			const read = await h.sampler.read()
			return { calls: h.readThreadStat.mock.calls.length, read }
		}
		const at = await run(DIAGNOSTICS_LIMITS.threadReadBudgetMs)
		expect(at.calls).toBe(2)
		expect(at.read.threads?.truncated).toBe(false)
		const past = await run(DIAGNOSTICS_LIMITS.threadReadBudgetMs + 1)
		expect(past.calls).toBe(1)
		expect(past.read.threads?.truncated).toBe(true)
	})

	it("reads null off Linux without touching the file system", async () => {
		const h = harness({ platform: "darwin" })
		h.ticks.set("10", 1)
		expect((await h.sampler.read()).threads).toBeNull()
		expect(h.listThreads).not.toHaveBeenCalled()
	})

	it("reads null when the list fails, and skips a thread that ended", async () => {
		const failed = harness()
		failed.listThreads.mockRejectedValueOnce(new Error("ENOENT"))
		expect((await failed.sampler.read()).threads).toBeNull()

		const ended = harness()
		ended.ticks.set("1", 1)
		ended.ticks.set("2", 1)
		ended.readThreadStat.mockRejectedValueOnce(new Error("ENOENT"))
		expect((await ended.sampler.read()).threads?.rows.map(r => r.tid)).toEqual([
			2,
		])
	})

	it("says nothing of a reused thread id that counts lower", async () => {
		const h = harness()
		h.ticks.set("10", 500)
		await h.sampler.read()
		h.advance(2_000)
		h.ticks.set("10", 5)
		expect((await h.sampler.read()).threads?.rows[0]?.cpuCores).toBeNull()
	})

	it("lists the busiest thread first", async () => {
		const h = harness()
		h.ticks.set("1", 0)
		h.ticks.set("2", 0)
		h.ticks.set("3", 0)
		await h.sampler.read()
		h.advance(2_000)
		h.ticks.set("1", 10)
		h.ticks.set("2", 90)
		h.ticks.delete("3")
		h.ticks.set("4", 900)
		const rows = (await h.sampler.read()).threads?.rows ?? []
		expect(rows.map(row => row.tid)).toEqual([2, 1, 4])
	})

	it("cuts the channel list at its bound and says so", async () => {
		const row = {} as DiagnosticsChannel
		const of = async (count: number) =>
			(
				await harness({
					channels: () => Array.from({ length: count }, () => row),
				}).sampler.read()
			).channels
		const at = await of(DIAGNOSTICS_LIMITS.channelsMax)
		expect(at?.rows).toHaveLength(DIAGNOSTICS_LIMITS.channelsMax)
		expect(at?.truncated).toBe(false)
		const past = await of(DIAGNOSTICS_LIMITS.channelsMax + 1)
		expect(past?.rows).toHaveLength(DIAGNOSTICS_LIMITS.channelsMax)
		expect(past?.truncated).toBe(true)
	})
})

describe("GET /api/diagnostics", () => {
	const apps: { close(): Promise<unknown> }[] = []
	afterEach(async () => {
		for (const app of apps.splice(0)) await app.close()
	})

	it("serves what the runtime gives it, through the response schema", async () => {
		const app = Fastify()
		apps.push(app)
		const channel: DiagnosticsChannel = {
			id: "ch",
			sourceId: "s",
			decoderId: "d",
			generation: 1,
			centerHz: 100_000_000,
			bandwidthHz: 12_500,
			outputRateHz: 48_000,
			format: "cf32",
			filterTaps: 11,
			inputSampleRateHz: 2_400_000,
			stats: null,
		}
		await app.register(diagnosticsRoutes, {
			loopDelay: () => ({
				last: { maxMs: 2, p99Ms: 1 },
				maxMs10m: 2,
				p99MaxMs10m: 1,
				intervals10m: 1,
			}),
			channels: () => [channel],
			containerCpuCores: () => 1.5,
			deps: { platform: "darwin" },
		})
		const response = await app.inject({ url: "/api/diagnostics" })
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({
			eventLoopDelay: { last: { maxMs: 2, p99Ms: 1 }, intervals10m: 1 },
			containerCpuCores: 1.5,
			threads: null,
			channels: { rows: [channel], truncated: false },
		})
	})

	it("reads null where the runtime does not supply a part", async () => {
		const app = Fastify()
		apps.push(app)
		await app.register(diagnosticsRoutes, { deps: { platform: "darwin" } })
		expect(
			(await app.inject({ url: "/api/diagnostics" })).json(),
		).toMatchObject({
			eventLoopDelay: null,
			containerCpuCores: null,
			channels: null,
		})
	})

	it("takes the core's meter and channel rows as they are", () => {
		// The composition in src/index.ts hands these two over; this fails to compile if they drift.
		const wire = (
			meter: EventLoopMeter,
			manager: ChannelizerManager,
		): ApiServerDependencies["diagnostics"] => ({
			loopDelay: () => meter.report(0),
			channels: () => manager.openChannelRows(),
		})
		expect(wire).toBeTypeOf("function")
	})
})

import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import fc from "fast-check"
import type { PlacementLifecycle } from "../../../../src/decoders/placement-lifecycle.js"
import { checkAllDecodersHealth } from "../../../../src/utils/health-check.js"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	ChannelRequestResult,
	ChannelProvider,
} from "../../../../src/core/channelizer/types.js"
import type {
	EfficiencyGate,
	EfficiencySample,
	PlacementPlan,
	PlacementPlanner,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import {
	EFFICIENCY_PROBATION_MS,
	EFFICIENCY_RETRY_MS,
	placementKey,
} from "../../../../src/decoders/enablement/contract.js"
import type { Decoder } from "../../../../src/decoders/types.js"
import {
	createEfficiencyGate,
	type DropReader,
} from "../../../../src/decoders/enablement/efficiency-gate.js"
import {
	FakeSources,
	RateDecoder,
	iqCaps,
	deferred,
} from "../../../mocks/rate-fakes.js"

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	vi.useRealTimers()
})

function setup(type = "rate-test", gate?: EfficiencyGate) {
	vi.useFakeTimers()
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 162_000_000 })
	const instances = new Map<string, RateDecoder>()
	let beforeStart: (() => void) | undefined
	const configs = new Map<string, Record<string, unknown>>()
	const registry = new DecoderRegistry()
	registry.register(
		type,
		config => {
			const decoder: RateDecoder &
				Pick<Decoder, "getChannelRequest" | "getLog"> = new RateDecoder(
				config.id,
				{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
			)
			const start = decoder.start.bind(decoder)
			vi.spyOn(decoder, "start").mockImplementation(async () => {
				beforeStart?.()
				await start()
			})
			let options = { ...config.options }
			configs.set(config.id, options)
			decoder.updateOptions = updates => {
				options = { ...options, ...updates }
				config.options = options
				configs.set(config.id, options)
			}
			decoder.getChannelRequest = () => ({
				centerHz: options["channelHz"] as number,
				bandwidthHz: 12_500,
				transitionHz: 2_500,
				outputRateHz: 48_000,
				format: "cu8" as const,
			})
			decoder.getLog = () => [{ stream: "stderr" as const, line: "signal" }]
			instances.set(config.id, decoder)
			return decoder
		},
		{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
	)
	let catalogue = true
	let unavailable = false
	let wanted: WantedPlacement[] = []
	let unplaced: PlacementPlan["unplaced"] = new Map()
	const planner = vi.fn<PlacementPlanner>(() => ({ wanted, unplaced }))
	const info = vi.fn()
	const warn = vi.fn()
	const logger = pino({
		level: "silent",
		onChild(child) {
			vi.spyOn(child, "info").mockImplementation(info)
			vi.spyOn(child, "warn").mockImplementation(warn)
		},
	})
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
		enablement: {
			planner,
			...(gate ? { gate } : {}),
			resolveMode: () => ({ mode: "auto", source: "default" }),
			isCatalogue: () => catalogue,
			unavailable: () => unavailable,
			recheckAvailable: async () => true,
			vfo: () => null,
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
		},
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	const provider = Object.assign(new EventEmitter(), {
		requestChannel: vi.fn(
			async (): Promise<ChannelRequestResult> => ({
				ok: true as const,
				stream: new PassThrough(),
				channelId: String(++channel),
				generation: 1,
				realised: {
					outputRateHz: 48_000,
					format: "cu8" as const,
					groupDelaySamples: 0,
				},
			}),
		),
		releaseChannel: vi.fn(async () => {}),
		currentGeneration: () => 1,
		retuneChannel: vi.fn(async () => "retuned" as "retuned" | "refused"),
	})
	let channel = 0
	manager.setChannelizer(provider as unknown as ChannelProvider)
	const place = (
		id: string,
		hz: number,
		primary = true,
		origin: WantedPlacement["origin"] = "configured",
	): WantedPlacement => ({
		key: placementKey(id, "rtl", "channel", hz),
		decoderId: id,
		sourceId: "rtl",
		channelHz: hz,
		reach: "channel",
		origin,
		primary,
		costCores: 0.14,
		sampleRateHz: 2_400_000,
	})
	const create = (id: string, options: Record<string, unknown> = {}) =>
		manager!.createDecoder({
			id,
			type,
			enabled: true,
			options,
			useChannelizer: true,
		})
	const plan = (placements: WantedPlacement[]) => {
		wanted = placements
	}
	const settle = async () => {
		manager!.notifyBandplansChanged()
		await vi.advanceTimersByTimeAsync(350)
	}
	return {
		manager,
		onStart: (callback: () => void) => {
			beforeStart = callback
		},
		yaml: () => {
			catalogue = false
		},
		planner,
		info,
		warn,
		sources,
		instances,
		configs,
		provider,
		place,
		create,
		plan,
		settle,
		unavailable: () => {
			unavailable = true
		},
		unplaced: (value: PlacementPlan["unplaced"]) => {
			unplaced = value
		},
	}
}

function fakeGate() {
	const gate: EfficiencyGate = {
		record: vi.fn(),
		admit: vi.fn<EfficiencyGate["admit"]>(() => ({ admit: true })),
		probation: vi.fn(() => []),
		noteSuspended: vi.fn(),
		forget: vi.fn(),
		view: () => ({ budgetCores: 0.5, cpuGuardPercent: 90, sources: [] }),
	}
	return gate
}

function sampledGate(budgetCores = 0.5) {
	const gate = fakeGate()
	let sample: EfficiencySample = {
		atMs: Date.now(),
		cpuPercent: 0,
		sources: new Map([
			["rtl", { droppedBytesDelta: 0, droppedChunksDelta: 0 }],
		]),
	}
	const detail = () => {
		const source = sample.sources.get("rtl")
		if (!source || source.droppedBytesDelta === null) return "unknown" as const
		if (source.droppedBytesDelta > 0) return "drops" as const
		if (sample.cpuPercent !== null && sample.cpuPercent > 90)
			return "cpu" as const
		return null
	}
	gate.record = vi.fn<EfficiencyGate["record"]>(value => {
		sample = value
	})
	gate.admit = vi.fn<EfficiencyGate["admit"]>((placement, running, now) => {
		const blocked =
			detail() ??
			(running.reduce((sum, item) => sum + item.costCores, 0) +
				placement.costCores >
			budgetCores
				? "budget"
				: null)
		return blocked
			? { admit: false, detail: blocked, retryAtMs: now + 300_000 }
			: { admit: true }
	})
	gate.probation = vi.fn<EfficiencyGate["probation"]>((running, now) => {
		const reason = detail()
		if (reason !== "cpu" && reason !== "drops") return []
		const newest = running
			.filter(item => now - item.admittedAtMs < 30_000)
			.sort((a, b) => b.admittedAtMs - a.admittedAtMs)[0]
		return newest ? [{ key: newest.key, detail: reason }] : []
	})
	return gate
}

it("blocked placement is retried no more than once per retry period", async () => {
	const gate = fakeGate()
	gate.admit = vi.fn<EfficiencyGate["admit"]>((_placement, _running, now) => ({
		admit: false,
		detail: "budget",
		retryAtMs: now + 300_000,
	}))
	const f = setup("rate-test", gate)
	f.create("dec")
	f.plan([f.place("dec", 869_525_000)])
	await f.manager.startAll()
	expect(gate.admit).toHaveBeenCalledTimes(1)
	await vi.advanceTimersByTimeAsync(303_000)
	expect(gate.admit).toHaveBeenCalledTimes(2)
	expect(f.provider.requestChannel).not.toHaveBeenCalled()
})

it("reconsiders a five-minute rejection after five monotonic minutes when wall time moves back an hour", async () => {
	const gate = fakeGate()
	gate.admit = vi.fn<EfficiencyGate["admit"]>((_placement, _running, now) => ({
		admit: false,
		detail: "budget",
		retryAtMs: now + 300_000,
	}))
	const f = setup("rate-test", gate)
	f.create("dec")
	f.plan([f.place("dec", 162_000_000)])
	await f.manager.startAll()
	expect(gate.admit).toHaveBeenCalledTimes(1)
	vi.setSystemTime(Date.now() - 3_600_000)
	await vi.advanceTimersByTimeAsync(303_000)
	expect(gate.admit).toHaveBeenCalledTimes(2)
})

it.each(["stop", "suspend"])(
	"failed %s keeps the catalogue process in health until confirmed stopped",
	async action => {
		const f = setup("rate-test", fakeGate())
		f.create("dec")
		f.plan([f.place("dec", 162_000_000)])
		await f.manager.startAll()
		const decoder = f.instances.get("dec")!
		const stop = vi
			.spyOn(decoder, "stop")
			.mockRejectedValue(new Error("stop failed"))
		if (action === "stop") {
			const stopping = f.manager.stopDecoder("dec").catch(() => undefined)
			await vi.advanceTimersByTimeAsync(5001)
			await stopping
		} else {
			f.plan([])
			f.unplaced(new Map([["dec", "frequency-out-of-band"]]))
			await f.settle()
			await vi.advanceTimersByTimeAsync(5001)
		}
		expect(f.manager.isDecoderConfirmedStopped("dec")).toBe(false)
		expect(checkAllDecodersHealth(f.manager)).toHaveProperty("dec")
		stop.mockRestore()
		await f.manager.stopDecoder("dec")
		expect(f.manager.isDecoderConfirmedStopped("dec")).toBe(true)
		expect(checkAllDecodersHealth(f.manager)).not.toHaveProperty("dec")
	},
)

it("probation drop suspends only the newest probationer", async () => {
	const gate = fakeGate()
	const f = setup("rate-test", gate)
	f.create("dec")
	const first = f.place("dec", 162_000_000)
	const newest = f.place("dec", 162_025_000, false)
	f.plan([first, newest])
	await f.manager.startAll()
	gate.probation = vi.fn<EfficiencyGate["probation"]>(() => [
		{ key: newest.key, detail: "drops" },
	])
	gate.admit = vi.fn<EfficiencyGate["admit"]>((_placement, _running, now) => ({
		admit: false,
		detail: "drops",
		retryAtMs: now + 600_000,
	}))
	await vi.advanceTimersByTimeAsync(2500)
	expect(f.instances.get("dec")?.running).toBe(true)
	expect(f.instances.get(newest.key)?.running).toBe(false)
	expect(gate.noteSuspended).toHaveBeenCalledWith(
		newest.key,
		"drops",
		expect.any(Number),
	)
	expect(f.provider.releaseChannel).toHaveBeenCalledTimes(1)
})

it("budget 0.5 at 869.525 MHz: LoRa and dsd-fme efficiency-budget (budget), nothing restarts in a loop over 10 simulated minutes", async () => {
	const gate = fakeGate()
	gate.admit = vi.fn<EfficiencyGate["admit"]>((_placement, _running, now) => ({
		admit: false,
		detail: "budget",
		retryAtMs: now + 300_000,
	}))
	const f = setup("rate-test", gate)
	for (const id of ["lora", "dsd"]) f.create(id)
	f.plan(["lora", "dsd"].map(id => f.place(id, 869_525_000)))
	await f.manager.startAll()
	await vi.advanceTimersByTimeAsync(600_000)
	expect(
		f.manager
			.getAllStatus()
			.every(status => status.suspension?.reasonCode === "efficiency-budget"),
	).toBe(true)
	expect([...f.instances.values()].every(decoder => decoder.starts === 0)).toBe(
		true,
	)
	expect(gate.admit).toHaveBeenCalledTimes(4)
})

// The gate alone decides probation, so this runs against the real gate.
it("operator-started decoder outside probation is never stopped by the gate", async () => {
	const { drops, gate } = realGate()
	const f = setup("rate-test", gate)
	f.create("dec")
	f.plan([f.place("dec", 162_000_000)])
	await f.manager.startDecoder("dec", { startMode: "operator" })
	await vi.advanceTimersByTimeAsync(31_000)
	drops.droppedSince = true
	gate.record({ atMs: Date.now(), cpuPercent: 100, sources: new Map() })
	await vi.advanceTimersByTimeAsync(2500)
	expect(f.instances.get("dec")?.running).toBe(true)
})

it("with a provider, the first admitted channel placement requests a channel and its removal releases it immediately", async () => {
	const f = setup("rate-test", fakeGate())
	f.create("dec")
	f.plan([f.place("dec", 162_000_000)])
	expect(f.provider.requestChannel).not.toHaveBeenCalled()
	await f.manager.startAll()
	expect(f.provider.requestChannel).toHaveBeenCalledTimes(1)
	f.plan([])
	f.unplaced(new Map([["dec", "frequency-out-of-band"]]))
	await f.settle()
	expect(f.provider.releaseChannel).toHaveBeenCalledTimes(1)
})

it("no channel is requested before a channel placement is admitted", async () => {
	const gate = fakeGate()
	gate.admit = (_placement, _running, now) => ({
		admit: false,
		detail: "unknown",
		retryAtMs: now + 300_000,
	})
	const f = setup("rate-test", gate)
	f.create("dec")
	f.plan([f.place("dec", 162_000_000)])
	await f.manager.startAll()
	expect(f.provider.requestChannel).not.toHaveBeenCalled()
})

it("no provider → channelizer-unavailable for catalogue channel types, raw for YAML", async () => {
	const f = setup("dsd-fme", fakeGate())
	f.manager.setChannelizer(null)
	f.create("dec")
	await f.manager.startAll()
	expect(f.manager.getStatus("dec")?.suspension?.reasonCode).toBe(
		"channelizer-unavailable",
	)
	await f.manager.destroy()
	const yaml = setup("rate-test", fakeGate())
	yaml.yaml()
	yaml.manager.setChannelizer(null)
	yaml.create("raw")
	const raw = {
		...yaml.place("raw", 162_000_000),
		key: placementKey("raw", "rtl", "raw", null),
		reach: "raw" as const,
		channelHz: null,
	}
	yaml.plan([raw])
	await yaml.manager.startAll()
	expect(yaml.manager.getStatus("raw")?.running).toBe(true)
	expect(yaml.provider.requestChannel).not.toHaveBeenCalled()
})

// Feature: decoder-enablement, Property 6: No eviction
// Validates: Requirements 4.3, 4.4
it("No eviction", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.oneof(
				fc.integer({ min: 0, max: 27_000 }),
				fc.integer({ min: 31_000, max: 40_000 }),
			),
			async age => {
				const gate = sampledGate()
				const f = setup("rate-test", gate)
				f.create("dec")
				const placement = f.place("dec", 162_000_000)
				f.plan([placement])
				await f.manager.startAll()
				await vi.advanceTimersByTimeAsync(age)
				gate.record({
					atMs: Date.now(),
					cpuPercent: 100,
					sources: new Map([
						["rtl", { droppedBytesDelta: 0, droppedChunksDelta: 0 }],
					]),
				})
				await vi.advanceTimersByTimeAsync(2500)
				expect(f.instances.get("dec")?.running).toBe(age >= 30_000)
				await f.manager.destroy()
			},
		),
		{ numRuns: 100 },
	)
})

// Feature: decoder-enablement, Property 7: Budget bound
// Validates: Requirements 4.1, 4.2
it("Budget bound", async () => {
	await fc.assert(
		fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async budget => {
			const gate = sampledGate(budget / 10)
			gate.record({
				atMs: Date.now(),
				cpuPercent: 20,
				sources: new Map([
					["rtl", { droppedBytesDelta: 0, droppedChunksDelta: 0 }],
				]),
			})
			const f = setup("rate-test", gate)
			for (const id of ["third", "second", "first"]) f.create(id)
			f.plan(["first", "second", "third"].map(id => f.place(id, 162_000_000)))
			await f.manager.startAll()
			expect(
				f.manager.getAllStatus().filter(status => status.running).length * 0.14,
			).toBeLessThanOrEqual(budget / 10)
			expect([
				...new Set(
					vi.mocked(gate.admit).mock.calls.map(([item]) => item.decoderId),
				),
			]).toEqual(["first", "second", "third"])
			await f.manager.destroy()
		}),
		{ numRuns: 100 },
	)
})

it("stopped placement must obtain a fresh admission after another placement starts", async () => {
	const gate = sampledGate(0.14)
	const f = setup("rate-test", gate)
	f.create("a")
	f.create("b")
	f.plan([f.place("a", 162_000_000), f.place("b", 162_025_000)])
	await f.manager.startDecoder("a")
	await f.manager.stopDecoder("a")
	const stoppedCalls = vi.mocked(gate.admit).mock.calls.length
	await f.settle()
	expect(gate.admit).toHaveBeenCalledTimes(stoppedCalls)
	await f.manager.startDecoder("b")
	const calls = vi.mocked(gate.admit).mock.calls.length
	await f.manager.startDecoder("a")
	expect(gate.admit).toHaveBeenCalledTimes(calls + 1)
	expect(f.instances.get("a")?.running).toBe(false)
	expect(f.instances.get("b")?.running).toBe(true)
})

it("probation failures back off five, ten, twenty, thirty and thirty minutes", async () => {
	const gate = fakeGate()
	const admit = vi.mocked(gate.admit)
	admit.mockImplementationOnce((_placement, _running, now) => ({
		admit: false,
		detail: "budget",
		retryAtMs: now + 300_000,
	}))
	const f = setup("rate-test", gate)
	f.create("dec")
	const placement = f.place("dec", 162_000_000)
	f.plan([placement])
	await f.manager.startAll()
	await vi.advanceTimersByTimeAsync(303_000)
	expect(f.instances.get("dec")?.running).toBe(true)
	for (const minutes of [5, 10, 20, 30, 30]) {
		gate.probation = () => [{ key: placement.key, detail: "drops" }]
		await vi.advanceTimersByTimeAsync(2000)
		const calls = vi.mocked(gate.admit).mock.calls.length
		const [, , suspendedAt] = vi.mocked(gate.noteSuspended).mock.calls.at(-1)!
		expect(f.manager.getStatus("dec")?.efficiency?.retryAt).toBe(
			new Date(
				Date.now() + suspendedAt + minutes * 60_000 - performance.now(),
			).toISOString(),
		)
		gate.probation = () => []
		await vi.advanceTimersByTimeAsync(
			suspendedAt + minutes * 60_000 - performance.now() - 1,
		)
		expect(gate.admit).toHaveBeenCalledTimes(calls)
		await vi.advanceTimersByTimeAsync(2501)
		expect(gate.admit).toHaveBeenCalledTimes(calls + 2)
	}
	await vi.advanceTimersByTimeAsync(31_000)
	await f.manager.stopDecoder("dec")
	await f.manager.startDecoder("dec")
	gate.probation = () => [{ key: placement.key, detail: "cpu" }]
	await vi.advanceTimersByTimeAsync(2000)
	const [, , suspendedAt] = vi.mocked(gate.noteSuspended).mock.calls.at(-1)!
	expect(f.manager.getStatus("dec")?.efficiency?.retryAt).toBe(
		new Date(
			Date.now() + suspendedAt + 300_000 - performance.now(),
		).toISOString(),
	)
})

it("sampling avoids planning after blocked placements clear and stops on destroy", async () => {
	const gate = fakeGate()
	vi.mocked(gate.admit).mockImplementationOnce((_placement, _running, now) => ({
		admit: false,
		detail: "budget",
		retryAtMs: now + 4000,
	}))
	const f = setup("rate-test", gate)
	f.create("dec")
	f.plan([f.place("dec", 162_000_000)])
	const timersSpy = vi.spyOn(globalThis, "setTimeout")
	await f.manager.startAll()
	const sampleTimer = timersSpy.mock.results[
		timersSpy.mock.calls.findIndex(([, delay]) => delay === 2000)
	]?.value as ReturnType<typeof setTimeout>
	expect(sampleTimer.hasRef()).toBe(false)
	await vi.advanceTimersByTimeAsync(7000)
	expect(f.instances.get("dec")?.running).toBe(true)
	const calls = f.planner.mock.calls.length
	await vi.advanceTimersByTimeAsync(65_000)
	expect(f.planner).toHaveBeenCalledTimes(calls)
	await f.manager.destroy()
	const timers = vi.getTimerCount()
	expect(timers).toBe(0)
	await vi.advanceTimersByTimeAsync(10_000)
	expect(vi.getTimerCount()).toBe(timers)
	timersSpy.mockRestore()
})

it("warnings for established placements are throttled to once per minute", async () => {
	const gate = fakeGate()
	const f = setup("rate-test", gate)
	f.create("dec")
	f.plan([f.place("dec", 162_000_000)])
	await f.manager.startAll()
	gate.view = () => ({
		budgetCores: 0.5,
		cpuGuardPercent: 90,
		sources: [
			{
				sourceId: "rtl",
				coresInUse: 0.14,
				cpu: { percent: 100, limit: 90 },
				drops: "ok",
				dropBytesPerSecond: 0,
				admitted: [],
				blocked: [],
			},
		],
	})
	await vi.advanceTimersByTimeAsync(30_000)
	expect(f.warn).toHaveBeenCalledTimes(1)
	await vi.advanceTimersByTimeAsync(59_000)
	expect(f.warn).toHaveBeenCalledTimes(1)
	await vi.advanceTimersByTimeAsync(1000)
	expect(f.warn).toHaveBeenCalledTimes(2)
})

it.each(["budget", "cpu", "drops", null] as const)(
	"crashed placement obtains fresh admission before restarting: %s",
	async detail => {
		const gate = fakeGate()
		const f = setup("rate-test", gate)
		f.create("a")
		f.plan([f.place("a", 162_000_000)])
		await f.manager.startDecoder("a")
		const decoder = f.instances.get("a")!
		const calls = vi.mocked(gate.admit).mock.calls.length
		vi.mocked(gate.admit).mockImplementation((_placement, _running, now) =>
			detail
				? { admit: false, detail, retryAtMs: now + 300_000 }
				: { admit: true },
		)
		decoder.crash()
		await vi.advanceTimersByTimeAsync(2_001)
		expect(gate.admit).toHaveBeenCalledTimes(calls + (detail ? 1 : 2))
		expect(decoder.starts).toBe(detail ? 1 : 2)
		expect(f.provider.requestChannel).toHaveBeenCalledTimes(detail ? 1 : 2)
		expect(decoder.running).toBe(detail === null)
		if (detail) {
			expect(f.manager.getAllStatus()[0]?.suspension?.reasonCode).toBe(
				"efficiency-budget",
			)
			await vi.advanceTimersByTimeAsync(10_000)
			expect(gate.admit).toHaveBeenCalledTimes(calls + 1)
			expect(decoder.starts).toBe(1)
			expect(f.provider.requestChannel).toHaveBeenCalledTimes(1)
		}
	},
)

it("a restarted placement stays under probation sampling after downtime", async () => {
	const gate = fakeGate()
	const f = setup("rate-test", gate)
	f.create("a")
	const placement = f.place("a", 162_000_000)
	f.plan([placement])
	await f.manager.startDecoder("a")
	const decoder = f.instances.get("a")!
	decoder.crash()
	await vi.advanceTimersByTimeAsync(2_001)
	expect(decoder.running).toBe(true)
	vi.mocked(gate.probation).mockImplementation(running =>
		running.map(item => ({ key: item.key, detail: "cpu" as const })),
	)
	await vi.advanceTimersByTimeAsync(4_001)
	expect(decoder.running).toBe(false)
	expect(f.manager.getAllStatus()[0]?.suspension?.reasonCode).toBe(
		"efficiency-budget",
	)
})

it.each(["scanner hold", "unusable rate"])(
	"resuming the sole placement after %s re-arms probation sampling",
	async reason => {
		const gate = fakeGate()
		const f = setup("rate-test", gate)
		f.create("a")
		f.plan([f.place("a", 162_000_000)])
		await f.manager.startAll()
		if (reason === "scanner hold")
			await f.manager.holdSource("rtl", "tuner-scanning", "scan")
		else {
			f.sources.setRate("rtl", 1)
			await f.settle()
		}
		expect(f.instances.get("a")?.running).toBe(false)
		await vi.advanceTimersByTimeAsync(35_000)
		const calls = vi.mocked(gate.admit).mock.calls.length
		if (reason === "scanner hold") await f.manager.releaseSource("rtl", "scan")
		else f.sources.setRate("rtl", 2_400_000)
		await f.settle()
		expect(gate.admit).toHaveBeenCalledTimes(calls + 2)
		expect(f.instances.get("a")?.running).toBe(true)
		vi.mocked(gate.probation).mockImplementation(running =>
			running.map(item => ({ key: item.key, detail: "cpu" as const })),
		)
		await vi.advanceTimersByTimeAsync(2500)
		expect(f.instances.get("a")?.running).toBe(false)
	},
)

it("channel failure discards approval and restarts with a fresh probation window", async () => {
	const gate = fakeGate()
	const f = setup("rate-test", gate)
	f.create("a")
	f.plan([f.place("a", 162_000_000)])
	const available = f.provider.requestChannel.getMockImplementation()!
	f.provider.requestChannel.mockResolvedValue({
		ok: false,
		reasonCode: "channelizer-unavailable",
		detail: "offline",
	})
	await f.manager.startAll()
	expect(f.instances.get("a")?.running).toBe(false)
	await vi.advanceTimersByTimeAsync(35_000)
	const calls = vi.mocked(gate.admit).mock.calls.length
	vi.mocked(gate.admit).mockImplementation((_placement, _running, now) => ({
		admit: false,
		detail: "cpu",
		retryAtMs: now + 300_000,
	}))
	f.provider.requestChannel.mockImplementation(available)
	await vi.advanceTimersByTimeAsync(16_000)
	expect(gate.admit).toHaveBeenCalledTimes(calls + 1)
	expect(f.instances.get("a")?.starts).toBe(0)
	vi.mocked(gate.admit).mockReturnValue({ admit: true })
	await vi.advanceTimersByTimeAsync(303_000)
	expect(f.instances.get("a")?.running).toBe(true)
	vi.mocked(gate.probation).mockImplementation(running =>
		running.map(item => ({ key: item.key, detail: "drops" as const })),
	)
	await vi.advanceTimersByTimeAsync(2500)
	expect(f.instances.get("a")?.running).toBe(false)
})

it.each(
	[
		"boot",
		"mode",
		"operator start",
		"operator restart",
		"crash restart",
		"scanner hold",
		"unusable rate",
		"caps change",
		"source reconnect",
		"channel available",
		"settings rebuild",
	].flatMap(path => [false, true].map(worker => ({ path, worker }))),
)(
	"placement start uses admission and sampling through one routine: $path, worker=$worker",
	async ({ path, worker }) => {
		const gate = fakeGate()
		const f = setup("rate-test", gate)
		f.create("a")
		const primary = f.place("a", 162_000_000)
		const placement = worker
			? { ...f.place("a", 162_025_000), primary: false }
			: primary
		f.plan(worker ? [primary, placement] : [placement])
		const internal = f.manager as unknown as {
			startPlacementNow: (
				state: unknown,
				canStart?: () => boolean,
			) => Promise<unknown>
		}
		const original = internal.startPlacementNow.bind(f.manager)
		let inside = false
		let starts = 0
		f.onStart(() => {
			expect(inside).toBe(true)
			expect(gate.admit).toHaveBeenCalled()
			starts++
		})
		vi.spyOn(internal, "startPlacementNow").mockImplementation(
			async (state, canStart) => {
				inside = true
				try {
					return await original(state, canStart)
				} finally {
					inside = false
				}
			},
		)
		if (path !== "boot" && path !== "operator start" && path !== "mode")
			await f.manager.startAll()
		const calls = vi.mocked(gate.admit).mock.calls.length
		if (path === "boot") await f.manager.startAll()
		else if (path === "mode") await f.manager.applyDecoderMode("a", "always")
		else if (path === "operator start")
			await f.manager.startDecoder("a", { startMode: "operator" })
		else if (path === "operator restart") await f.manager.restartDecoder("a")
		else if (path === "crash restart")
			f.instances
				.get(placement.key === primary.key ? "a" : placement.key)!
				.crash()
		else if (path === "settings rebuild") {
			f.manager.stageDecoderOptions("a", { channelHz: 162_000_001 })
			await f.manager.restartDecoder("a")
		} else if (path === "scanner hold") {
			await f.manager.holdSource("rtl", "tuner-scanning", "scan")
			await f.manager.releaseSource("rtl", "scan")
		} else if (path === "source reconnect") {
			f.sources.remove("rtl")
			await f.settle()
			f.sources.reconnect("rtl", 2_400_000)
			f.sources.setCenter("rtl", 162_000_000)
		} else if (path === "channel available") {
			await f.manager.holdSource("rtl", "tuner-scanning", "scan")
			f.manager.setChannelizer(null)
			await f.manager.releaseSource("rtl", "scan")
			f.manager.setChannelizer(f.provider as unknown as ChannelProvider)
			await f.settle()
		} else {
			f.sources.setRate("rtl", path === "unusable rate" ? 1 : 1_024_000)
			await f.settle()
			f.sources.setRate("rtl", 2_400_000)
		}
		await vi.advanceTimersByTimeAsync(2500)
		expect(gate.admit).toHaveBeenCalledTimes(
			calls +
				(worker && path === "caps change"
					? 12
					: worker && path === "source reconnect"
						? 6
						: (path === "caps change" ? 4 : 2) *
							(worker && path !== "crash restart" ? 2 : 1)),
		)
		expect(f.instances.get("a")?.running).toBe(true)
		if (worker) expect(f.instances.get(placement.key)?.running).toBe(true)
		expect(gate.admit).toHaveBeenCalledTimes(starts * 2)
		const samples = vi.mocked(gate.probation).mock.calls.length
		await vi.advanceTimersByTimeAsync(2500)
		expect(vi.mocked(gate.probation).mock.calls.length).toBeGreaterThan(samples)
	},
)

it("channel acquisition delay cannot consume the new run's probation window", async () => {
	const gate = fakeGate()
	const f = setup("rate-test", gate)
	f.create("a")
	f.plan([f.place("a", 162_000_000)])
	const available = f.provider.requestChannel.getMockImplementation()!
	let release!: () => void
	const pending = new Promise<void>(resolve => {
		release = resolve
	})
	f.provider.requestChannel.mockImplementation(async () => {
		await pending
		return available()
	})
	const starting = f.manager.startAll()
	await vi.advanceTimersByTimeAsync(35_000)
	expect(f.instances.get("a")?.starts).toBe(0)
	release()
	await starting
	const startedAt = performance.now()
	vi.mocked(gate.probation).mockImplementation(running => {
		expect(running[0]?.admittedAtMs).toBe(startedAt)
		return running.map(item => ({ key: item.key, detail: "cpu" as const }))
	})
	await vi.advanceTimersByTimeAsync(2500)
	expect(f.instances.get("a")?.running).toBe(false)
})

it("a gate denial after channel acquisition prevents the process start and releases the channel", async () => {
	const gate = fakeGate()
	const f = setup("rate-test", gate)
	f.create("a")
	f.plan([f.place("a", 162_000_000)])
	vi.mocked(gate.admit)
		.mockReturnValueOnce({ admit: true })
		.mockImplementation((_placement, _running, now) => ({
			admit: false,
			detail: "cpu",
			retryAtMs: now + 300_000,
		}))
	await f.manager.startAll()
	expect(f.provider.requestChannel).toHaveBeenCalledTimes(1)
	expect(f.provider.releaseChannel).toHaveBeenCalledTimes(1)
	expect(f.instances.get("a")?.starts).toBe(0)
})

it("operator stop during placement startup cannot leave a late process running", async () => {
	const f = setup("rate-test", fakeGate())
	f.create("a")
	f.plan([f.place("a", 162_000_000)])
	const decoder = f.instances.get("a")!
	const pending = deferred()
	decoder.startGate = pending
	const starting = f.manager.startAll()
	await vi.advanceTimersByTimeAsync(1)
	expect(decoder.starts).toBe(1)
	await f.manager.stopDecoder("a")
	pending.resolve()
	await starting
	await vi.advanceTimersByTimeAsync(0)
	expect(decoder.running).toBe(false)
})

it("pending adapter starts retain their budget after desire changes", async () => {
	const gate = sampledGate(0.14)
	const f = setup("rate-test", gate)
	f.create("a")
	f.create("b")
	f.plan([f.place("a", 162_000_000), f.place("b", 162_025_000)])
	const pending = deferred()
	f.instances.get("a")!.startGate = pending
	const starting = f.manager.startDecoder("a")
	await vi.advanceTimersByTimeAsync(1)
	await f.manager.stopDecoder("a")
	const internal = f.manager as unknown as {
		decoders: Map<
			string,
			{
				lifecycle: PlacementLifecycle
				placement: WantedPlacement
				desiredRunning: boolean
				intentionallyStopped: boolean
			}
		>
		startPlacement: (state: unknown) => Promise<unknown>
	}
	const restarting = internal.decoders.get("a")!.lifecycle.request("running")
	await vi.advanceTimersByTimeAsync(1)
	const b = internal.decoders.get("b")!
	b.placement = f.place("b", 162_025_000)
	b.desiredRunning = true
	await internal.startPlacement(b)
	expect(f.instances.get("b")!.starts).toBe(0)
	expect(
		vi
			.mocked(gate.admit)
			.mock.calls.at(-1)![1]
			.map(p => p.key),
	).toContain(f.place("a", 162_000_000).key)
	pending.resolve()
	await vi.advanceTimersByTimeAsync(1)
	await Promise.allSettled([starting, restarting])
})

it.each(["resolve", "never"] as const)(
	"bounds a %s stop and accounts for its late exit",
	async result => {
		const gate = fakeGate()
		const f = setup("rate-test", gate)
		f.create("a")
		f.plan([f.place("a", 162_000_000)])
		await f.manager.startAll()
		const decoder = f.instances.get("a")!
		const kill = vi.spyOn(process, "kill").mockReturnValue(true)
		const status = decoder.getStatus.bind(decoder)
		vi.spyOn(decoder, "getStatus").mockImplementation(() => ({
			...status(),
			pid: 123456,
		}))
		vi.spyOn(decoder, "stop").mockImplementation(() =>
			result === "resolve" ? Promise.resolve() : new Promise(() => {}),
		)
		const internal = f.manager as unknown as {
			decoders: Map<
				string,
				{
					lifecycle: PlacementLifecycle
				}
			>
			runningPlacements: () => unknown[]
		}
		try {
			const stopping = f.manager.stopDecoder("a").catch(() => {})
			await vi.advanceTimersByTimeAsync(5000)
			await stopping
			const actor = internal.decoders.get("a")!.lifecycle
			expect(actor.pending).toBe(false)
			expect(actor.actual).toBe("stopping-failed")
			expect(kill).toHaveBeenCalledExactlyOnceWith(-123456, "SIGKILL")
			expect(internal.runningPlacements()).toHaveLength(1)
			const retry = f.manager.stopDecoder("a").catch(() => {})
			await vi.advanceTimersByTimeAsync(5000)
			await retry
			expect(decoder.stop).toHaveBeenCalledTimes(2)
			expect(kill).toHaveBeenCalledTimes(2)
			decoder.running = false
			decoder.emit("exit", 0, "SIGKILL")
			await vi.advanceTimersByTimeAsync(0)
			expect(actor.actual).toBe("idle")
			expect(internal.runningPlacements()).toHaveLength(0)
		} finally {
			kill.mockRestore()
		}
	},
)

it.each([false, true])(
	"confirmed exit cancels a hanging stop deadline during destroy: %s",
	async destroying => {
		const f = setup("rate-test", fakeGate())
		f.create("a")
		f.plan([f.place("a", 162_000_000)])
		await f.manager.startAll()
		const decoder = f.instances.get("a")!
		vi.spyOn(decoder, "stop").mockImplementation(() => new Promise(() => {}))
		const baselineTimers = vi.getTimerCount()
		const stopping = destroying
			? f.manager.destroy()
			: f.manager.stopDecoder("a")
		await vi.advanceTimersByTimeAsync(0)
		decoder.running = false
		decoder.emit("exit", 0, "SIGTERM")
		await vi.advanceTimersByTimeAsync(0)
		await stopping
		expect(vi.getTimerCount()).toBe(destroying ? 0 : baselineTimers)
		await f.manager.destroy()
		expect(vi.getTimerCount()).toBe(0)
	},
)

// Feature: decoder-enablement, Property 12: Placement lifecycle is serial
// Validates: Requirements 2.5, 3.7, 4.1, 4.2, 4.3, 11.3
it("manager serializes generated desires with independent adapter events", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.record({
				admit: fc.boolean(),
				desires: fc.array(
					fc.record({
						running: fc.boolean(),
						restart: fc.boolean(),
						appearance: fc.boolean(),
						start: fc.constantFrom("resolve", "reject", "never"),
						stop: fc.constantFrom("resolve", "reject", "never"),
						exit: fc.boolean(),
						lateExit: fc.boolean(),
						elapsed: fc.integer({ min: 0, max: 5100 }),
					}),
					{ minLength: 1, maxLength: 20 },
				),
				appearance: fc.boolean(),
				startResult: fc.constantFrom("resolve", "reject", "never"),
				stopResult: fc.constantFrom("resolve", "reject", "never"),
				exit: fc.boolean(),
				remove: fc.boolean(),
				delay: fc.integer({ min: 0, max: 6000 }),
			}),
			async scenario => {
				const gate = fakeGate()
				const f = setup("rate-test", gate)
				f.create("a")
				const placement = f.place("a", 162_000_000)
				f.plan([placement])
				const decoder = f.instances.get("a")!
				const internal = f.manager as unknown as {
					decoders: Map<
						string,
						{
							lifecycle: PlacementLifecycle
							placement: WantedPlacement
							desiredRunning: boolean
							intentionallyStopped: boolean
						}
					>
					startPlacement: (state: unknown) => Promise<unknown>
					stopPlacement: (state: unknown) => Promise<void>
					runningPlacements: () => Array<{ key: string }>
				}
				const state = internal.decoders.get("a")!
				state.placement = placement
				state.desiredRunning = true
				const processes = new Set<number>()
				const appearances: number[] = []
				const exits: number[] = []
				const admissionGenerations: number[] = []
				let nextProcess = 0
				const appear = () => {
					const process = appearances.shift()
					if (process === undefined) return
					processes.add(process)
					exits.push(process)
					decoder.running = processes.size > 0
					decoder.emit("started")
				}
				const exit = (late: boolean) => {
					const process = late ? exits[0] : exits.pop()
					if (process === undefined) return
					processes.delete(process)
					decoder.running = processes.size > 0
					decoder.emit("exit", 0, "SIGTERM")
				}
				const starts: Array<ReturnType<typeof deferred> & { process: number }> =
					[]
				const stops: ReturnType<typeof deferred>[] = []
				const settleStart = (result: string) => {
					if (result === "never") return
					const pending = starts.shift()
					if (!pending) return
					// A settled spawn with no process confirms that attempt has ended.
					const queued = appearances.indexOf(pending.process)
					if (queued >= 0) appearances.splice(queued, 1)
					if (result === "resolve") pending.resolve()
					else pending.reject(new Error("start failed"))
				}

				vi.mocked(gate.admit).mockImplementation((_p, _running, now) => {
					if (scenario.admit) {
						admissionGenerations.push(state.lifecycle.runGeneration)
						return { admit: true }
					}
					return { admit: false, detail: "budget", retryAtMs: now + 300000 }
				})
				vi.spyOn(decoder, "start").mockImplementation(() => {
					expect(vi.mocked(gate.admit).mock.results.at(-1)?.value).toEqual({
						admit: true,
					})
					expect(admissionGenerations).toContain(state.lifecycle.runGeneration)
					appearances.push(++nextProcess)
					const pending = deferred()
					starts.push({ ...pending, process: nextProcess })
					return pending.promise
				})
				vi.spyOn(decoder, "stop").mockImplementation(() => {
					const pending = deferred()
					stops.push(pending)
					return pending.promise
				})
				const requests: Promise<unknown>[] = []
				let settled = 0
				const track = (promise: Promise<unknown>) => {
					requests.push(
						promise
							.catch(() => {})
							.finally(() => {
								settled++
							}),
					)
				}
				track(internal.startPlacement(state))
				await vi.advanceTimersByTimeAsync(1)
				for (const command of scenario.desires) {
					const running = command.running
					track(
						running
							? command.restart
								? f.manager.restartDecoder("a")
								: f.manager.startDecoder("a")
							: f.manager.stopDecoder("a"),
					)
					await vi.advanceTimersByTimeAsync(0)
					if (command.appearance) appear()
					settleStart(command.start)
					if (command.stop === "resolve") stops.shift()?.resolve()
					if (command.stop === "reject")
						stops.shift()?.reject(new Error("stop failed"))
					if (command.exit) exit(command.lateExit)
					await vi.advanceTimersByTimeAsync(command.elapsed)
					expect(processes.size).toBeLessThanOrEqual(1)
					if (starts.length && !decoder.running)
						expect(internal.runningPlacements().map(p => p.key)).toContain(
							placement.key,
						)
				}
				const lastDesired = scenario.remove
					? "stopped"
					: scenario.desires.at(-1)?.running
						? "running"
						: "stopped"
				if (scenario.remove) track(f.manager.removeDecoder("a"))
				await vi.advanceTimersByTimeAsync(scenario.delay)
				if (scenario.appearance) appear()
				settleStart(scenario.startResult)
				await vi.advanceTimersByTimeAsync(0)
				if (scenario.stopResult === "resolve") stops.shift()?.resolve()
				if (scenario.stopResult === "reject")
					stops.shift()?.reject(new Error("stop failed"))
				if (scenario.exit) exit(false)
				await vi.advanceTimersByTimeAsync(5001)
				expect(processes.size).toBeLessThanOrEqual(1)
				if (scenario.admit) expect(state.lifecycle.desired).toBe(lastDesired)
				else expect(decoder.running).toBe(false)
				if (processes.size || starts.length)
					expect(internal.runningPlacements().map(p => p.key)).toContain(
						placement.key,
					)
				if (lastDesired === "stopped" && processes.size)
					expect(state.lifecycle.actual).toBe("stopping-failed")
				if (
					lastDesired === "running" &&
					processes.size &&
					!state.lifecycle.pending
				)
					expect(["running", "stopping-failed"]).toContain(
						state.lifecycle.actual,
					)
				if (!processes.size && !starts.length)
					expect(state.lifecycle.actual).toBe("idle")
				// Complete every retained and future operation without changing the last desire.
				vi.mocked(gate.admit).mockImplementation(() => {
					admissionGenerations.push(state.lifecycle.runGeneration)
					return { admit: true }
				})
				delete (state as typeof state & { admission?: unknown }).admission
				track(
					lastDesired === "running"
						? internal.startPlacement(state)
						: internal.stopPlacement(state),
				)
				for (let turn = 0; turn < 12; turn++) {
					if (turn === 6)
						track(
							lastDesired === "running"
								? internal.startPlacement(state)
								: internal.stopPlacement(state),
						)
					await vi.advanceTimersByTimeAsync(2500)
					while (appearances.length) appear()
					while (starts.length) settleStart("resolve")
					if (stops.length) {
						processes.clear()
						decoder.running = false
						decoder.emit("exit", 0, "SIGTERM")
						while (stops.length) stops.shift()!.resolve()
					}
				}
				await vi.advanceTimersByTimeAsync(0)
				expect(state.lifecycle.desired).toBe(lastDesired)
				expect(state.lifecycle.actual).toBe(
					lastDesired === "running" ? "running" : "idle",
				)
				expect(processes.size).toBe(lastDesired === "running" ? 1 : 0)
				expect(starts).toHaveLength(0)
				await Promise.all(requests)
				expect(settled).toBe(requests.length)
				vi.mocked(decoder.stop).mockImplementation(async () => {
					processes.clear()
					decoder.running = false
					decoder.emit("exit", 0, "SIGTERM")
				})
				const destroying = f.manager.destroy().catch(() => {})
				await vi.advanceTimersByTimeAsync(5001)
				await destroying
				manager = undefined
			},
		),
		{ numRuns: 200 },
	)
})

function realGate(budgetCores = 1) {
	const drops = {
		state: "ok" as "ok" | "dropping" | "unknown",
		droppedSince: false,
	}
	const reader: DropReader = {
		dropState: () => ({ state: drops.state, dropBytesPerSecond: 0 }),
		monoNow: () => performance.now(),
		sources: () => ["rtl"],
		droppedSinceMono: () => drops.droppedSince,
		droppedWithinMs: () => drops.droppedSince,
	}
	return {
		drops,
		gate: createEfficiencyGate(
			{ budgetCores, cpuGuardPercent: 90 },
			{ drops: reader },
		),
	}
}

it("the manager admits, reports and probation-suspends through the real efficiency gate", async () => {
	const { drops, gate } = realGate()
	const f = setup("rate-test", gate)
	f.create("dec")
	const placement = f.place("dec", 162_000_000)
	f.plan([placement])
	await f.manager.startAll()
	expect(f.instances.get("dec")?.running).toBe(true)
	let view = f.manager.efficiencyView()
	expect(view.sources[0]?.admitted).toEqual([
		{
			decoderId: "dec",
			sourceId: "rtl",
			channelHz: 162_000_000,
			reach: "channel",
			costCores: 0.14,
			probation: true,
		},
	])
	// Unknown drop evidence fails closed for a newcomer.
	drops.state = "unknown"
	const worker = f.place("dec", 162_050_000, false)
	f.plan([placement, worker])
	const before = Date.now()
	await f.settle()
	expect(f.instances.get(worker.key)?.running).toBe(false)
	expect(
		f.manager.getStatus("dec")?.placements?.find(item => !item.primary)
			?.efficiencyDetail,
	).toBe("unknown")
	view = f.manager.efficiencyView()
	expect(view.sources[0]?.blocked).toEqual([
		{
			decoderId: "dec",
			sourceId: "rtl",
			channelHz: 162_050_000,
			reach: "channel",
			costCores: 0.14,
			probation: false,
			detail: "unknown",
			retryAt: expect.any(String),
		},
	])
	const retryAt = Date.parse(view.sources[0]?.blocked[0]?.retryAt ?? "")
	expect(retryAt).toBeGreaterThanOrEqual(before + EFFICIENCY_RETRY_MS)
	expect(retryAt).toBeLessThanOrEqual(Date.now() + EFFICIENCY_RETRY_MS)
	// Drops during probation suspend the newest running placement.
	drops.state = "ok"
	drops.droppedSince = true
	await vi.advanceTimersByTimeAsync(2000)
	expect(f.instances.get("dec")?.running).toBe(false)
	expect(f.manager.getStatus("dec")?.efficiency?.detail).toBe("drops")
	expect(f.manager.getStatus("dec")?.suspension?.reasonCode).toBe(
		"efficiency-budget",
	)
})

it("a placement past probation is never suspended by the real gate", async () => {
	const { drops, gate } = realGate()
	const f = setup("rate-test", gate)
	f.create("dec")
	f.plan([f.place("dec", 162_000_000)])
	await f.manager.startAll()
	await vi.advanceTimersByTimeAsync(30_000)
	expect(f.manager.efficiencyView().sources[0]?.admitted[0]?.probation).toBe(
		false,
	)
	drops.droppedSince = true
	await vi.advanceTimersByTimeAsync(4000)
	expect(f.instances.get("dec")?.running).toBe(true)
})

it("a gate verdict suspends a placement whose wall-clock admission is past probation", async () => {
	const gate = fakeGate()
	const f = setup("rate-test", gate)
	f.create("dec")
	const placement = f.place("dec", 162_000_000)
	f.plan([placement])
	await f.manager.startAll()
	// A forward wall-clock jump puts the admission outside the probation window.
	vi.setSystemTime(Date.now() + EFFICIENCY_PROBATION_MS + 60_000)
	gate.probation = vi.fn<EfficiencyGate["probation"]>(() => [
		{ key: placement.key, detail: "drops" },
	])
	await vi.advanceTimersByTimeAsync(2000)
	expect(gate.noteSuspended).toHaveBeenCalledWith(
		placement.key,
		"drops",
		expect.any(Number),
	)
	expect(f.instances.get("dec")?.running).toBe(false)
	expect(f.manager.getStatus("dec")?.efficiency?.detail).toBe("drops")
})

it("the real gate's monotonic probation survives a forward wall-clock jump", async () => {
	const drops = { droppedSince: false }
	let mono = 0
	const f = setup(
		"rate-test",
		createEfficiencyGate(
			{ budgetCores: 1, cpuGuardPercent: 90 },
			{
				drops: {
					dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
					monoNow: () => mono,
					sources: () => ["rtl"],
					droppedSinceMono: () => drops.droppedSince,
					droppedWithinMs: () => drops.droppedSince,
				},
			},
		),
	)
	f.create("dec")
	f.plan([f.place("dec", 162_000_000)])
	await f.manager.startAll()
	vi.setSystemTime(Date.now() + EFFICIENCY_PROBATION_MS + 60_000)
	mono += 1000
	drops.droppedSince = true
	await vi.advanceTimersByTimeAsync(2000)
	expect(f.instances.get("dec")?.running).toBe(false)
	expect(f.manager.getStatus("dec")?.efficiency?.detail).toBe("drops")
})

it("a probation verdict is not applied to a run that restarted while an earlier suspension was pending", async () => {
	const gate = fakeGate()
	const f = setup("rate-test", gate)
	f.create("a")
	f.create("b")
	const first = f.place("a", 162_000_000)
	const second = f.place("b", 162_050_000)
	f.plan([first, second])
	await f.manager.startAll()
	const a = f.instances.get("a")!
	const b = f.instances.get("b")!
	expect(a.running && b.running).toBe(true)
	const stop = a.stop.bind(a)
	const release = deferred()
	vi.spyOn(a, "stop").mockImplementationOnce(async () => {
		await release.promise
		await stop()
	})
	vi.mocked(gate.probation).mockReturnValueOnce([
		{ key: first.key, detail: "drops" },
		{ key: second.key, detail: "drops" },
	])
	await vi.advanceTimersByTimeAsync(2000)
	expect(gate.noteSuspended).toHaveBeenCalledTimes(1)
	// While the first suspension waits, the second placement starts a new run.
	await f.manager.restartDecoder("b")
	expect(b.starts).toBe(2)
	release.resolve()
	await vi.advanceTimersByTimeAsync(1)
	expect(a.running).toBe(false)
	expect(gate.noteSuspended).toHaveBeenCalledTimes(1)
	expect(gate.noteSuspended).not.toHaveBeenCalledWith(
		second.key,
		expect.anything(),
		expect.anything(),
	)
	expect(b.running).toBe(true)
	expect(f.manager.getStatus("b")?.efficiency).toBeUndefined()
})

it("overlapping probation passes do not apply a verdict twice", async () => {
	const gate = fakeGate()
	const f = setup("rate-test", gate)
	f.create("a")
	const first = f.place("a", 162_000_000)
	f.plan([first])
	await f.manager.startAll()
	const a = f.instances.get("a")!
	const stop = a.stop.bind(a)
	const release = deferred()
	vi.spyOn(a, "stop").mockImplementationOnce(async () => {
		await release.promise
		await stop()
	})
	vi.mocked(gate.probation).mockReturnValue([
		{ key: first.key, detail: "drops" },
	])
	const internal = f.manager as unknown as {
		applyProbation(): Promise<void>
	}
	const before = vi.mocked(gate.probation).mock.calls.length
	const passes = [internal.applyProbation(), internal.applyProbation()]
	await vi.advanceTimersByTimeAsync(0)
	const probations = vi.mocked(gate.probation).mock.calls.length - before
	const suspensions = vi.mocked(gate.noteSuspended).mock.calls.length
	release.resolve()
	// The second caller joined the pass still awaiting its suspension.
	expect(probations).toBe(1)
	expect(suspensions).toBe(1)
	await vi.advanceTimersByTimeAsync(1)
	await Promise.all(passes)
	expect(gate.noteSuspended).toHaveBeenCalledTimes(1)
	expect(a.running).toBe(false)
})

it("a call joining an in-flight probation pass gets exactly one follow-up pass", async () => {
	const gate = fakeGate()
	const f = setup("rate-test", gate)
	f.create("a")
	f.create("b")
	const first = f.place("a", 162_000_000)
	const second = f.place("b", 162_050_000)
	f.plan([first, second])
	await f.manager.startAll()
	const a = f.instances.get("a")!
	const b = f.instances.get("b")!
	const stop = a.stop.bind(a)
	const release = deferred()
	vi.spyOn(a, "stop").mockImplementationOnce(async () => {
		await release.promise
		await stop()
	})
	const internal = f.manager as unknown as {
		applyProbation(): Promise<void>
	}
	const before = vi.mocked(gate.probation).mock.calls.length
	vi.mocked(gate.probation).mockReturnValueOnce([
		{ key: first.key, detail: "drops" },
	])
	const pass = internal.applyProbation()
	await Promise.resolve()
	expect(vi.mocked(gate.probation).mock.calls.length - before).toBe(1)
	// Evidence for the second probationer arrives after the pass asked the gate.
	vi.mocked(gate.probation).mockImplementation(running =>
		running.some(item => item.key === second.key)
			? [{ key: second.key, detail: "drops" }]
			: [],
	)
	const joins = Array.from({ length: 5 }, () => internal.applyProbation())
	release.resolve()
	await Promise.all([pass, ...joins])
	expect(vi.mocked(gate.probation).mock.calls.length - before).toBe(2)
	expect(a.running).toBe(false)
	expect(b.running).toBe(false)
	expect(gate.noteSuspended).toHaveBeenCalledWith(
		second.key,
		"drops",
		expect.any(Number),
	)
	expect(gate.noteSuspended).toHaveBeenCalledTimes(2)
})

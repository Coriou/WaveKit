import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import fc from "fast-check"
import { createActivityIngress } from "../../../../src/core/activity/ingress.js"
import type { DecodeEnvelope } from "../../../../src/core/activity/types.js"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import type { DecoderManagerConfig } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type { ChannelProvider } from "../../../../src/core/channelizer/types.js"
import type {
	EfficiencyGate,
	PlannerInput,
	PlacementPlan,
	PlacementPlanner,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import { placementKey } from "../../../../src/decoders/enablement/contract.js"
import type { Decoder } from "../../../../src/decoders/types.js"
import {
	FakeSources,
	RateDecoder,
	deferred,
	iqCaps,
} from "../../../mocks/rate-fakes.js"

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	vi.useRealTimers()
})

function setup(
	type = "rate-test",
	gate?: EfficiencyGate,
	config: Partial<DecoderManagerConfig> = {},
) {
	vi.useFakeTimers()
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 162_000_000 })
	const instances = new Map<string, RateDecoder>()
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
			let options = { ...config.options }
			configs.set(config.id, options)
			decoder.updateOptions = updates => {
				options = { ...options, ...updates }
				config.options = options
				configs.set(config.id, options)
			}
			decoder.getChannelRequest = () => ({
				centerHz: options["channelHz"] as number,
				bandwidthHz: (options["bandwidthHz"] as number | undefined) ?? 12_500,
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
	let unavailable = false
	let wanted: WantedPlacement[] = []
	let unplaced: PlacementPlan["unplaced"] = new Map()
	const planner = vi.fn<PlacementPlanner>(() => ({ wanted, unplaced }))
	const info = vi.fn()
	const logger = pino({
		level: "silent",
		onChild(child) {
			vi.spyOn(child, "info").mockImplementation(info)
		},
	})
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		...config,
		validateVersions: false,
		enablement: {
			planner,
			...(gate ? { gate } : {}),
			resolveMode: () => ({ mode: "auto", source: "default" }),
			isCatalogue: () => true,
			unavailable: () => unavailable,
			recheckAvailable: async () => true,
			vfo: () => null,
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
		},
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	const provider = Object.assign(new EventEmitter(), {
		requestChannel: vi.fn(async () => ({
			ok: true as const,
			stream: new PassThrough(),
			channelId: String(++channel),
			generation: 1,
			realised: {
				outputRateHz: 48_000,
				format: "cu8" as const,
				groupDelaySamples: 0,
			},
		})),
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
		planner,
		info,
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

it("162.0 MHz with channelizer: AIS, dsd-fme VFO and multimon-ng VFO run; GET list shows three decoders", async () => {
	const f = setup()
	for (const id of ["ais", "dsd", "multi"]) f.create(id)
	f.plan([
		f.place("ais", 162_000_000),
		f.place("dsd", 162_010_000, true, "vfo"),
		f.place("multi", 162_010_000, true, "vfo"),
	])
	await f.manager.startAll()
	expect(f.manager.getAllStatus()).toHaveLength(3)
	expect(f.manager.getAllStatus().every(status => status.running)).toBe(true)
	expect(f.provider.requestChannel).toHaveBeenCalledTimes(3)
})

it("each channel placement reports its decoder's channel width", async () => {
	const f = setup()
	f.create("narrow")
	f.create("wide", { bandwidthHz: 25_000 })
	f.plan([
		f.place("narrow", 162_000_000),
		f.place("narrow", 162_025_000, false),
		f.place("wide", 162_050_000),
		f.place("wide", 162_100_000, false),
	])
	await f.manager.startAll()
	const widths = (id: string) =>
		f.manager.getStatus(id)?.placements?.map(p => p.channelWidthHz)
	expect(widths("narrow")).toEqual([12_500, 12_500])
	expect(widths("wide")).toEqual([25_000, 25_000])
})

it("a channel placement whose decoder makes no valid request omits its width", async () => {
	const f = setup()
	f.create("dec")
	f.plan([f.place("dec", 162_000_000)])
	await f.manager.startAll()
	f.instances.get("dec")!.getChannelRequest = () => ({ invalid: "no centre" })
	const placement = f.manager.getStatus("dec")?.placements?.[0]
	expect(placement?.reach).toBe("channel")
	expect(placement).not.toHaveProperty("channelWidthHz")
})

it("worker output is emitted under the parent id with the placement frequency", async () => {
	const f = setup()
	f.create("dec")
	f.plan([f.place("dec", 162_000_000), f.place("dec", 162_025_000, false)])
	await f.manager.startAll()
	const output = vi.fn()
	f.manager.on("decoder:output", output)
	f.instances
		.get(placementKey("dec", "rtl", "channel", 162_025_000))!
		.emit("output", {
			decoder: "worker",
			type: "message",
			timestamp: new Date(),
			data: {},
		})
	expect(output).toHaveBeenCalledWith(
		"dec",
		expect.objectContaining({
			decoder: "dec",
			provenanceBinding: { sourceId: "rtl", channelHz: 162_025_000 },
		}),
	)
})

it("worker never appears in decoder:created or the list", async () => {
	const f = setup()
	const created = vi.fn()
	const removed = vi.fn()
	f.manager.on("decoder:created", created)
	f.manager.on("decoder:removed", removed)
	f.create("dec")
	f.plan([f.place("dec", 162_000_000), f.place("dec", 162_025_000, false)])
	await f.manager.startAll()
	expect(f.manager.getAllDecoders().map(decoder => decoder.id)).toEqual(["dec"])
	expect(created.mock.calls).toEqual([["dec"]])
	f.plan([f.place("dec", 162_000_000)])
	await f.settle()
	expect(removed).not.toHaveBeenCalled()
})

it("worker log lines carry the [channelHz] prefix", async () => {
	const f = setup()
	f.create("dec")
	f.plan([f.place("dec", 162_000_000), f.place("dec", 162_025_000, false)])
	await f.manager.startAll()
	expect(f.manager.getDecoder("dec")?.getLog?.()).toContainEqual({
		stream: "stderr",
		line: "[162025000] signal",
	})
})

it("VFO burst produces one retarget", async () => {
	const f = setup()
	f.create("dec")
	f.plan([
		f.place("dec", 162_000_000),
		f.place("dec", 162_010_000, false, "vfo"),
	])
	await f.manager.startAll()
	for (const hz of [162_015_000, 162_020_000, 162_025_000]) {
		f.plan([f.place("dec", 162_000_000), f.place("dec", hz, false, "vfo")])
		f.manager.notifyVfoSettled({ sourceId: "rtl", frequencyHz: hz })
	}
	await vi.advanceTimersByTimeAsync(350)
	expect(f.provider.retuneChannel).toHaveBeenCalledTimes(1)
	expect(f.provider.requestChannel).toHaveBeenCalledTimes(2)
})

it("retune refused falls back to close and reopen", async () => {
	const f = setup()
	f.provider.retuneChannel.mockResolvedValue("refused")
	f.create("dec")
	f.plan([
		f.place("dec", 162_000_000),
		f.place("dec", 162_010_000, false, "vfo"),
	])
	await f.manager.startAll()
	f.plan([
		f.place("dec", 162_000_000),
		f.place("dec", 162_025_000, false, "vfo"),
	])
	await f.settle()
	expect(f.provider.releaseChannel).toHaveBeenCalledTimes(1)
	expect(f.provider.requestChannel).toHaveBeenCalledTimes(3)
})

it("scanner hold suspends workers with tuner-scanning", async () => {
	const f = setup()
	f.create("dec")
	f.plan([f.place("dec", 162_000_000), f.place("dec", 162_025_000, false)])
	await f.manager.startAll()
	await f.manager.holdSource("rtl", "tuner-scanning", "scan")
	expect(
		f.manager
			.getStatus("dec")
			?.placements?.every(
				placement =>
					!placement.running &&
					placement.suspension?.reasonCode === "tuner-scanning",
			),
	).toBe(true)
})

it.each([
	"tuner-scanning",
	"insufficient-sample-rate",
	"decoder-unavailable",
	"channelizer-unavailable",
	"frequency-out-of-band",
	"efficiency-budget",
] as const)("reason precedence with no placement", async reason => {
	const f = setup(
		reason === "channelizer-unavailable" ? "dsd-fme" : "rate-test",
	)
	f.create("dec")
	if (reason === "channelizer-unavailable") {
		f.manager.setChannelizer(null)
	} else f.unplaced(new Map([["dec", reason]]))
	await f.manager.startAll()
	// The fake's band is unknown: a planner out-of-band never contradicts it (3.13).
	expect(f.manager.getStatus("dec")?.suspension?.reasonCode).toBe(
		reason === "frequency-out-of-band" ? "no-channel-selected" : reason,
	)
	expect(f.instances.get("dec")?.starts).toBe(0)
})

it.each([
	{ held: true, rate: 10_000, unavailable: true, reason: "tuner-scanning" },
	{
		held: false,
		rate: 10_000,
		unavailable: true,
		reason: "insufficient-sample-rate",
	},
	{
		held: false,
		rate: 2_400_000,
		unavailable: true,
		reason: "decoder-unavailable",
	},
	{
		held: false,
		rate: 2_400_000,
		unavailable: false,
		reason: "channelizer-unavailable",
	},
])(
	"no-placement status prioritises competing blockers: $reason",
	async facts => {
		const f = setup("dsd-fme")
		f.manager.setChannelizer(null)
		f.sources.caps.set("rtl", {
			...iqCaps(facts.rate),
			centerFreq: 162_000_000,
		})
		if (facts.unavailable) f.unavailable()
		f.create("dec")
		if (facts.held) await f.manager.holdSource("rtl", "tuner-scanning", "scan")
		await f.manager.startAll()
		expect(f.manager.getStatus("dec")?.suspension?.reasonCode).toBe(
			facts.reason,
		)
		expect(f.instances.get("dec")?.starts).toBe(0)
	},
)

it("suspended primary still creates and reports suspended workers", async () => {
	const f = setup()
	f.unavailable()
	f.create("dec")
	f.plan([f.place("dec", 162_000_000), f.place("dec", 162_025_000, false)])
	await f.manager.startAll()
	expect(f.manager.getStatus("dec")?.placements).toHaveLength(2)
	for (const placement of f.manager.getStatus("dec")!.placements!) {
		expect(placement.running).toBe(false)
		expect(placement.suspension?.reasonCode).toBe("decoder-unavailable")
	}
	expect(f.provider.requestChannel).not.toHaveBeenCalled()
})

it("one failed primary start does not prevent other decoders starting", async () => {
	const f = setup()
	f.create("first")
	f.create("second")
	f.instances.get("first")!.failStart = true
	f.plan([f.place("first", 162_000_000), f.place("second", 162_025_000)])
	await f.manager.startAll()
	expect(f.instances.get("first")?.running).toBe(false)
	expect(f.instances.get("second")?.running).toBe(true)
})

it("placement option updates preserve the original configured options", async () => {
	const f = setup()
	f.create("dec")
	const configured = f.manager.getConfiguredDecoderConfigs()[0]!
	f.plan([f.place("dec", 162_000_000), f.place("dec", 162_025_000, false)])
	await f.manager.startAll()
	expect(f.manager.getConfiguredDecoderConfigs()).toEqual([configured])
	expect(configured.options).toEqual({})
})

it("operator stop during a worker retune prevents a late worker return", async () => {
	const f = setup()
	let complete!: (result: "retuned" | "refused") => void
	f.provider.retuneChannel.mockImplementation(
		() =>
			new Promise(resolve => {
				complete = resolve
			}),
	)
	f.create("dec")
	f.plan([
		f.place("dec", 162_000_000),
		f.place("dec", 162_010_000, false, "vfo"),
	])
	await f.manager.startAll()
	f.plan([
		f.place("dec", 162_000_000),
		f.place("dec", 162_025_000, false, "vfo"),
	])
	await f.settle()
	expect(f.provider.retuneChannel).toHaveBeenCalledTimes(1)
	await f.manager.stopDecoder("dec")
	complete("retuned")
	await f.settle()
	expect(f.manager.getStatus("dec")?.placements).toHaveLength(1)
	expect(f.manager.getStatus("dec")?.desiredRunning).toBe(false)
	expect(f.provider.requestChannel).toHaveBeenCalledTimes(2)
})

it.each([
	[{ channelsHz: [162_010_000, 162_020_000] }, [162_010_000, 162_020_000]],
	[{ channelHz: 162_025_000, offsetHz: 1000 }, [162_025_000]],
	[{ offsetHz: -25_000 }, [161_975_000]],
] satisfies Array<[Record<string, unknown>, number[]]>)(
	"normalizes configured channels for planning",
	async (options, expected) => {
		const f = setup()
		f.create("dec", options)
		await f.manager.startAll()
		const input: PlannerInput = f.planner.mock.calls.at(-1)![0]
		expect(input.decoders[0]?.configuredChannelsHz).toEqual(expected)
	},
)

it("removing a denied primary clears its admission before a new placement", async () => {
	const admit = vi
		.fn<EfficiencyGate["admit"]>()
		.mockReturnValueOnce({
			admit: false,
			detail: "budget",
			retryAtMs: Date.now() + 100_000,
		})
		.mockReturnValue({ admit: true })
	const forget = vi.fn()
	const f = setup("rate-test", {
		admit,
		forget,
		record: vi.fn(),
		probation: () => [],
		noteSuspended: vi.fn(),
		view: () => ({ budgetCores: 1, cpuGuardPercent: 90, sources: [] }),
	})
	f.create("dec")
	const first = f.place("dec", 162_010_000)
	f.plan([first])
	await f.manager.startAll()
	f.plan([])
	f.unplaced(new Map([["dec", "frequency-out-of-band"]]))
	await f.settle()
	expect(forget).toHaveBeenCalledWith(first.key)
	const second = f.place("dec", 162_020_000)
	f.unplaced(new Map())
	f.plan([second])
	await f.settle()
	expect(
		admit.mock.calls.some(([placement]) => placement.key === second.key),
	).toBe(true)
	expect(f.manager.getStatus("dec")?.running).toBe(true)
})

it("applied settings survive reconciliation and reach new workers", async () => {
	const f = setup()
	f.create("dec", { gain: 1 })
	f.plan([f.place("dec", 162_000_000)])
	await f.manager.startAll()
	f.manager.stageDecoderOptions("dec", { gain: 2 })
	await f.manager.restartDecoder("dec")
	f.plan([f.place("dec", 162_000_000), f.place("dec", 162_025_000, false)])
	await f.settle()
	expect(f.configs.get("dec")?.["gain"]).toBe(2)
	expect(f.manager.getConfiguredDecoderConfigs()[0]?.options).toEqual({
		gain: 1,
	})
	expect(
		f.configs.get(placementKey("dec", "rtl", "channel", 162_025_000))?.["gain"],
	).toBe(2)
})

it("logs one fixed-field info event when a placement is removed", async () => {
	const f = setup()
	f.create("dec")
	const placement = f.place("dec", 162_000_000)
	f.plan([placement])
	await f.manager.startAll()
	f.info.mockClear()
	f.plan([])
	await f.settle()
	const events = f.info.mock.calls.filter(
		call => call[1] === "Decoder placement changed",
	)
	expect(events).toEqual([
		[
			{
				decoderId: "dec",
				sourceId: "rtl",
				placementKey: placement.key,
				channelHz: 162_000_000,
				reasonCode: "removed",
			},
			"Decoder placement changed",
		],
	])
})

it("worker log lines keep their prefix after a settings restart", async () => {
	const f = setup()
	f.create("dec")
	f.plan([f.place("dec", 162_000_000), f.place("dec", 162_025_000, false)])
	await f.manager.startAll()
	const previous = f.manager.getDecoder("dec")
	f.manager.stageDecoderOptions("dec", { gain: 2 })
	await f.manager.restartDecoder("dec")
	expect(f.manager.getDecoder("dec")).not.toBe(previous)
	expect(f.manager.getDecoder("dec")?.getLog?.()).toContainEqual({
		stream: "stderr",
		line: "[162025000] signal",
	})
})

it("placement output keeps payload frequency and parent trust without a binding seam", async () => {
	const f = setup()
	f.create("dec")
	f.plan([f.place("dec", 162_000_000)])
	await f.manager.startAll()
	vi.useRealTimers()
	const envelopes: DecodeEnvelope[] = []
	const ingress = createActivityIngress({
		logger: pino({ level: "silent" }),
		resolveProvenance: () => ({
			sourceId: "rtl",
			targetFrequenciesHz: [162_000_000],
			tuningTrust: "commanded",
		}),
		sink: envelope => {
			envelopes.push(envelope)
		},
	})
	f.manager.on("decoder:output", (id, output) =>
		ingress.publish(id, "ais-catcher", output),
	)
	f.instances.get("dec")!.emit("output", {
		decoder: "dec",
		type: "ship",
		timestamp: new Date(),
		data: { channel: "A" },
	})
	expect(envelopes[0]?.provenance.frequency).toEqual({
		hz: 161_975_000,
		basis: "channel",
		tuningTrust: "commanded",
	})
})

it("a failing worker stop still stops the other workers and the primary", async () => {
	const f = setup()
	f.create("dec")
	f.plan([
		f.place("dec", 162_000_000),
		f.place("dec", 162_025_000, false),
		f.place("dec", 162_050_000, false),
	])
	await f.manager.startAll()
	const workers = [...f.instances.entries()].filter(([id]) => id !== "dec")
	expect(workers).toHaveLength(2)
	const [failing, other] = workers.map(([, decoder]) => decoder)
	if (!failing || !other) throw new Error("workers missing")
	vi.spyOn(failing, "stop").mockRejectedValueOnce(new Error("stop failed"))
	const stopping = expect(f.manager.stopDecoder("dec")).rejects.toThrow(
		"stop failed",
	)
	await vi.advanceTimersByTimeAsync(5000)
	await stopping
	expect(failing.running).toBe(true)
	expect(failing.stop).toHaveBeenCalledTimes(1)
	expect(f.manager.getDecoder(workers[0]![0])).toBe(failing)
	failing.crash()
	expect(other.running).toBe(false)
	expect(f.instances.get("dec")?.running).toBe(false)
	expect(f.manager.getStatus("dec")?.desiredRunning).toBe(false)
})

it("a worker still alive after failed escalation stays tracked until exit", async () => {
	const view = vi.fn<EfficiencyGate["view"]>(() => ({
		budgetCores: 1,
		cpuGuardPercent: 90,
		sources: [],
	}))
	const gate: EfficiencyGate = {
		record: vi.fn(),
		admit: () => ({ admit: true }),
		probation: () => [],
		noteSuspended: vi.fn(),
		forget: vi.fn(),
		view,
	}
	const f = setup("rate-test", gate)
	f.create("dec")
	const worker = f.place("dec", 162_025_000, false)
	f.plan([f.place("dec", 162_000_000), worker])
	await f.manager.startAll()
	const decoder = f.instances.get(worker.key)!
	const stop = vi
		.spyOn(decoder, "stop")
		.mockRejectedValueOnce(new Error("first stop"))
		.mockRejectedValueOnce(new Error("second stop"))
	const stopping = expect(f.manager.stopDecoder("dec")).rejects.toThrow(
		"first stop",
	)
	await vi.advanceTimersByTimeAsync(5000)
	await stopping
	expect(decoder.running).toBe(true)
	expect(f.manager.getDecoder(worker.key)).toBe(decoder)
	expect(decoder.listenerCount("exit")).toBeGreaterThan(0)
	f.manager.efficiencyView()
	expect(view.mock.calls.at(-1)?.[0].map(item => item.key)).toContain(
		worker.key,
	)
	const destroying = expect(f.manager.destroy()).rejects.toThrow(
		"Placement worker is still running",
	)
	await vi.advanceTimersByTimeAsync(5000)
	await destroying
	expect(stop).toHaveBeenCalledTimes(2)
	decoder.crash()
	await f.manager.destroy()
	expect(decoder.running).toBe(false)
	expect(f.manager.getDecoder(worker.key)).toBeUndefined()
})

it.each(["start", "stop", "restart-start", "restart-stop", "error-start"])(
	"the last parent call wins while a worker stop is deferred: %s",
	async last => {
		const f = setup()
		f.create("dec")
		const primary = f.place("dec", 162_000_000)
		const worker = f.place("dec", 162_025_000, false)
		f.plan([primary, worker])
		await f.manager.startAll()
		const decoder = f.instances.get(worker.key)!
		const originalStop = decoder.stop.bind(decoder)
		let release!: () => void
		const pending = new Promise<void>(resolve => {
			release = resolve
		})
		vi.spyOn(decoder, "stop").mockImplementationOnce(async () => {
			await pending
			await originalStop()
			if (last === "error-start") throw new Error("private adapter failure")
		})
		const stopping = f.manager.stopDecoder("dec")
		await vi.advanceTimersByTimeAsync(0)
		const calls: Promise<void>[] = [stopping]
		if (last.startsWith("restart")) calls.push(f.manager.restartDecoder("dec"))
		calls.push(f.manager.startDecoder("dec"))
		if (last.endsWith("stop")) calls.push(f.manager.stopDecoder("dec"))
		release()
		await vi.advanceTimersByTimeAsync(1)
		await expect(stopping).resolves.toBeUndefined()
		await Promise.all(calls)
		const running = !last.endsWith("stop")
		expect(f.manager.getStatus("dec")?.desiredRunning).toBe(running)
		expect(f.manager.getStatus("dec")?.running).toBe(running)
		const states = (
			f.manager as unknown as {
				decoders: Map<
					string,
					{
						lifecycle?: { desired: string; decoderGeneration: number }
						parentId?: string
						parentIntent?: { generation: number }
					}
				>
			}
		).decoders
		expect(states.get("dec")?.lifecycle?.desired).toBe(
			running ? "running" : "stopped",
		)
		for (const [id, state] of states) {
			if (state.parentId !== "dec") continue
			expect(state.lifecycle?.desired).toBe(running ? "running" : "stopped")
			expect(f.instances.get(id)?.running).toBe(running)
		}
	},
)

type LifecycleCommand =
	| "start"
	| "stop"
	| "restart"
	| "mode"
	| "crash"
	| "crash-fail"
	| "crash-hang"

async function exerciseParentGenerations(
	commands: LifecycleCommand[],
	running: boolean,
	checkBackoff = false,
) {
	const f = setup()
	f.create("dec")
	const worker = f.place("dec", 162_025_000, false)
	f.plan([f.place("dec", 162_000_000), worker])
	await f.manager.startAll()
	for (const decoder of f.instances.values()) {
		const start = decoder.start.bind(decoder)
		vi.spyOn(decoder, "start").mockImplementation(async () => {
			expect(decoder.running).toBe(false)
			await start()
		})
	}
	const decoder = f.instances.get(worker.key)!
	const stop = decoder.stop.bind(decoder)
	let release!: () => void
	const pending = new Promise<void>(resolve => {
		release = resolve
	})
	vi.spyOn(decoder, "stop").mockImplementationOnce(async () => {
		await pending
		await stop()
	})
	const calls: Promise<void>[] = []
	// Rejections are observed at the end; mark them handled meanwhile.
	const add = (call: Promise<void>) => {
		call.catch(() => undefined)
		calls.push(call)
	}
	add(f.manager.stopDecoder("dec"))
	await vi.advanceTimersByTimeAsync(0)
	add(f.manager.startDecoder("dec"))
	// Crash restarts that fail or hang past the request bound may fail
	// intermediate calls; the final state must still converge.
	const strict = commands.every(command => !command.startsWith("crash-"))
	let hangs = 0
	for (const command of commands) {
		if (command.startsWith("crash")) {
			const internal = f.manager as unknown as {
				decoders: Map<string, { lifecycle?: { actual: string } }>
			}
			const crashed: RateDecoder[] = []
			for (const [id, placement] of f.instances)
				if (
					placement.running &&
					internal.decoders.get(id)?.lifecycle?.actual === "running"
				) {
					crashed.push(placement)
					if (command === "crash-fail") placement.failStart = true
					if (command === "crash-hang") {
						const gate = deferred()
						placement.startGate = gate
						setTimeout(gate.resolve, 6000)
						hangs++
					}
					placement.crash()
				}
			// Let the 2000 ms backoff fire so its restart meets the fault.
			await vi.advanceTimersByTimeAsync(command === "crash" ? 0 : 2000)
			for (const placement of crashed) placement.failStart = false
			continue
		}
		add(
			command === "stop"
				? f.manager.stopDecoder("dec")
				: command === "restart"
					? f.manager.restartDecoder("dec")
					: command === "mode"
						? f.manager.applyDecoderMode("dec", "always")
						: f.manager.startDecoder("dec"),
		)
		await vi.advanceTimersByTimeAsync(0)
	}
	add(running ? f.manager.startDecoder("dec") : f.manager.stopDecoder("dec"))
	release()
	// Releasing the original stop can end a newer run after its parent start.
	// That exit uses the worker's accumulated crash backoff, up to 30 seconds.
	if (checkBackoff) {
		await vi.advanceTimersByTimeAsync(5001)
		expect(decoder.running).toBe(false)
		expect(f.manager.getStatus("dec")?.desiredRunning).toBe(true)
		await vi.advanceTimersByTimeAsync(2998)
		expect(decoder.running).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(decoder.running).toBe(true)
	} else {
		await vi.advanceTimersByTimeAsync(30_000 + (hangs > 0 ? 11_002 : 5001))
	}
	if (strict) await Promise.all(calls)
	else await Promise.allSettled(calls)
	expect(f.manager.getStatus("dec")?.desiredRunning).toBe(running)
	expect(f.manager.getStatus("dec")?.running).toBe(running)
	const states = (
		f.manager as unknown as {
			decoders: Map<
				string,
				{
					lifecycle?: { desired: string; decoderGeneration: number }
					parentId?: string
					parentIntent?: { generation: number }
				}
			>
		}
	).decoders
	for (const [id, state] of states) {
		if (id !== "dec" && state.parentId !== "dec") continue
		expect(state.lifecycle?.desired).toBe(running ? "running" : "stopped")
		expect(state.lifecycle?.decoderGeneration).toBe(
			states.get("dec")?.parentIntent?.generation,
		)
		expect(f.instances.get(id)?.running).toBe(running)
	}
	await f.manager.destroy()
	manager = undefined
}

// Feature: decoder-enablement, Property 12: Placement lifecycle is serial
// Validates: Requirements 2.5, 3.7, 4.1, 4.2, 4.3, 11.3
it("parent generations preserve the last call across deferred worker completion", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.constantFrom<LifecycleCommand>(
					"start",
					"stop",
					"restart",
					"mode",
					"crash",
					"crash-fail",
					"crash-hang",
				),
				{ maxLength: 12 },
			),
			fc.boolean(),
			(commands, running) => exerciseParentGenerations(commands, running),
		),
		{ numRuns: 200 },
	)
}, 30_000)

it("a late deferred stop recovers after accumulated crash restart backoff", async () => {
	await exerciseParentGenerations(
		["crash-fail", "crash-fail", "crash-fail", "start", "crash-fail", "start"],
		true,
		true,
	)
})

it("a superseded parent start resolves without its late adapter failure", async () => {
	const f = setup()
	f.create("dec")
	f.plan([f.place("dec", 162_000_000)])
	const decoder = f.instances.get("dec")!
	let reject!: (error: Error) => void
	const pending = new Promise<void>((_resolve, rejectStart) => {
		reject = rejectStart
	})
	vi.spyOn(decoder, "start").mockImplementationOnce(() => pending)
	const starting = f.manager.startDecoder("dec")
	await vi.advanceTimersByTimeAsync(0)
	const stopping = f.manager.stopDecoder("dec")
	await expect(starting).resolves.toBeUndefined()
	reject(new Error("private late adapter failure"))
	await vi.advanceTimersByTimeAsync(5001)
	await stopping
	expect(f.manager.getStatus("dec")?.desiredRunning).toBe(false)
	expect(decoder.running).toBe(false)
})

it("a newer parent start applies staged settings after the captured stop exits", async () => {
	const f = setup()
	f.create("dec", { gain: 1 })
	f.plan([f.place("dec", 162_000_000)])
	await f.manager.startAll()
	const decoder = f.instances.get("dec")!
	const stop = decoder.stop.bind(decoder)
	let release!: () => void
	const pending = new Promise<void>(resolve => {
		release = resolve
	})
	vi.spyOn(decoder, "stop").mockImplementationOnce(async () => {
		await pending
		await stop()
	})
	f.manager.stageDecoderOptions("dec", { gain: 2 })
	const restarting = f.manager.restartDecoder("dec")
	await vi.advanceTimersByTimeAsync(0)
	const starting = f.manager.startDecoder("dec")
	release()
	await vi.advanceTimersByTimeAsync(1)
	await Promise.all([restarting, starting])
	expect(f.manager.getStatus("dec")?.running).toBe(true)
	expect(f.configs.get("dec")?.["gain"]).toBe(2)
	expect(f.manager.getDecoder("dec")).not.toBe(decoder)
	expect(f.manager.isRestartPending("dec")).toBe(false)
})

it.each(["failure", "timeout", "ok"])(
	"parent start aggregates a deferred worker: %s",
	async result => {
		const f = setup()
		f.create("dec")
		const worker = f.place("dec", 162_025_000, false)
		f.plan([f.place("dec", 162_000_000), worker])
		await f.manager.startAll()
		const decoder = f.instances.get(worker.key)!
		const stop = decoder.stop.bind(decoder)
		let release!: () => void
		const pending = new Promise<void>(resolve => {
			release = resolve
		})
		vi.spyOn(decoder, "stop").mockImplementationOnce(async () => {
			await pending
			await stop()
		})
		const stopping = f.manager.stopDecoder("dec")
		await vi.advanceTimersByTimeAsync(0)
		if (result === "failure")
			vi.spyOn(decoder, "start").mockRejectedValueOnce(
				new Error("private adapter failure"),
			)
		let releaseStart: (() => void) | undefined
		if (result === "timeout")
			vi.spyOn(decoder, "start").mockImplementationOnce(
				() =>
					new Promise<void>(resolve => {
						releaseStart = resolve
					}),
			)
		let settled = false
		const starting = f.manager.startDecoder("dec").finally(() => {
			settled = true
		})
		const outcome =
			result === "ok"
				? expect(starting).resolves.toBeUndefined()
				: expect(starting).rejects.toMatchObject({
						code: "DECODER_PLACEMENT_START_FAILED",
						message: "Decoder placement start failed",
					})
		await vi.advanceTimersByTimeAsync(1)
		expect(settled).toBe(false)
		release()
		if (result === "timeout") {
			await vi.advanceTimersByTimeAsync(4998)
			expect(settled).toBe(false)
		}
		await vi.advanceTimersByTimeAsync(1)
		await outcome
		await stopping
		expect(f.manager.getStatus("dec")?.running).toBe(true)
		if (result !== "ok") {
			expect(f.manager.getStatus(worker.key)?.lastError?.message).toBe(
				"Decoder placement start failed",
			)
			expect(f.manager.getStatus(worker.key)?.health).toBe("faulted")
			expect(f.manager.getStatus("dec")?.lastError?.message).toBe(
				"Decoder placement start failed",
			)
			expect(
				f.manager
					.getStatus("dec")
					?.placements?.find(placement => !placement.primary)?.running,
			).toBe(false)
		}
		releaseStart?.()
		await vi.advanceTimersByTimeAsync(0)
	},
)

function crashGate(): EfficiencyGate {
	return {
		record: vi.fn(),
		admit: vi.fn(() => ({ admit: true as const })),
		probation: () => [],
		noteSuspended: vi.fn(),
		forget: vi.fn(),
		view: () => ({ budgetCores: 1, cpuGuardPercent: 90, sources: [] }),
	}
}

it.each(["stop", "restart", "normal", "superseded"])(
	"crash retry obeys parent generations: %s",
	async action => {
		const gate = crashGate()
		const f = setup("rate-test", gate)
		f.create("dec")
		const worker = f.place("dec", 162_025_000, false)
		f.plan([f.place("dec", 162_000_000), worker])
		await f.manager.startAll()
		const decoder = f.instances.get(worker.key)!
		const starts = vi.spyOn(decoder, "start")
		const admissions = vi.mocked(gate.admit).mock.calls.length
		if (action === "superseded") {
			const internal = f.manager as unknown as {
				decoders: Map<string, { lifecycle: { runDecoderGeneration: number } }>
			}
			internal.decoders.get(worker.key)!.lifecycle.runDecoderGeneration--
		}
		decoder.crash()
		await vi.advanceTimersByTimeAsync(0)
		if (action === "stop") await f.manager.stopDecoder("dec")
		if (action === "restart") await f.manager.restartDecoder("dec")
		await vi.advanceTimersByTimeAsync(6000)
		expect(starts).toHaveBeenCalledTimes(action === "normal" ? 1 : 0)
		if (action === "normal")
			expect(vi.mocked(gate.admit).mock.calls.length).toBeGreaterThan(
				admissions,
			)
		if (action === "stop")
			expect(f.manager.getStatus("dec")?.running).toBe(false)
		if (action === "restart")
			expect(f.manager.getStatus("dec")?.running).toBe(true)
	},
)

it("a queued crash retry does not start a worker a newer restart holds", async () => {
	const f = setup("rate-test", crashGate())
	f.create("dec")
	const worker = f.place("dec", 162_025_000, false)
	f.plan([f.place("dec", 162_000_000), worker])
	await f.manager.startAll()
	const decoder = f.instances.get(worker.key)!
	const starts = vi.spyOn(decoder, "start")
	const internal = f.manager as unknown as { capsWork: Promise<void> }
	const queue = deferred()
	internal.capsWork = queue.promise
	decoder.crash()
	// The 2000 ms backoff fires and its retry queues behind the held caps work.
	await vi.advanceTimersByTimeAsync(2000)
	expect(starts).not.toHaveBeenCalled()
	const primary = f.instances.get("dec")!
	const stop = primary.stop.bind(primary)
	const primaryStop = deferred()
	vi.spyOn(primary, "stop").mockImplementationOnce(async () => {
		await primaryStop.promise
		await stop()
	})
	const restarting = f.manager.restartDecoder("dec")
	await vi.advanceTimersByTimeAsync(0)
	// The queued retry runs while the restart still awaits the primary stop.
	queue.resolve()
	await vi.advanceTimersByTimeAsync(0)
	primaryStop.resolve()
	await vi.advanceTimersByTimeAsync(1)
	await expect(restarting).resolves.toBeUndefined()
	await vi.advanceTimersByTimeAsync(6000)
	expect(starts).not.toHaveBeenCalled()
	expect(f.manager.getStatus("dec")?.running).toBe(true)
	expect(f.instances.get(worker.key)?.running).toBe(true)
})

it("a hung crash restart releases the caps queue within the request bound", async () => {
	const f = setup("rate-test", crashGate())
	f.create("dec")
	const worker = f.place("dec", 162_025_000, false)
	f.plan([f.place("dec", 162_000_000), worker])
	await f.manager.startAll()
	const decoder = f.instances.get(worker.key)!
	const start = deferred()
	decoder.startGate = start
	decoder.crash()
	await vi.advanceTimersByTimeAsync(2000)
	expect(decoder.starts).toBe(2)
	const internal = f.manager as unknown as {
		capsWork: Promise<void>
		drainCapsChanges(): Promise<void>
	}
	let released = false
	void internal.capsWork.then(() => {
		released = true
	})
	await vi.advanceTimersByTimeAsync(4999)
	expect(released).toBe(false)
	await vi.advanceTimersByTimeAsync(1)
	expect(released).toBe(true)
	expect(f.manager.getStatus(worker.key)?.lastError?.message).toBe(
		"Decoder placement start failed",
	)
	expect(f.manager.getStatus(worker.key)?.health).toBe("faulted")
	let drained = false
	void internal.drainCapsChanges().then(() => {
		drained = true
	})
	await vi.advanceTimersByTimeAsync(0)
	expect(drained).toBe(true)
	// The actor still owns the unfinished start: a stop accounts for it and a
	// late process is stopped once it arrives.
	const stopping = f.manager.stopDecoder("dec").catch(() => undefined)
	await vi.advanceTimersByTimeAsync(5001)
	await stopping
	expect(f.manager.getDecoder(worker.key)).toBe(decoder)
	const stops = decoder.stops
	start.resolve()
	await vi.advanceTimersByTimeAsync(5001)
	expect(decoder.stops).toBeGreaterThan(stops)
	expect(decoder.running).toBe(false)
	expect(decoder.starts).toBe(2)
})

it.each(["retry", "stop in backoff", "restart in backoff", "stop in start"])(
	"a failed crash restart keeps the retry accounting: %s",
	async action => {
		const f = setup("rate-test", crashGate(), {
			maxRestarts: 3,
			faultAfterFailures: 3,
		})
		f.create("dec")
		const worker = f.place("dec", 162_025_000, false)
		f.plan([f.place("dec", 162_000_000), worker])
		await f.manager.startAll()
		const decoder = f.instances.get(worker.key)!
		const maxRestarts = vi.fn()
		f.manager.on("decoder:max-restarts", maxRestarts)
		decoder.failStart = true
		const start = deferred()
		if (action === "stop in start") decoder.startGate = start
		decoder.crash()
		await vi.advanceTimersByTimeAsync(2000)
		expect(decoder.starts).toBe(2)
		if (action === "stop in start") {
			const stopping = f.manager.stopDecoder("dec")
			start.resolve()
			await vi.advanceTimersByTimeAsync(0)
			await stopping
			await vi.advanceTimersByTimeAsync(60_000)
			expect(decoder.starts).toBe(2)
			expect(f.manager.getStatus("dec")?.desiredRunning).toBe(false)
			return
		}
		expect(f.manager.getStatus(worker.key)?.lastError?.message).toBe(
			"Decoder placement start failed",
		)
		expect(f.manager.getStatus(worker.key)?.health).toBe("restarting")
		if (action === "stop in backoff") {
			await f.manager.stopDecoder("dec")
			await vi.advanceTimersByTimeAsync(60_000)
			expect(decoder.starts).toBe(2)
			return
		}
		if (action === "restart in backoff") {
			decoder.failStart = false
			await f.manager.restartDecoder("dec")
			const current = f.instances.get(worker.key)!
			const before = current.starts
			await vi.advanceTimersByTimeAsync(60_000)
			expect(decoder.starts).toBe(2)
			expect(current.starts).toBe(before)
			expect(current.running).toBe(true)
			return
		}
		// Backoff doubles: the second attempt comes 4000 ms after the first.
		await vi.advanceTimersByTimeAsync(3999)
		expect(decoder.starts).toBe(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(decoder.starts).toBe(3)
		await vi.advanceTimersByTimeAsync(8000)
		expect(decoder.starts).toBe(4)
		expect(maxRestarts).toHaveBeenCalledTimes(1)
		expect(f.manager.getStatus(worker.key)?.health).toBe("faulted")
		await vi.advanceTimersByTimeAsync(60_000)
		expect(decoder.starts).toBe(4)
		expect(decoder.running).toBe(false)
	},
)

it("a crash of a run adopted by a newer parent start is retried", async () => {
	const f = setup()
	f.create("dec")
	const worker = f.place("dec", 162_025_000, false)
	f.plan([f.place("dec", 162_000_000), worker])
	await f.manager.startAll()
	const decoder = f.instances.get(worker.key)!
	await f.manager.startDecoder("dec")
	expect(decoder.running).toBe(true)
	// The newer start adopts the live worker run instead of restarting it.
	await f.manager.startDecoder("dec")
	expect(decoder.starts).toBe(1)
	decoder.crash()
	await vi.advanceTimersByTimeAsync(2000)
	expect(decoder.starts).toBe(2)
	expect(decoder.running).toBe(true)
})

it("status targets include primary and worker channels once, overriding configured hints", async () => {
	const f = setup()
	f.create("dec", { frequency: 100_000_000 })
	f.plan([f.place("dec", 162_000_000), f.place("dec", 162_025_000, false)])
	await f.manager.startAll()
	expect(f.manager.getStatus("dec")?.targetFrequenciesHz).toEqual([
		162_000_000, 162_025_000,
	])
})

it("centre reach reports the capture centre while raw wideband retains declared targets", async () => {
	const f = setup()
	f.create("centre")
	f.create("raw", { frequency: 433_920_000 })
	f.plan([
		{ ...f.place("centre", 162_000_000), channelHz: null, reach: "centre" },
		{ ...f.place("raw", 162_000_000), channelHz: null, reach: "raw" },
	])
	await f.manager.startAll()
	expect(f.manager.getStatus("centre")?.targetFrequenciesHz).toEqual([
		162_000_000,
	])
	expect(f.manager.getStatus("raw")?.targetFrequenciesHz).toEqual([433_920_000])
})

it("unknown centre reach never falls back to a configured target hint", async () => {
	const f = setup()
	f.create("dec", { frequency: 100_000_000 })
	f.plan([{ ...f.place("dec", 162_000_000), channelHz: null, reach: "centre" }])
	await f.manager.startAll()
	f.sources.caps.delete("rtl")
	expect(f.manager.getStatus("dec")?.targetFrequenciesHz).toBeUndefined()
})

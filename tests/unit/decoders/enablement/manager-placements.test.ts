import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import { createActivityIngress } from "../../../../src/core/activity/ingress.js"
import type { DecodeEnvelope } from "../../../../src/core/activity/types.js"
import { DecoderManager } from "../../../../src/decoders/manager.js"
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
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

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
	expect(f.manager.getStatus("dec")?.suspension?.reasonCode).toBe(reason)
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
	await expect(f.manager.stopDecoder("dec")).rejects.toThrow("stop failed")
	expect(failing.running).toBe(false)
	expect(failing.stop).toHaveBeenCalledTimes(2)
	expect(f.manager.getDecoder(workers[0]![0])).toBeUndefined()
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
	await expect(f.manager.stopDecoder("dec")).rejects.toThrow("first stop")
	expect(decoder.running).toBe(true)
	expect(f.manager.getDecoder(worker.key)).toBe(decoder)
	expect(decoder.listenerCount("exit")).toBeGreaterThan(0)
	f.manager.efficiencyView()
	expect(view.mock.calls.at(-1)?.[0].map(item => item.key)).toContain(
		worker.key,
	)
	await expect(f.manager.destroy()).rejects.toThrow("first stop")
	expect(stop).toHaveBeenCalledTimes(2)
	decoder.crash()
	await f.manager.destroy()
	expect(decoder.running).toBe(false)
	expect(f.manager.getDecoder(worker.key)).toBeUndefined()
})

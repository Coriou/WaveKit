import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { SourceFanoutRouter } from "../../../../src/core/source-fanout-router.js"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { composeLinkBurst } from "../../../../src/core/link-burst/compose.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	ChannelRequestResult,
	ChannelProvider,
} from "../../../../src/core/channelizer/types.js"
import type {
	EfficiencyGate,
	PlacementPlan,
	PlacementPlanner,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import { placementKey } from "../../../../src/decoders/enablement/contract.js"
import type { Decoder } from "../../../../src/decoders/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

let manager: DecoderManager | undefined
let closeRouting: (() => void) | undefined
afterEach(async () => {
	await manager?.destroy()
	closeRouting?.()
	closeRouting = undefined
	vi.useRealTimers()
})

function setup(
	type = "rate-test",
	gate?: EfficiencyGate,
	mode: "auto" | "always" = "auto",
	withRouting = false,
) {
	vi.useFakeTimers()
	vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"))
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
	const yamlIds = new Set<string>()
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
			resolveMode: () => ({ mode, source: "default" }),
			isCatalogue: config => catalogue && !yamlIds.has(config.id),
			unavailable: () => unavailable,
			recheckAvailable: async () => true,
			vfo: () => null,
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
		},
	})
	const fanout = new FanoutManager(logger)
	const composed = withRouting
		? composeLinkBurst({ log: logger, monoNow: () => performance.now() })
		: null
	const sourceStream = new PassThrough()
	const routedSources = Object.assign(sources, {
		getStream: () => sourceStream,
		getConfig: () => ({
			type: "rtl_tcp",
			host: "example.invalid",
			burstAbsorber: { seconds: 0 },
		}),
	})
	const routing = composed
		? new SourceFanoutRouter(
				routedSources as unknown as SourceManager,
				fanout,
				logger,
				"rtl",
				{ linkBurst: composed.factories },
			)
		: undefined
	if (routing)
		closeRouting = () => {
			routing.destroy()
			fanout.destroy()
			composed?.dispose()
			sourceStream.destroy()
		}
	manager.setSourceManager(sources as unknown as SourceManager, routing)
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
		routing,
		fanout,
		sourceStream,
		onStart: (callback: () => void) => {
			beforeStart = callback
		},
		yaml: () => {
			catalogue = false
		},
		yamlDecoder: (id: string) => {
			yamlIds.add(id)
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

it("channel placement inherits parent mode and start mode", async () => {
	const gate = fakeGate()
	const f = setup("rate-test", gate, "always")
	f.create("dec")
	f.plan([f.place("dec", 162_000_000), f.place("dec", 162_025_000, false)])
	await f.manager.startDecoder("dec", { startMode: "operator" })
	await vi.advanceTimersByTimeAsync(2500)
	expect(gate.probation).toHaveBeenCalled()
	const running = vi.mocked(gate.probation).mock.calls.at(-1)![0]
	expect(running).toHaveLength(2)
	for (const item of running)
		expect(item).toMatchObject({ mode: "always", startMode: "operator" })
})

it("late-drops verdict suspends with efficiency-budget and detail late-drops", async () => {
	const gate = fakeGate()
	const f = setup("rate-test", gate)
	f.create("dec")
	const placement = f.place("dec", 162_000_000)
	f.plan([placement])
	await f.manager.startAll()
	gate.probation = vi.fn(() => [
		{ key: placement.key, detail: "late-drops" as const },
	])
	await vi.advanceTimersByTimeAsync(2500)
	expect(f.manager.getAllStatus()[0]).toMatchObject({
		running: false,
		suspension: { reasonCode: "efficiency-budget" },
		efficiency: { detail: "late-drops" },
	})
	expect(
		f.warn.mock.calls.filter(call => call[1] === "Late drops shed a decoder"),
	).toEqual([
		[
			{
				reasonCode: "efficiency-budget",
				detail: "late-drops",
				sourceId: "rtl",
				decoderId: "dec",
			},
			"Late drops shed a decoder",
		],
	])
})

it.each(["late-drops", "drops", "cpu"] as const)(
	"second late shed doubles the retry delay and further %s failures stop at the cap",
	async detail => {
		const gate = fakeGate()
		const f = setup("rate-test", gate)
		f.create("dec")
		const placement = f.place("dec", 162_000_000)
		f.plan([placement])
		await f.manager.startAll()
		for (const delay of [300_000, 600_000, 1_200_000, 1_800_000, 1_800_000]) {
			await vi.advanceTimersByTimeAsync(35_000)
			gate.probation = vi.fn(() => [
				{
					key: placement.key,
					detail: delay === 300_000 ? ("late-drops" as const) : detail,
				},
			])
			await vi.advanceTimersByTimeAsync(2000)
			const status = f.manager.getAllStatus()[0]!
			expect(status.running).toBe(false)
			const retry = Date.parse(status.efficiency!.retryAt!)
			expect(retry - Date.now()).toBeGreaterThan(delay - 2500)
			expect(retry - Date.now()).toBeLessThanOrEqual(delay)
			gate.probation = vi.fn(() => [])
			await vi.advanceTimersByTimeAsync(delay + 2500)
			expect(f.instances.get("dec")?.running).toBe(true)
		}
	},
)

it("YAML placement is never passed to the gate", async () => {
	const gate = fakeGate()
	gate.probation = vi.fn<EfficiencyGate["probation"]>(running =>
		running.map(item => ({ key: item.key, detail: "late-drops" as const })),
	)
	const f = setup("rate-test", gate)
	f.yaml()
	f.create("dec")
	f.plan([f.place("dec", 162_000_000)])
	await f.manager.startAll()
	await vi.advanceTimersByTimeAsync(65_000)
	expect(f.instances.get("dec")?.running).toBe(true)
	expect(gate.admit).not.toHaveBeenCalled()
	for (const [running] of vi.mocked(gate.probation).mock.calls)
		expect(running).toEqual([])
})

it.each(["yaml", "always", "operator", "auto"] as const)(
	"condemning late windows protect %s placements",
	async protection => {
		let windows: {
			startMono: number
			endMono: number
			condemning: boolean
			linkOrUnknownDrops: boolean
		}[] = []
		const gate = createEfficiencyGate(
			{ budgetCores: 10, cpuGuardPercent: 90 },
			{
				drops: {
					monoNow: () => performance.now(),
					sources: () => ["rtl"],
					dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
					droppedSinceMono: () => false,
					droppedWithinMs: () => false,
					latestAttribution: () => "none",
					lateWindows: () => windows,
					coverageCompleteAtMono: (_id, since, amount) =>
						performance.now() >= since + amount ? since + amount : null,
				},
			},
		)
		const f = setup(
			"rate-test",
			gate,
			protection === "always" ? "always" : "auto",
		)
		if (protection === "yaml") f.yaml()
		f.create("dec")
		f.plan([f.place("dec", 162_000_000), f.place("dec", 162_025_000, false)])
		if (protection === "operator")
			await f.manager.startDecoder("dec", { startMode: "operator" })
		else await f.manager.startAll()
		await vi.advanceTimersByTimeAsync(65_000)
		const start = performance.now()
		windows = [0, 1, 2].map(index => ({
			startMono: start + index * 10_000,
			endMono: start + (index + 1) * 10_000,
			condemning: true,
			linkOrUnknownDrops: false,
		}))
		await vi.advanceTimersByTimeAsync(32_000)
		const running = [...f.instances.values()].filter(decoder => decoder.running)
		expect(running).toHaveLength(protection === "auto" ? 1 : 2)
		if (protection !== "yaml")
			expect(
				f.manager.efficiencyView().sources[0]?.lateDrops?.condemningWindows,
			).toBeGreaterThanOrEqual(protection === "auto" ? 0 : 2)
	},
)

it.each([
	null,
	"1970-01-01T00:01:00.000Z",
	"invalid",
	"+999999-01-01T00:00:00.000Z",
])(
	"efficiency view rebases cooldown %s with the same clock offset as retry",
	async cooldownUntil => {
		const gate = fakeGate()
		gate.view = () => ({
			budgetCores: 1,
			cpuGuardPercent: 90,
			sources: [
				{
					sourceId: "rtl",
					coresInUse: 0,
					cpu: { percent: 0, limit: 90 },
					drops: "ok",
					dropBytesPerSecond: 0,
					admitted: [],
					blocked: [
						{
							decoderId: "dec",
							sourceId: "rtl",
							channelHz: null,
							reach: "raw",
							costCores: 0.1,
							probation: false,
							detail: "late-drops",
							retryAt: "1970-01-01T00:01:00.000Z",
						},
					],
					lateDrops: {
						condemningWindows: 2,
						windows: 3,
						cooldownUntil,
						sheddable: 1,
						held: null,
					},
				},
			],
		})
		const f = setup("rate-test", gate)
		await vi.advanceTimersByTimeAsync(12_345)
		const source = f.manager.efficiencyView().sources[0]!
		expect(source.blocked[0]?.retryAt).toBe(
			new Date(Date.now() + 60_000 - performance.now()).toISOString(),
		)
		expect(source.lateDrops?.cooldownUntil).toBe(
			cooldownUntil === "1970-01-01T00:01:00.000Z"
				? source.blocked[0]?.retryAt
				: null,
		)
	},
)

it.each([
	"",
	"invalid",
	"+999999-01-01T00:00:00.000Z",
	"+275760-09-13T00:00:00.000Z",
])("efficiency view returns null for malformed retry %s", retryAt => {
	const gate = fakeGate()
	gate.view = () => ({
		budgetCores: 1,
		cpuGuardPercent: 90,
		sources: [
			{
				sourceId: "rtl",
				coresInUse: 0,
				cpu: { percent: 0, limit: 90 },
				drops: "ok",
				dropBytesPerSecond: 0,
				admitted: [],
				blocked: [
					{
						decoderId: "dec",
						sourceId: "rtl",
						channelHz: null,
						reach: "raw",
						costCores: 0.1,
						probation: false,
						detail: "unknown",
						retryAt,
					},
				],
			},
		],
	})
	const f = setup("rate-test", gate)
	expect(f.manager.efficiencyView().sources[0]?.blocked[0]?.retryAt).toBeNull()
})

it("composed monitoring holds link drops and sheds one graduated auto placement for consumer drops", async () => {
	let f: ReturnType<typeof setup>
	let gap = 0
	const monitor = createEfficiencyMonitor({
		sources: () => ["rtl"],
		onSample: sample => gate.record(sample),
		branchCounters: id => f.routing!.branchDropCounters(id),
		topology: id => f.routing!.branchTopology(id),
		cpu: { normalisedPercent: 0 },
		now: Date.now,
		monoNow: () => performance.now(),
		setInterval: () => ({ cancel() {} }),
		ingest: () => ({ maxGapMs: gap, catchupBytes: 0, chunks: 1 }),
		loopDelay: () => ({ maxMs: 0, p99Ms: 0 }),
		shortfall: () => false,
		upstreamDroppedTotal: () => 0,
	})
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: 90 },
		{ drops: monitor },
	)
	f = setup("rate-test", gate, "auto", true)
	f.create("auto")
	f.yamlDecoder("yaml")
	f.create("yaml")
	f.plan([f.place("auto", 162_000_000), f.place("yaml", 162_025_000)])
	// Two real fanout branches supply independent counters; no socket is opened.
	const slow = f.fanout.addBranch({ id: "slow", highWaterMark: 16 })
	const sibling = f.fanout.addBranch({ id: "sibling", highWaterMark: 16 })
	const chunk = Buffer.alloc(64)
	const tick = async (drop: "none" | "link" | "consumer") => {
		gap = drop === "link" ? 100 : 0
		if (drop !== "none") {
			f.sourceStream.write(chunk)
			if (drop === "consumer") await vi.advanceTimersByTimeAsync(0)
			f.sourceStream.write(chunk)
			if (drop === "consumer") await vi.advanceTimersByTimeAsync(0)
			f.sourceStream.write(chunk)
		}
		monitor.sampleNow()
		if (drop !== "none") {
			slow.resume()
			sibling.resume()
			await vi.advanceTimersByTimeAsync(0)
			slow.pause()
			if (drop === "link") sibling.pause()
		}
		await vi.advanceTimersByTimeAsync(2000)
	}
	await tick("none")
	await tick("none")
	await f.manager.startAll()
	for (let i = 0; i < 34; i++) await tick("none")
	for (let i = 0; i < 15; i++) await tick("link")
	expect(monitor.latestAttribution("rtl")).toBe("link")
	expect([...f.instances.values()].filter(d => d.running)).toHaveLength(2)
	expect(
		gate.admit(f.place("next", 162_050_000), [], performance.now()),
	).toMatchObject({ admit: false, detail: "unknown" })
	for (let i = 0; i < 20; i++) await tick("consumer")
	expect(monitor.latestAttribution("rtl")).toBe("consumer")
	expect(f.instances.get("auto")?.running).toBe(false)
	expect(f.instances.get("yaml")?.running).toBe(true)
	expect(f.instances.get("auto")?.stops).toBe(1)
})

import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import pino from "pino"
import { DecoderManager } from "../../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../../src/decoders/registry.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	ChannelRequestResult,
	ChannelProvider,
} from "../../../../src/core/channelizer/types.js"
import { EFFICIENCY_BUDGET_X64 } from "../../../../src/decoders/enablement/contract.js"
import type {
	ActivityChange,
	ActivitySnapshot,
	ChannelActivityPort,
} from "../../../../src/decoders/enablement/activity-contract.js"
import { resolveActivityPolicy } from "../../../../src/decoders/enablement/activity-plan.js"
import { planPlacements } from "../../../../src/decoders/enablement/placement.js"
import { FakeSources, RateDecoder, iqCaps } from "../../../mocks/rate-fakes.js"

// A pager with activity slots on one channelised source, the source held by
// a scanner sweep while the ranker notifies every 100 ms (one notice per hop).
const RATE = 1_024_000
const CENTRE = 466_103_300
const EPOCH = { sourceId: "rtl", engineId: "engine", epoch: 1 }

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

interface LogLine {
	level: number
	msg: string
	decoderId?: string
}

function setup() {
	vi.useFakeTimers()
	let mono = 0
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(RATE), centerFreq: CENTRE })
	const instances = new Map<string, RateDecoder>()
	const registry = new DecoderRegistry()
	const caps = {
		input: "iq",
		output: "text",
		integrationPattern: "pure_consumer",
	} as const
	registry.register(
		"multimon-ng",
		config => {
			const decoder = new RateDecoder(config.id, caps)
			let options = { ...config.options }
			decoder.updateOptions = updates => {
				options = { ...options, ...updates }
			}
			Object.assign(decoder, {
				getChannelRequest: () => ({
					centerHz: (options["channelHz"] as number) ?? CENTRE,
					bandwidthHz: 12_000,
					transitionHz: 2_500,
					outputRateHz: 48_000,
					format: "cu8" as const,
				}),
			})
			instances.set(config.id, decoder)
			return decoder
		},
		caps,
	)
	const listeners = new Set<(change: ActivityChange) => void>()
	const port: ChannelActivityPort = {
		snapshot: (queries, nowMonoMs): ActivitySnapshot[] =>
			queries.map(query => ({
				query,
				revision: 1,
				evaluatedMonoMs: nowMonoMs,
				lastFrameMonoMs: nowMonoMs,
				status: "ready",
				nextEvaluationMonoMs: null,
				channels: query.candidatesHz.map(hz => ({
					hz,
					excluded: false,
					score: 0,
					state: "cold" as const,
					reasons: [],
					live: false,
					lastEnergyMonoMs: null,
					stateSinceMonoMs: 0,
				})),
			})),
		subscribe: listener => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
	const lines: LogLine[] = []
	const sink = new Writable({
		write(chunk: Buffer, _encoding, done) {
			for (const raw of chunk.toString().split("\n"))
				if (raw) lines.push(JSON.parse(raw) as LogLine)
			done()
		},
	})
	const logger = pino({ level: "debug" }, sink)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
		enablement: {
			planner: planPlacements,
			resolveMode: () => ({ mode: "auto", source: "default" }),
			isCatalogue: () => false,
			unavailable: () => false,
			recheckAvailable: async () => true,
			vfo: () => null,
			bandplanChannels: () => [],
			maxBandplanChannels: 4,
			activity: {
				port,
				epochOf: (id: string) => (id === "rtl" ? EPOCH : null),
				policy: resolveActivityPolicy(
					undefined,
					EFFICIENCY_BUDGET_X64,
					"x64",
					8,
				),
				monoNow: () => mono,
			},
		},
	})
	const m = manager
	m.setSourceManager(sources as unknown as SourceManager)
	let channel = 0
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
		retuneChannel: vi.fn(async () => "retuned" as const),
	})
	m.setChannelizer(provider as unknown as ChannelProvider)
	void m.createDecoder({
		id: "pager",
		type: "multimon-ng",
		enabled: true,
		options: {},
		useChannelizer: true,
	})
	const starts = vi.spyOn(
		m as unknown as { startDecoderNow: (id: string) => Promise<void> },
		"startDecoderNow",
	)
	return {
		m,
		sources,
		provider,
		lines,
		starts,
		instances,
		placements: () => m.getStatus("pager")?.placements ?? [],
		notify: () => {
			for (const l of listeners) l({ epoch: EPOCH, revision: 2 })
		},
		advance: async (ms: number) => {
			mono += ms
			await vi.advanceTimersByTimeAsync(ms)
		},
	}
}

const startingLines = (lines: LogLine[], level?: number) =>
	lines.filter(
		line =>
			line.msg === "Starting decoder" &&
			(level === undefined || line.level === level),
	)

it("a held source's activity placements are started once, not on every pass", async () => {
	const f = setup()
	// The sweep holds the source before the placements first start.
	await f.m.holdSource("rtl", "tuner-scanning", "sweep")
	await f.m.startAll()
	await f.advance(1_000)
	const activity = f.placements().filter(p => p.origin === "activity")
	expect(activity.length).toBeGreaterThan(0)
	const startsBefore = f.starts.mock.calls.length
	const linesBefore = f.lines.length
	// 10 simulated seconds of a sweep: one activity notice per 100 ms hop.
	for (let t = 0; t < 10_000; t += 100) {
		f.notify()
		await f.advance(100)
	}
	const starts = f.starts.mock.calls.length - startsBefore
	const sweepLines = f.lines.slice(linesBefore)
	const info = startingLines(sweepLines, 30).length
	// Nothing changed for these placements during the sweep: no retry at all.
	expect(starts).toBe(0)
	expect(info).toBe(0)
	// Every placement still reports why it is not running.
	for (const id of [...f.instances.keys()].filter(id => id.includes("#")))
		expect(f.m.getStatus(id)?.suspension?.reasonCode).toBe("tuner-scanning")

	// A repeated explicit start that only meets the same hold logs at debug.
	const worker = [...f.instances.keys()].find(id => id.includes("#"))!
	const fromRepeat = f.lines.length
	await f.m.startDecoder(worker)
	await f.m.startDecoder(worker)
	const repeat = f.lines
		.slice(fromRepeat)
		.filter(line => line.decoderId === worker)
	expect(startingLines(repeat, 30)).toEqual([])
	expect(startingLines(repeat, 20)).toHaveLength(2)

	// The release resumes them (the hold was the only reason).
	await f.m.releaseSource("rtl", "sweep")
	await f.advance(1_000)
	expect(
		f.placements().filter(p => p.origin === "activity" && p.running).length,
	).toBe(activity.length)
})

const restartFailures = (lines: LogLine[]) =>
	lines.filter(line => line.msg.startsWith("Failed to restart decoder"))
const restarting = (lines: LogLine[], id: string) =>
	lines.filter(
		line => line.msg === "Restarting decoder" && line.decoderId === id,
	)

async function running() {
	const f = setup()
	await f.m.startAll()
	await f.advance(1_000)
	expect(f.placements().filter(p => p.running)).toHaveLength(5)
	return f
}

/** A same-rate retune: the centre moves and the channelizer drops every channel. */
function retune(f: ReturnType<typeof setup>, centreHz: number) {
	const opened = f.provider.requestChannel.mock.results.length
	f.sources.setCenter("rtl", centreHz)
	f.provider.emit(
		"channel-invalidated",
		"rtl",
		1,
		Array.from({ length: opened }, (_, i) => String(i + 1)),
	)
}

it.each([
	["inside the old channels' view", 2_000],
	["far enough to re-place every slot", 60_000],
])(
	"a same-rate retune %s restarts the parent once and never its old workers",
	async (_name, moveHz) => {
		const f = await running()
		const workers = [...f.instances.keys()].filter(id => id.includes("#"))
		const from = f.lines.length
		retune(f, CENTRE + moveHz)
		await f.advance(2_000)
		const after = f.lines.slice(from)
		expect(restartFailures(after)).toEqual([])
		// The parent's restart re-places its workers; none is restarted again.
		for (const id of workers) expect(restarting(after, id)).toEqual([])
		expect(f.placements().filter(p => p.running)).toHaveLength(5)
	},
)

it("a same-rate caps change with the channels intact restarts nothing", async () => {
	const f = await running()
	const starts = [...f.instances.values()].map(d => d.starts)
	const from = f.lines.length
	f.sources.setCenter("rtl", CENTRE + 2_000)
	await f.advance(2_000)
	const after = f.lines.slice(from)
	expect(restartFailures(after)).toEqual([])
	expect(after.filter(line => line.msg === "Restarting decoder")).toEqual([])
	expect([...f.instances.values()].map(d => d.starts)).toEqual(starts)
})

it("a real rate change still restarts the placements", async () => {
	const f = await running()
	const parentStarts = f.instances.get("pager")!.starts
	const from = f.lines.length
	f.sources.setRate("rtl", 2_048_000)
	await f.advance(2_000)
	const after = f.lines.slice(from)
	expect(restartFailures(after)).toEqual([])
	// The parent restarts once and re-places its workers, each started once.
	expect(f.instances.get("pager")!.starts).toBe(parentStarts + 1)
	expect(f.placements().filter(p => p.running)).toHaveLength(5)
	for (const [id, decoder] of f.instances)
		if (id.includes("#")) expect(decoder.starts).toBe(1)
})

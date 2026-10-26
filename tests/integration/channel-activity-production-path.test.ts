/**
 * Activity-ranked channels through the production decode path. Only the decoder processes and the
 * source are fake:
 * - `spawn` returns an in-process child whose stdin bytes carrying the burst marker make it print
 *   multimon-ng's own POCSAG stdout lines; `signalDecoder` signals that child object only (no pid,
 *   so no real process is ever signalled);
 * - the source is the scanner fakes' CU8 fanout (a tone on the far raster channel) and a channel
 *   provider handing each decoder child a stream.
 * Real: MultimonDecoder parsing, DecoderManager output forwarding with its placement binding, the
 * decoder provenance index and Activity ingress, the ScannerService (spectrum engine, discovery
 * store, ambient evidence), the ranker fed by the scanner, and the planner.
 *
 * Index wiring rebuilt here (src/index.ts links, as in the wiring diff):
 * 1. `createChannelActivityRanker({ monoNow: performance.now })` handed to the manager as
 *    `enablement.activity = { port, epochOf, policy: resolveActivityPolicy(...), monoNow }`;
 * 2. the same ranker as the ScannerService dep `channelActivity`;
 * 3. `createDecoderProvenanceIndex(decoderManager, default source)` as Activity ingress
 *    `resolveProvenance`, published through `decoderManager.setActivityPublisher`;
 * 4. `decoderRegistry.register("multimon-ng", createMultimonDecoder, MULTIMON_CAPS)`.
 */
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import type * as ChildProcessModule from "node:child_process"
import type { ChildProcess } from "node:child_process"
import type * as ProcessToolsModule from "../../src/decoders/process-tools.js"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"

const MARKER = Buffer.from("BURST-ON-CHANNEL")
// Ambient identity needs distinct pages, so each burst carries its own sequence number.
let pageSeq = 0
const pocsagLine = (): string =>
	`POCSAG1200: Address: 1234567  Function: 0  Alpha:   activity e2e ${++pageSeq}`

class FakeChild extends EventEmitter {
	readonly stdin = new PassThrough()
	readonly stdout = new PassThrough()
	readonly stderr = new PassThrough()
	readonly pid = undefined
	killed = false
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null
	constructor() {
		super()
		this.stdin.on("data", (chunk: Buffer) => {
			if (chunk.includes(MARKER)) this.stdout.write(`${pocsagLine()}\n`)
		})
		setImmediate(() => this.emit("spawn"))
	}
	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		if (this.killed) return true
		this.killed = true
		this.signalCode = signal
		setImmediate(() => {
			this.stdout.end()
			this.stderr.end()
			this.emit("exit", null, signal)
			this.emit("close", null, signal)
		})
		return true
	}
}

const spawned: FakeChild[] = []
vi.mock("node:child_process", async importOriginal => {
	const actual = await importOriginal<typeof ChildProcessModule>()
	return {
		...actual,
		spawn: vi.fn(() => {
			const child = new FakeChild()
			spawned.push(child)
			return child as unknown as ChildProcess
		}),
	}
})
vi.mock("../../src/decoders/process-tools.js", async importOriginal => {
	const actual = await importOriginal<typeof ProcessToolsModule>()
	return {
		...actual,
		signalDecoder: (proc: ChildProcess, signal: NodeJS.Signals) => {
			proc.kill(signal)
		},
	}
})

const { DecoderManager } = await import("../../src/decoders/manager.js")
const { DecoderRegistry } = await import("../../src/decoders/registry.js")
const { FanoutManager } = await import("../../src/core/fanout-manager.js")
const { createMultimonDecoder, MULTIMON_CAPS } =
	await import("../../src/decoders/builtin/multimon-ng.js")
const { EFFICIENCY_BUDGET_X64 } =
	await import("../../src/decoders/enablement/contract.js")
const { resolveActivityPolicy } =
	await import("../../src/decoders/enablement/activity-plan.js")
const { planPlacements } =
	await import("../../src/decoders/enablement/placement.js")
const { createChannelActivityRanker } =
	await import("../../src/core/scanner/channel-activity.js")
const { createDecoderProvenanceIndex } =
	await import("../../src/decoders/provenance-bindings.js")
const { ambientTrustFromBinding } =
	await import("../../src/core/scanner/probes/ambient-trust.js")
const { createActivityIngress } =
	await import("../../src/core/activity/ingress.js")
const { ScannerService } =
	await import("../../src/core/scanner/scanner-service.js")
const { FakeSources: RateSources, iqCaps } =
	await import("../mocks/rate-fakes.js")
const { FakeFanout, FakeSources, testSettings } =
	await import("../mocks/scanner/engine-fakes.js")
const { ArbiterFakeTuner } = await import("../mocks/scanner/arbiter-fakes.js")
const { feedTone, feedTones, FS, tick } =
	await import("../mocks/scanner/service-fakes.js")
import type { ChannelRequestResult } from "../../src/core/channelizer/types.js"
import type { DecodeEnvelope } from "../../src/core/activity/types.js"

const CENTRE = 466_103_300
const FAR = 466_225_000
const DWELL_MS = 1_500

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
	spawned.length = 0
})

function build() {
	const logger = pino({ level: "silent" })
	const monoNow = (): number => performance.now()
	// (1, 2) the ranker on the planner's clock, shared by the manager and the scanner
	const ranker = createChannelActivityRanker({ monoNow })
	// The manager's source (rate fakes) and the scanner's (engine fakes) report the same tuning.
	const managerSources = new RateSources()
	managerSources.caps.set("rtl", { ...iqCaps(FS), centerFreq: CENTRE })
	const registry = new DecoderRegistry()
	// (4) the production registration
	registry.register("multimon-ng", createMultimonDecoder, MULTIMON_CAPS)
	const manager = new DecoderManager(
		registry,
		new FanoutManager(logger),
		logger,
		{
			validateVersions: false,
			enablement: {
				planner: input => planPlacements(input),
				resolveMode: () => ({ mode: "auto", source: "default" }),
				isCatalogue: () => false,
				unavailable: () => false,
				recheckAvailable: async () => true,
				vfo: () => null,
				bandplanChannels: () => [],
				maxBandplanChannels: 4,
				activity: {
					port: ranker.port,
					epochOf: sourceId => ranker.epochOf(sourceId),
					policy: resolveActivityPolicy(
						{ dwellMs: DWELL_MS },
						EFFICIENCY_BUDGET_X64,
						"x64",
						8,
					),
					monoNow,
				},
			},
		},
	)
	manager.setSourceManager(managerSources as never)
	// The fake channelizer: one stream per granted channel, keyed by its centre.
	const channels = new Map<string, { centerHz: number; stream: PassThrough }>()
	let seq = 0
	const provider = Object.assign(new EventEmitter(), {
		requestChannel: async (
			_sourceId: string,
			_decoderId: string,
			req: { centerHz: number },
		): Promise<ChannelRequestResult> => {
			const channelId = String(++seq)
			const stream = new PassThrough()
			channels.set(channelId, { centerHz: req.centerHz, stream })
			return {
				ok: true as const,
				stream,
				channelId,
				generation: 1,
				realised: {
					outputRateHz: 48_000,
					format: "cu8" as const,
					groupDelaySamples: 0,
				},
			}
		},
		releaseChannel: async (channelId: string) => {
			channels.get(channelId)?.stream.end()
			channels.delete(channelId)
		},
		currentGeneration: () => 1,
	})
	manager.setChannelizer(provider as never)
	// The observed tuner state proves the same source centre/rate used by both paths.
	const tuner = new ArbiterFakeTuner()
	tuner.addSource("rtl")
	tuner.states.get("rtl")!.sampleRate = FS
	tuner.states.get("rtl")!.frequency = CENTRE
	// (3) production provenance index + Activity ingress, including tuner-backed trust
	const provenance = createDecoderProvenanceIndex(manager, () => "rtl", tuner)
	const envelopes: DecodeEnvelope[] = []
	const ingress = createActivityIngress({
		sink: env => envelopes.push(env),
		logger,
		resolveProvenance: provenance.lookup,
	})
	manager.setActivityPublisher((id, type, out) =>
		ingress.publish(id, type, out),
	)
	// The scanner over the same manager.
	const dir = mkdtempSync(join(tmpdir(), "wk-activity-e2e-"))
	const sources = new FakeSources("rtl", { sampleRate: FS, centerFreq: CENTRE })
	sources.rtlTcp.add("rtl")
	const fanout = new FakeFanout()
	const settings = testSettings(s => {
		s.passive.enabled = false
		s.sweep.markers = false
		// no scanner probes: decodes come from the placed decoders only (ambient evidence)
		s.maxProbes = { offset: 0, channel: 0 }
	}, dir)
	const scanner = new ScannerService({
		settings,
		sourceConfigs: [
			{
				id: "rtl",
				type: "rtl_tcp",
				host: "127.0.0.1",
				port: 1234,
				loop: false,
				playbackSpeed: 1,
				caps: sources.getCaps("rtl")!,
			},
		],
		decoderConfigs: [],
		region: "EU",
		stateDir: dir,
		sources: sources as never,
		routing: {
			getFanout: () => fanout,
			releaseUnused: () => undefined,
			getDefaultSourceId: () => "rtl",
		} as never,
		tuner: tuner as never,
		decoders: manager,
		// Match src/index.ts: trust is proven for this output's actual placement.
		ambientTrust: (decoderId, hz, sourceId, placement) =>
			ambientTrustFromBinding(
				provenance.lookup(decoderId, placement),
				hz,
				sourceId,
			),
		digitalVoice: null,
		liveDemod: null,
		logger,
		engineHost: "inline",
		tickMs: 20,
		channelActivity: ranker,
	})
	cleanups.push(async () => {
		try {
			await scanner.stop()
			await manager.destroy()
			provenance.dispose()
			ranker.dispose()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
	const runningHz = (): number[] =>
		(manager.getStatus("pager")?.placements ?? [])
			.filter(p => p.running && p.channelHz !== null)
			.map(p => p.channelHz!)
	/** The burst reaches every decoder channel tuned to `hz` (what a channelizer would deliver). */
	const burstOn = (hz: number): void => {
		for (const c of channels.values())
			if (c.centerHz === hz) c.stream.write(MARKER)
	}
	return { manager, scanner, ranker, fanout, envelopes, runningHz, burstOn }
}

describe("activity-ranked channels through the production decode path", () => {
	it("the multimon-ng slot follows the far burst and its POCSAG decode lands on that channel's discovery", async () => {
		const f = build()
		await f.scanner.start()
		await f.scanner.createJob({
			sourceId: "rtl",
			mode: "in-window",
			ranges: [{ startHz: 466_025_000, endHz: 466_230_000 }],
		})
		void f.manager.createDecoder({
			id: "pager",
			type: "multimon-ng",
			enabled: true,
			options: {},
			useChannelizer: true,
		})
		await f.manager.startAll()
		// Quiet spectrum: the slots sit on the nearest channels.
		for (let i = 0; i < 4; i++) {
			feedTones(f.fanout, 0.25, [])
			await tick(250)
		}
		expect(f.ranker.epochOf("rtl")).not.toBeNull()
		const before = f.runningHz()
		expect(before).toHaveLength(5)
		expect(before).not.toContain(FAR)
		// The far channel transmits (CU8 tone on the source; marker bytes on its decoder channel).
		const deadline = Date.now() + 20_000
		let found: { frequencyHz: number; confidence: string } | undefined
		while (Date.now() < deadline && !found) {
			feedTone(f.fanout, 0.25, FAR - CENTRE, 0.5)
			f.burstOn(FAR)
			await tick(250)
			found = f.scanner
				.listDiscoveries({} as never)
				.items.find(d => d.frequencyHz === FAR && d.confidence === "decoded")
		}
		expect(f.runningHz()).toContain(FAR)
		// Activity ingest: the decode's provenance names the far channel.
		const pocsag = f.envelopes.filter(e => e.decoderId === "pager")
		expect(pocsag.length).toBeGreaterThan(0)
		expect(pocsag.every(e => e.provenance.frequency?.hz === FAR)).toBe(true)
		expect(
			pocsag.every(e => e.provenance.frequency?.tuningTrust === "commanded"),
		).toBe(true)
		// The scanner placed the ambient decode on the far channel's discovery.
		expect(found).toMatchObject({ frequencyHz: FAR, confidence: "decoded" })
		// And the ranker heard that decode: the far channel ranks hot with "decoded".
		const snap = f.ranker.port.snapshot(
			[
				{
					epoch: f.ranker.epochOf("rtl")!,
					decoderId: "pager",
					decoderType: "multimon-ng",
					protocols: ["pocsag"],
					centreHz: CENTRE,
					candidatesHz: [FAR],
					channelWidthHz: 12_500,
				},
			],
			performance.now(),
		)[0]!
		expect(snap.channels[0]!.reasons).toContain("decoded")
	}, 40_000)
})

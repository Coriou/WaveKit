/**
 * Production manager, dsd-fme parser, spectrum/scanner, ranker and provenance trust.
 * The source, channelizer and spawned decoder pipeline are isolated in-process fakes.
 * Checked stderr is replayed on fake clock times independent of source sample times.
 */
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import type * as ChildProcessModule from "node:child_process"
import type { ChildProcess } from "node:child_process"
import type * as ProcessToolsModule from "../../src/decoders/process-tools.js"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"

const MARKER = Buffer.from("BURST-ON-CHANNEL")
// Reuse the MS/direct-mode print formats exercised by the parser verification tests.
// This existing fixture is source-format synthesis, not a captured stderr recording.
const VOICE = readFileSync(
	new URL("../mocks/fixtures/dsd-fme/dmr-ms-two-ptt.txt", import.meta.url),
	"utf8",
)
	.split("\n")
	.filter(line => line && !line.startsWith("#"))
	.map(row => ({
		at: Number(row.split("\t")[0]),
		line: row.slice(row.indexOf("\t") + 1),
	}))

let replayRows = VOICE.slice(0, 5)

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
			if (chunk.includes(MARKER)) {
				for (const row of replayRows)
					setTimeout(() => this.stderr.write(`${row.line}\n`), row.at)
			}
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
const { createDsdFmeDecoder, DSD_FME_CAPS } =
	await import("../../src/decoders/builtin/dsd-fme.js")
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
const { feedTones, FS } = await import("../mocks/scanner/service-fakes.js")
import {
	fsk4Burst,
	gaussianNoise,
	addInto,
	mulberry32,
	packCu8,
} from "../mocks/scanner/signals.js"
import type { DsdFmeLinkLine } from "../../src/decoders/builtin/dsd-fme-link.js"
import type { ChannelRequestResult } from "../../src/core/channelizer/types.js"
import type { DecodeEnvelope } from "../../src/core/activity/types.js"

const CENTRE = 466_103_300
const FAR = 466_036_250

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
	spawned.length = 0
	vi.useRealTimers()
})

function build() {
	const logger = pino({ level: "silent" })
	const monoNow = (): number => performance.now()
	// The ranker uses the planner clock and is shared by the manager and scanner.
	const ranker = createChannelActivityRanker({ monoNow })
	// The manager's source (rate fakes) and the scanner's (engine fakes) report the same tuning.
	const managerSources = new RateSources()
	managerSources.caps.set("rtl", { ...iqCaps(FS), centerFreq: CENTRE })
	const registry = new DecoderRegistry()
	// Production registration from src/index.ts.
	registry.register("dsd-fme", createDsdFmeDecoder, DSD_FME_CAPS)
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
				vfo: () => ({ sourceId: "rtl", frequencyHz: CENTRE }),
				bandplanChannels: () => [],
				maxBandplanChannels: 4,
				activity: {
					port: ranker.port,
					epochOf: sourceId => ranker.epochOf(sourceId),
					policy: resolveActivityPolicy(undefined, 3, "x64", 8),
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
	// Production provenance index + Activity ingress, including tuner-backed trust.
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
		decoderConfigs: [
			{
				id: "voice",
				type: "dsd-fme",
				enabled: true,
				options: {},
				useChannelizer: true,
			},
		],
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
		(manager.getStatus("voice")?.placements ?? [])
			.filter(p => p.running && p.channelHz !== null)
			.map(p => p.channelHz!)
	/** The burst reaches every decoder channel tuned to `hz` (what a channelizer would deliver). */
	const burstOn = (hz: number): void => {
		for (const c of channels.values())
			if (c.centerHz === hz) c.stream.write(MARKER)
	}
	const links: DsdFmeLinkLine[] = []
	manager.on("decoder:placed-link", (_id, line: DsdFmeLinkLine) =>
		links.push(line),
	)
	return {
		manager,
		scanner,
		ranker,
		fanout,
		envelopes,
		links,
		runningHz,
		burstOn,
	}
}

/** Source spectrum is real CU8 Gaussian 4FSK; only the channelizer and external process are fake. */
function feed4fsk(fanout: InstanceType<typeof FakeFanout>) {
	const rng = mulberry32(37)
	for (let i = 0; i < 5; i++) {
		const n = FS / 20
		const iq = addInto(
			gaussianNoise(rng, n, 0.02),
			fsk4Burst(rng, n, FS, FAR - CENTRE, 0.5),
		)
		fanout.write(Buffer.from(packCu8(iq.re, iq.im)))
	}
}

describe("dsd-fme activity through production wiring", () => {
	it.each(["checked voice", "error tail", "unchecked CSBK"])(
		"places an unlisted far 4FSK channel with %s through placement trust",
		async kind => {
			replayRows =
				kind === "checked voice"
					? VOICE.slice(0, 5)
					: [
							{
								at: 3.7,
								line: `21:49:48 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | CSBK${kind === "unchecked CSBK" ? " -RAS " : ""}`,
							},
							...(kind === "error tail"
								? [
										{ at: 31.3, line: " (CRC ERR)" },
										{
											at: 61.3,
											line: "21:49:48 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | IDLE",
										},
									]
								: []),
						]
			vi.useFakeTimers({
				toFake: [
					"Date",
					"performance",
					"setTimeout",
					"clearTimeout",
					"setInterval",
					"clearInterval",
				],
			})
			vi.setSystemTime(Date.parse("2026-10-23T12:00:00.123Z"))
			const f = build()
			await f.scanner.start()
			await f.scanner.createJob({
				sourceId: "rtl",
				mode: "in-window",
				ranges: [{ startHz: 466_025_000, endHz: 466_230_000 }],
			})
			void f.manager.createDecoder({
				id: "voice",
				type: "dsd-fme",
				enabled: true,
				options: {},
				useChannelizer: true,
			})
			await f.manager.startAll()
			feedTones(f.fanout, 0.25, [])
			await vi.advanceTimersByTimeAsync(317.3)
			expect(f.runningHz()).toEqual([CENTRE])
			// Clock increments deliberately differ from the 50 ms IQ integration.
			for (let i = 0; i < 4; i++) {
				feed4fsk(f.fanout)
				await vi.advanceTimersByTimeAsync(317.3)
			}
			const placement = f.manager
				.getStatus("voice")
				?.placements?.find(p => p.origin === "activity" && p.running)
			expect(placement).toBeDefined()
			expect(Math.abs(placement!.channelHz! - FAR)).toBeLessThan(2_000)
			const hz = placement!.channelHz!
			f.burstOn(hz)
			await vi.advanceTimersByTimeAsync(491.7)
			// Scanner acceptance requires a second checked identity at least 2 s later.
			for (let i = 0; i < 7; i++) {
				feed4fsk(f.fanout)
				await vi.advanceTimersByTimeAsync(317.3)
			}
			f.burstOn(hz)
			await vi.advanceTimersByTimeAsync(491.7)
			if (kind !== "checked voice") {
				expect(f.links.length).toBeGreaterThan(0)
				expect(f.links.every(l => !l.verified)).toBe(true)
				expect(
					f.scanner
						.listDiscoveries({} as never)
						.items.some(d => d.confidence === "decoded"),
				).toBe(false)
				return
			}
			expect(f.links.some(l => l.verified && l.cc === 1 && l.voiceLc)).toBe(
				true,
			)
			const found = f.scanner
				.listDiscoveries({} as never)
				.items.find(
					d =>
						Math.abs(d.frequencyHz - FAR) < 2_000 && d.confidence === "decoded",
				)
			expect(found).toBeDefined()
			expect(found!.protocol).toBe("dmr")
			expect(found!.tuningTrust).toBe("commanded")
			expect(found!.proof).toMatchObject({
				kind: "decoded",
				protocol: "dmr",
				identity: { kind: "dmr-cc", value: "1" },
			})
			const before = f.runningHz()
			for (let i = 0; i < 5; i++) {
				feed4fsk(f.fanout)
				await vi.advanceTimersByTimeAsync(317.3)
			}
			expect(f.runningHz()).toEqual(before)
		},
		30_000,
	)
})

/**
 * Production manager, ranker, decoder parsers, ambient confirmation and provenance trust.
 * Source, channelizer and process pipes are isolated in-process fakes; synthetic spectrum
 * summaries model mixed-channel burst timing on an unaligned fake clock.
 */
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { PassThrough } from "node:stream"
import type * as ChildProcessModule from "node:child_process"
import type { ChildProcess } from "node:child_process"
import type * as ProcessToolsModule from "../../src/decoders/process-tools.js"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"

const MARKER = Buffer.from("BURST-ON-CHANNEL")
// Reuse the MS/direct-mode print formats exercised by the parser verification tests.
// This existing fixture is source-format synthesis, not a captured stderr recording.
function fixtureRows(name: string) {
	return readFileSync(
		new URL(`../mocks/fixtures/dsd-fme/${name}`, import.meta.url),
		"utf8",
	)
		.split("\n")
		.filter(line => line && !line.startsWith("#"))
		.map(row => ({
			at: Number(row.split("\t")[0]),
			line: row.slice(row.indexOf("\t") + 1),
		}))
}
const VOICE = fixtureRows("dmr-ms-two-ptt.txt")

const replayRows = VOICE.slice(0, 5)

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
const { MultimonDecoder, MULTIMON_CAPS } =
	await import("../../src/decoders/builtin/multimon-ng.js")
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
const { AmbientEvidence } =
	await import("../../src/core/scanner/probes/ambient.js")
import type { AmbientEvidenceEvent } from "../../src/core/scanner/probes/ambient.js"
const { FakeSources: RateSources, iqCaps } =
	await import("../mocks/rate-fakes.js")
const { ArbiterFakeTuner } = await import("../mocks/scanner/arbiter-fakes.js")
const FS = 1_024_000
import type { DsdFmeLinkLine } from "../../src/decoders/builtin/dsd-fme-link.js"
import type { ChannelRequestResult } from "../../src/core/channelizer/types.js"
import type { PlacementPlan } from "../../src/decoders/enablement/contract.js"
import type { DecodeEnvelope } from "../../src/core/activity/types.js"
import { DSD_CHALLENGE_MIN_SPAN_MS } from "../../src/decoders/enablement/dsd-activity.js"

const CENTRE = 466_103_300
const FAR = CENTRE - 67_000
const PAGER = 466_156_250
const ANALOG = [466_068_750, 466_093_750, 466_193_750]

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
	spawned.length = 0
	vi.useRealTimers()
})

class ParserPager extends MultimonDecoder {
	acceptLine(line: string): void {
		const output = this.parseOutput(line)
		expect(output).not.toBeNull()
		expect(this.listenerCount("output")).toBeGreaterThan(0)
		if (output) this.emit("output", output)
	}
}

function build() {
	const logger = pino({ level: "silent" })
	const monoNow = (): number => performance.now()
	// The ranker uses the planner clock and is shared by the manager and scanner.
	const ranker = createChannelActivityRanker({ monoNow })
	// The fake source reports the same tuning used by the provenance trust lookup.
	const managerSources = new RateSources()
	managerSources.caps.set("rtl", { ...iqCaps(FS), centerFreq: CENTRE })
	const registry = new DecoderRegistry()
	// Production registration from src/index.ts.
	registry.register("dsd-fme", createDsdFmeDecoder, DSD_FME_CAPS)
	const pagers: ParserPager[] = []
	registry.register(
		"multimon-ng",
		(config, log) => {
			const decoder = new ParserPager(config, log)
			pagers.push(decoder)
			return decoder
		},
		MULTIMON_CAPS,
	)
	const plans: PlacementPlan[] = []
	const manager = new DecoderManager(
		registry,
		new FanoutManager(logger),
		logger,
		{
			validateVersions: false,
			enablement: {
				planner: input => {
					const plan = planPlacements(input)
					plans.push(plan)
					return plan
				},
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
					policy: resolveActivityPolicy(
						{ slots: { "dsd-fme": 1, "multimon-ng": 1 } },
						3,
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
	const channels = new Map<
		string,
		{ centerHz: number; decoderId: string; stream: PassThrough }
	>()
	let seq = 0
	const provider = Object.assign(new EventEmitter(), {
		requestChannel: async (
			_sourceId: string,
			_decoderId: string,
			req: { centerHz: number },
		): Promise<ChannelRequestResult> => {
			const channelId = String(++seq)
			const stream = new PassThrough()
			channels.set(channelId, {
				centerHz: req.centerHz,
				decoderId: _decoderId,
				stream,
			})
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
	// Production ambient interpreter receives the manager's bound parser events.
	// This test substitutes spectrum summaries and the discovery-store acceptance sink.
	const accepted: AmbientEvidenceEvent[] = []
	const ambient = new AmbientEvidence({
		decoders: manager,
		targetOf: id => {
			const hz = manager
				.getStatus(id)
				?.placements?.find(p => p.primary)?.channelHz
			return hz
				? { sourceId: "rtl", hz, targetsHz: [hz], external: false }
				: null
		},
		epochOf: () => 1,
		centreOf: () => CENTRE,
		sampleRateOf: () => FS,
		tuningTrustOf: (id, hz, sourceId, placement) =>
			ambientTrustFromBinding(provenance.lookup(id, placement), hz, sourceId),
		logger,
	})
	ambient.on("evidence", (event: AmbientEvidenceEvent) => {
		if (
			event.ev.contentVerified !== false &&
			event.ev.identity &&
			event.ev.crcClean
		) {
			accepted.push(event)
			ranker.noteDecode(event.sourceId, event.hz, event.ev.protocol)
		}
	})
	ambient.start()
	cleanups.push(async () => {
		ambient.stop()
		await manager.destroy()
		provenance.dispose()
		ranker.dispose()
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
		plans,
		pagerLine: (hz: number, message: string) => {
			let sent = 0
			for (const channel of channels.values()) {
				const decoder = pagers.find(
					p => p.id === channel.decoderId && p.getStatus().running,
				)
				if (channel.centerHz === hz && decoder) {
					sent++
					decoder.acceptLine(
						`POCSAG1200: Address: 1234567 Function: 0 Alpha: ${message}`,
					)
				}
			}
			expect(sent).toBe(1)
		},
		accepted,
		ranker,
		envelopes,
		links,
		runningHz,
		burstOn,
	}
}

describe("mixed-channel activity sequence", () => {
	// Three simulated minutes of production paths can exceed 5 s on a loaded host.
	it("finds bursty DMR, rejects a decoded pager and preserves paging moves over three minutes", async () => {
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
		// Production ranker/manager/parser/provenance wiring. Spectrum summaries are the
		// in-process fake boundary: 400 ms 4FSK bursts every 3 s, 2–3 intermittent analog
		// carriers and a decoded pager. FFT waveform coverage lives in the companion test.
		f.ranker.ingestEpoch("rtl", "synthetic", 1)
		const block = (hzs: readonly number[]) =>
			f.ranker.ingestBlock("rtl", "synthetic", {
				epoch: 1,
				centreHz: CENTRE,
				sampleRateHz: FS,
				overload: false,
				tracks: hzs.map(hz => ({
					startHz: hz - 3000,
					endHz: hz + 3000,
					trackId: `channel-${hz}`,
					flags: { iqImage: false, spur: false },
					gate: "passed",
				})),
			})
		// Decode history is the scanner's allocated ranker ingress, as used in index.ts.
		// Seed the pager's already-confirmed identity before voice slots are allocated.
		f.ranker.noteDecode("rtl", PAGER, "pocsag")
		block([PAGER, ...ANALOG])
		for (const [id, type] of [
			["voice", "dsd-fme"],
			["pager", "multimon-ng"],
		])
			void f.manager.createDecoder({
				id: id!,
				type: type!,
				enabled: true,
				options: {},
				useChannelizer: true,
			})
		await f.manager.startAll()
		let decodedHz: number | undefined
		let decodedAt = 0
		let pagerDecodes = 0
		// Deliberately off both 50 ms spectrum integration and 3 s burst boundaries.
		await vi.advanceTimersByTimeAsync(137.3)
		for (let step = 0; step < 1800; step++) {
			const elapsed = step * 100
			const active = [
				PAGER,
				...ANALOG.filter(
					(_, i) => (Math.floor(elapsed / (7100 + i * 1100)) + i) % 3 !== 0,
				),
			]
			if (elapsed % 3000 < 400) active.push(FAR)
			block(active)
			const hz = f.runningHz().find(h => Math.abs(h - FAR) < 2000)
			if (hz !== undefined && elapsed % 3000 < 400) {
				f.burstOn(hz)
				if (decodedHz === undefined) {
					decodedHz = hz
					decodedAt = elapsed
				}
			}
			// Parse real POCSAG output on the exact running placement, then pass its
			// confirmed decode through the ranker's public ingestion boundary.
			if (elapsed % 3000 === 0) {
				f.pagerLine(PAGER, `synthetic message ${elapsed}`)
				f.ranker.noteDecode("rtl", PAGER, "pocsag")
			}
			await vi.advanceTimersByTimeAsync(100)
			const voice = f.runningHz()
			expect(voice).not.toContain(PAGER)
			if (decodedHz !== undefined && elapsed > decodedAt + 1000)
				expect(voice).toContain(decodedHz)
			pagerDecodes = f.accepted.filter(e => e.ev.protocol === "pocsag").length
		}
		expect(decodedHz).toBeDefined()
		expect(f.links.some(l => l.protocol === "dmr")).toBe(true)
		expect(f.accepted.some(e => e.ev.protocol === "dmr")).toBe(true)
		expect(pagerDecodes).toBeGreaterThan(2)
		const moves = f.plans.flatMap(p => p.activity?.moves ?? [])
		expect(
			Math.max(
				0,
				...moves.map(
					move =>
						moves.filter(
							m =>
								m.atMonoMs <= move.atMonoMs &&
								m.atMonoMs > move.atMonoMs - 60_000,
						).length,
				),
			),
		).toBeLessThanOrEqual(6)
		for (const start of [0, 60_000, 120_000])
			expect(
				moves.some(
					m =>
						m.decoderId === "pager" &&
						m.atMonoMs >= start &&
						m.atMonoMs < start + 60_000,
				),
			).toBe(true)
		expect(
			moves.filter(m => m.decoderId === "voice").every(m => m.toHz !== PAGER),
		).toBe(true)
		// A new run of the same placement must earn sync again; a quick restart
		// can occur entirely between planner passes. Its fresh dwell still holds.
		const placement = f.plans
			.at(-1)
			?.wanted.find(p => p.decoderId === "voice" && p.channelHz === decodedHz)
		expect(placement).toBeDefined()
		const decoder = f.manager.getDecoder(placement!.key)
		expect(decoder).toBeDefined()
		decoder!.emit("started")
		for (let step = 0; step < 202; step++) {
			block([PAGER, ...ANALOG])
			await vi.advanceTimersByTimeAsync(100)
			if (step < 199) expect(f.runningHz()).toContain(decodedHz)
		}
		expect(f.runningHz()).not.toContain(decodedHz)
	}, 60_000)

	it("keeps a no-sync incumbent replaceable when DMR arrives after its cooldown", async () => {
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
		f.ranker.ingestEpoch("rtl", "synthetic", 1)
		const block = (hzs: readonly number[]) =>
			f.ranker.ingestBlock("rtl", "synthetic", {
				epoch: 1,
				centreHz: CENTRE,
				sampleRateHz: FS,
				overload: false,
				tracks: hzs.map(hz => ({
					startHz: hz - 3000,
					endHz: hz + 3000,
					trackId: `channel-${hz}`,
					flags: { iqImage: false, spur: false },
					gate: "passed",
				})),
			})
		const analog = ANALOG[0]!
		block([analog])
		void f.manager.createDecoder({
			id: "voice",
			type: "dsd-fme",
			enabled: true,
			options: {},
			useChannelizer: true,
		})
		await f.manager.startAll()
		await vi.advanceTimersByTimeAsync(137.3)
		const placement = f.plans
			.at(-1)
			?.wanted.find(p => p.decoderId === "voice" && p.channelHz === analog)
		expect(placement).toBeDefined()
		const decoder = f.manager.getDecoder(placement!.key)
		expect(decoder).toBeDefined()
		// Repro: a failed IDLE sync must never latch protection for this analog run.
		decoder!.emit("link", {
			protocol: "dmr",
			at: Date.now(),
			cc: 1,
			crcErr: true,
			verified: false,
		})
		// Full dwell 20 s + default cooldown 120 s = 140 s. Keep the failed
		// analog run through 150 s with no alternative and no sync from its process.
		for (let step = 0; step < 1500; step++) {
			block([analog])
			await vi.advanceTimersByTimeAsync(100)
		}
		expect(f.runningHz()).toContain(analog)
		expect(f.links).toHaveLength(1)
		// A 400 ms burst alone never moves a running slot (one sighting is not a challenge).
		for (let step = 0; step < 30; step++) {
			block(step < 4 ? [analog, FAR] : [analog])
			await vi.advanceTimersByTimeAsync(100)
		}
		expect(f.runningHz().some(h => Math.abs(h - FAR) < 2000)).toBe(false)
		// A sustained DMR transmission does: energy seen at least DSD_CHALLENGE_MIN_SPAN_MS apart
		// within the challenge memory displaces the no-sync incumbent, whose cooldown has passed.
		const sustainSteps = DSD_CHALLENGE_MIN_SPAN_MS / 100 + 30
		for (let step = 0; step < sustainSteps; step++) {
			block([analog, FAR])
			const hz = f.runningHz().find(h => Math.abs(h - FAR) < 2000)
			if (hz !== undefined) f.burstOn(hz)
			await vi.advanceTimersByTimeAsync(100)
		}
		expect(f.runningHz().some(h => Math.abs(h - FAR) < 2000)).toBe(true)
		expect(f.links.some(l => l.protocol === "dmr")).toBe(true)
	})
})

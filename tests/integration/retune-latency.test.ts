/**
 * WG9 TT.2 (requirements 3.4, 3.5): operator retunes against a fake rtl_tcp on 127.0.0.1 with an
 * injectable send delay (bridge buffering). The test asserts structure only (labels, one epoch per
 * retune at the command value, no `commanded` block with pre-retune content, nothing but
 * `unverified` before the network settle). `WAVEKIT_RETUNE_BENCH=1` runs the measurement mode:
 * 50 retunes per delay, printing p50/p90/max command → first block at the new centre and the
 * fraction of new-centre blocks whose content still matches the old centre.
 */
import { performance } from "node:perf_hooks"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger } from "../../src/utils/logger.js"
import { SourceManager } from "../../src/core/source-manager.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../src/core/source-fanout-router.js"
import { TunerController } from "../../src/core/tuner-controller.js"
import { TunerRelay } from "../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../src/core/tuner-wiring.js"
import type { SourceConfig } from "../../src/config.js"
import {
	SpectrumEngine,
	type EngineEpoch,
} from "../../src/core/spectrum/spectrum-engine.js"
import { createPipelineHost } from "../../src/core/spectrum/pipeline-host.js"
import type {
	BlockSummary,
	PendingEpoch,
	PipelineEvent,
} from "../../src/core/spectrum/types.js"
import {
	startSpectrumRtlTcp,
	type SpectrumRtlTcp,
} from "../mocks/scanner/fake-rtl-tcp.js"
import { testSettings } from "../mocks/scanner/engine-fakes.js"

const FS = 1_024_000
const C1 = 446_000_000
const C2 = 446_400_000
const EMITTER = 446_200_000 // +200 kHz at C1, -200 kHz at C2
const NETWORK_SETTLE_MS = 1000 // the config default (scanner.sweep.settleMs.network)
const TOLERANCE_HZ = 10_000
const BENCH = process.env["WAVEKIT_RETUNE_BENCH"] === "1"

type Content = "new" | "old" | "other"

interface Block {
	at: number
	summary: BlockSummary
	epoch: EngineEpoch
}

/** Where the emitter's peak sits in a block labelled with the summary's centre. */
function contentOf(s: BlockSummary, previousCentre: number): Content {
	let best = 0
	for (let i = 1; i < s.bins.length; i++)
		if ((s.bins[i] ?? -Infinity) > (s.bins[best] ?? -Infinity)) best = i
	const rf = s.startHz + (best + 0.5) * s.binHz
	if (Math.abs(rf - EMITTER) < TOLERANCE_HZ) return "new"
	// old samples labelled with the new centre: the emitter shifted by the retune step
	if (Math.abs(rf - (EMITTER + s.centreHz - previousCentre)) < TOLERANCE_HZ)
		return "old"
	return "other"
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out")
		await new Promise(resolve => setTimeout(resolve, 20))
	}
}

const sleep = (ms: number) =>
	new Promise<void>(resolve => setTimeout(resolve, ms))

interface Rig {
	server: SpectrumRtlTcp
	engine: SpectrumEngine
	tuner: TunerController
	blocks: Block[]
	pendings: PendingEpoch[]
	timerEpochs: { epoch: number; startSample: number }[]
	close(): Promise<void>
}

async function startRig(delayMs: number): Promise<Rig> {
	const server = await startSpectrumRtlTcp({
		fs: FS,
		initialHz: C1,
		emitters: [{ hz: EMITTER, amp: 0.25 }],
		seed: 11,
		sendDelayMs: delayMs,
	})
	const logger = createLogger({ level: "fatal" })
	const source: SourceConfig = {
		id: "rtl",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port: server.port,
		loop: false,
		playbackSpeed: 1,
		caps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: FS,
			centerFreq: C1,
			exclusive: false,
		},
	}
	const sources = new SourceManager(logger)
	const fanout = new FanoutManager(logger)
	const routing = new SourceFanoutRouter(sources, fanout, logger, "rtl")
	const tuner = new TunerController(logger, sources)
	wireTunerControl({
		log: logger,
		sourceManager: sources,
		tunerController: tuner,
		tunerRelay: new TunerRelay(logger, sources, new FanoutManager(logger), {
			enabled: false,
			host: "127.0.0.1",
			port: 1,
			controlPolicy: "shared",
		}),
		relayEnabled: false,
	})
	const blocks: Block[] = []
	const pendings: PendingEpoch[] = []
	const timerEpochs: { epoch: number; startSample: number }[] = []
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources,
		routing,
		tuner,
		settings: () =>
			testSettings(s => {
				s.sweep.settleMs.network = NETWORK_SETTLE_MS
			}),
		logger,
		createHost: (cfg, handlers) => {
			const host = createPipelineHost("inline", cfg, handlers, { logger })
			const send = host.send.bind(host)
			host.send = (input, transfer) => {
				if (input.kind === "pending-epoch") pendings.push(input.pending)
				send(input, transfer)
			}
			return host
		},
	})
	engine.on("pipeline", (ev: PipelineEvent, epoch: EngineEpoch) => {
		if (ev.kind === "block-summary")
			blocks.push({ at: performance.now(), summary: ev.summary, epoch })
		else if (ev.kind === "epoch-started" && ev.settleMode === "timer")
			timerEpochs.push({ epoch: ev.epoch, startSample: ev.startSample })
	})
	await sources.connect(source)
	await waitFor(() => tuner.getState("rtl") !== undefined, 10_000)
	// frequency and sample rate written by this core: the stream may be `commanded` (WG9 req 3.1)
	await tuner.setSampleRate("rtl", FS, { origin: "rest" })
	await engine.start()
	engine.setSpectrumFeed(true)
	await tuner.setFrequency("rtl", C1, { origin: "rest" })
	await waitFor(() => blocks.length > 0, 10_000)
	return {
		server,
		engine,
		tuner,
		blocks,
		pendings,
		timerEpochs,
		close: async () => {
			await engine.stop()
			await sources.disconnect("rtl").catch(() => undefined)
			await server.close()
		},
	}
}

interface RetuneResult {
	firstNewMs: number | null
	newCentreBlocks: number
	oldContentBlocks: number
}

/** One operator retune; watches the blocks published during `windowMs` after the command. */
async function retune(
	rig: Rig,
	target: number,
	windowMs: number,
): Promise<RetuneResult> {
	const previous = target === C1 ? C2 : C1
	const from = rig.blocks.length
	const sentAt = performance.now()
	await rig.tuner.setFrequency("rtl", target, { origin: "rest" })
	await sleep(windowMs)
	let firstNewMs: number | null = null
	let newCentreBlocks = 0
	let oldContentBlocks = 0
	for (const b of rig.blocks.slice(from)) {
		if (b.summary.centreHz !== target) continue
		newCentreBlocks++
		const content = contentOf(b.summary, previous)
		if (content === "old") oldContentBlocks++
		if (content === "new" && firstNewMs === null) firstNewMs = b.at - sentAt
	}
	return { firstNewMs, newCentreBlocks, oldContentBlocks }
}

function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return NaN
	const i = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
	return sorted[Math.max(0, i)] ?? NaN
}

const DELAYS = [0, 100, 250, 500]

describe.skipIf(BENCH)("operator retune latency harness (structural)", () => {
	let rig: Rig | null = null
	afterEach(async () => {
		await rig?.close()
		rig = null
	})

	for (const delay of DELAYS) {
		it(`labels operator retunes honestly with a ${delay} ms send delay`, async () => {
			rig = await startRig(delay)
			const retunes = [C2, C1, C2]
			const epochsBefore = rig.pendings.length
			for (const target of retunes) {
				const r = await retune(rig, target, NETWORK_SETTLE_MS + delay + 600)
				expect(r.firstNewMs, `retune to ${target}`).not.toBeNull()
			}
			const blocks = rig.blocks
			const pendings = rig.pendings.slice(epochsBefore)
			// one epoch per retune, centred on the command value
			expect(pendings.map(p => p.centreHz)).toEqual(retunes)
			for (const p of pendings) {
				expect(p.tuningTrust).toBe("commanded")
				expect(p.expectMarker).toBe(false)
				expect(p.staleMaxMs).toBeDefined()
			}
			for (const p of pendings) {
				const verifiedFrom =
					p.commandSample +
					p.bufferedSamples +
					Math.round((NETWORK_SETTLE_MS * FS) / 1000)
				const previous = p.centreHz === C1 ? C2 : C1
				const own = blocks.filter(b => b.summary.epoch === p.epoch)
				expect(own.length).toBeGreaterThan(0)
				const blockSamples =
					rig.engine.config()!.fftSize *
					Math.max(
						1,
						Math.round(
							(rig.engine.config()!.integrationMs * FS) /
								(rig.engine.config()!.fftSize * 1000),
						),
					)
				for (const b of own) {
					const start = b.summary.endSample - blockSamples
					// nothing but unverified before the network settle has elapsed
					if (start < verifiedFrom)
						expect(b.epoch.tuningTrust).toBe("unverified")
					// no commanded/relay block carries pre-retune content
					if (b.epoch.tuningTrust !== "unverified")
						expect(contentOf(b.summary, previous)).not.toBe("old")
				}
				// the epoch reaches its own label once the network settle has passed
				expect(own.some(b => b.epoch.tuningTrust === "commanded")).toBe(true)
			}
		}, 120_000)
	}
})

describe.skipIf(!BENCH)("operator retune latency bench", () => {
	it("measures command → first frame at the new centre", async () => {
		const runs = Number(process.env["WAVEKIT_RETUNE_BENCH_RUNS"] ?? "50")
		const windowMs = Number(
			process.env["WAVEKIT_RETUNE_BENCH_WINDOW_MS"] ?? "1100",
		)
		const lines: string[] = []
		for (const delay of DELAYS) {
			const rig = await startRig(delay)
			const lat: number[] = []
			let missed = 0
			let newBlocks = 0
			let oldBlocks = 0
			try {
				for (let i = 0; i < runs; i++) {
					const r = await retune(rig, i % 2 === 0 ? C2 : C1, windowMs + delay)
					if (r.firstNewMs === null) missed++
					else lat.push(r.firstNewMs)
					newBlocks += r.newCentreBlocks
					oldBlocks += r.oldContentBlocks
				}
			} finally {
				await rig.close()
			}
			lat.sort((a, b) => a - b)
			lines.push(
				`delay ${delay} ms: n=${lat.length} missed=${missed} p50=${quantile(lat, 0.5).toFixed(0)} p90=${quantile(lat, 0.9).toFixed(0)} max=${(lat.at(-1) ?? NaN).toFixed(0)} ms; old-centre blocks ${oldBlocks}/${newBlocks} (${((100 * oldBlocks) / Math.max(1, newBlocks)).toFixed(1)} %)`,
			)
		}
		process.stdout.write(`\nRETUNE BENCH\n${lines.join("\n")}\n`)
		expect(lines).toHaveLength(DELAYS.length)
	}, 3_600_000)
})

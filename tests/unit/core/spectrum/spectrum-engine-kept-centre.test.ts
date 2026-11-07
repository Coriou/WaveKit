/**
 * A command kept for a later stream (a restart, or a boundary still queued) must not post its
 * old explicit centre as `commanded` after the scanner moved the tuner; a scanner hop submitted
 * during a restart is re-posted under the scanner's own rules, never lost or mislabelled.
 * Spectrum engine with the real TunerController and TunerArbiter; the last scene runs the real
 * thread pipeline host with the spectrum worker built from source.
 */
import { build } from "esbuild"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import pino from "pino"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SourceCaps } from "../../../../src/config.js"
import {
	TunerArbiter,
	type ArbiterDeps,
	type Lease,
} from "../../../../src/core/scanner/tuner-arbiter.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import { SpectrumEngine } from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	EngineState,
	PendingEpoch,
	PipelineInput,
	TuningTrust,
} from "../../../../src/core/spectrum/types.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import { TunerController } from "../../../../src/core/tuner-controller.js"
import {
	FakeFanout,
	FakeSources,
	settle,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"

const logger = pino({ level: "silent" })
const RATE = 1_024_000
const FAST_RATE = 2_048_000
const F0 = 446_100_000
const F1 = 446_200_000
const HOP = 446_300_000

class RecordingHost implements PipelineHost {
	readonly inputs: PipelineInput[] = []
	constructor(readonly handlers: PipelineHostHandlers) {}
	send(input: PipelineInput, transfer?: ArrayBuffer): void {
		this.inputs.push(input)
		if (transfer) this.handlers.buffer(transfer)
	}
	exportState(): Promise<EngineState> {
		return Promise.resolve({
			version: 1,
			absoluteFloors: [],
			spurs: [],
			kByRange: [],
		})
	}
	utilization(): number | null {
		return null
	}
	close(): Promise<void> {
		return Promise.resolve()
	}
}

function setup(workerUrl?: URL) {
	const sources = new FakeSources("rtl", { centerFreq: F0, sampleRate: RATE })
	const fanout = new FakeFanout()
	const manager = Object.assign(sources, {
		assertTunerCommandActive: () => {},
		writeToSource: () => true,
		isRtlTcpSource: () => true,
		updateSourceCaps: (id: string, patch: Partial<SourceCaps>) => {
			sources.setCaps(id, patch)
			return sources.getCaps(id)
		},
		setTuningCaps: (id: string, patch: Partial<SourceCaps>) => {
			sources.setCaps(id, patch)
			return sources.getCaps(id)
		},
	})
	const tuner = new TunerController(
		logger,
		manager as unknown as SourceManager,
		{ reconnectPolicy: "restore" },
	)
	tuner.on("error", () => undefined)
	tuner.initializeSource("rtl", sources.getCaps("rtl"))
	const settings = () =>
		testSettings(s => {
			s.sweep.settleMs.network = 100
			s.sweep.markers = false
		})
	const hosts: RecordingHost[] = []
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources,
		routing: {
			getFanout: () => fanout as never,
			releaseUnused: () => undefined,
		},
		tuner,
		settings,
		logger,
		...(workerUrl
			? { host: "thread" as const, workerUrl }
			: {
					createHost: (_cfg, handlers) => {
						const host = new RecordingHost(handlers)
						hosts.push(host)
						return host
					},
				}),
		batchBytes: 4096,
	})
	const deps: ArbiterDeps = {
		tuner: tuner as never,
		sources: manager as never,
		epochs: id => (id === "rtl" ? engine : undefined),
		settings,
		link: () => "network",
		persistLease: () => Promise.resolve(),
		impactSources: {
			liveDemod: null,
			digitalVoice: null,
			decoders: { getAllStatus: () => [] },
		},
		scannerJobsOn: () => [],
		canHandOver: () => true,
		logger,
	}
	const arbiter = new TunerArbiter(deps)
	const inputs = (from = 0) => hosts.slice(from).flatMap(h => h.inputs)
	const streams = (from = 0): TuningTrust[] =>
		inputs(from).flatMap(i => (i.kind === "new-stream" ? [i.tuningTrust] : []))
	const epochs = (from = 0): PendingEpoch[] =>
		inputs(from).flatMap(i => (i.kind === "pending-epoch" ? [i.pending] : []))
	return { sources, fanout, tuner, engine, arbiter, hosts, streams, epochs }
}
type Harness = ReturnType<typeof setup>

async function ready(workerUrl?: URL): Promise<Harness> {
	const t = setup(workerUrl)
	await t.tuner.setSampleRate("rtl", RATE)
	await t.tuner.setFrequency("rtl", F0)
	await t.engine.start()
	return t
}

function lease(t: Harness): Lease {
	const got = t.arbiter.acquire("sweep", "rtl", 50)
	if (!got.ok) throw new Error("acquire failed")
	return got.lease
}

/** The scanner's hop: suppressed, origin scanner, its own pending epoch (the real arbiter). */
async function hop(t: Harness, held: Lease, centreHz: number): Promise<void> {
	await t.arbiter.retune(held, {
		centreHz,
		gainTenthsDb: null,
		sampleRateHz: null,
	})
}

/** Holds the restart in the old host's export; `trigger` starts it (default: a reconfigure). */
async function heldRestart(t: Harness, trigger?: () => Promise<void>) {
	let release!: (state: EngineState) => void
	const old = t.hosts[0]!
	const snapshot = await old.exportState()
	old.exportState = () =>
		new Promise(resolve => {
			release = resolve
		})
	const done = trigger ? trigger() : t.engine.reconfigure()
	return async () => {
		release(snapshot)
		await done
		for (let i = 0; i < 5; i++) await settle()
	}
}

/** True for an epoch that claims a tuned centre other than the one caps holds. */
function staleCommanded(e: PendingEpoch, capsHz: number | undefined): boolean {
	return e.tuningTrust !== "unverified" && e.centreHz !== capsHz
}

describe("kept commands and scanner hops across a restart or a queued boundary", () => {
	it("replay kept by a held restart, then a scanner hop: the old centre never reads commanded", async () => {
		const t = await ready()
		const held = lease(t)
		const finish = await heldRestart(t)
		try {
			t.sources.emit("disconnected", "rtl")
			t.sources.emit("payload-started", "rtl")
			t.tuner.synchronizeOnConnect("rtl")
			await settle()
			await hop(t, held, HOP)
			await settle()
			await finish()
			const caps = t.sources.getCaps("rtl")?.centerFreq
			expect(caps).toBe(HOP)
			expect(t.streams(1)).toEqual(["unverified"])
			const after = t.epochs(1)
			expect(after.filter(e => staleCommanded(e, caps))).toEqual([])
			// The hop held during the restart is the stream's last epoch, under its own label.
			expect(after.at(-1)).toMatchObject({
				centreHz: HOP,
				tuningTrust: "commanded",
				expectMarker: false,
			})
		} finally {
			await t.engine.stop()
		}
	})

	it("replay behind a boundary still buffered, then a scanner hop: the new stream stays unverified at the hop", async () => {
		const t = await ready()
		const held = lease(t)
		const branch = t.fanout.branches.get("scanner-rtl")!.stream
		try {
			branch.pause()
			t.fanout.write(Buffer.alloc(2048))
			t.sources.emit("disconnected", "rtl")
			t.sources.emit("payload-started", "rtl")
			t.tuner.synchronizeOnConnect("rtl")
			await settle()
			await hop(t, held, HOP)
			await settle()
			const before = t.epochs().length
			branch.resume()
			for (let i = 0; i < 5; i++) await settle()
			const caps = t.sources.getCaps("rtl")?.centerFreq
			expect(caps).toBe(HOP)
			expect(t.streams().at(-1)).toBe("unverified")
			const posted = t.epochs().slice(before)
			expect(posted.filter(e => staleCommanded(e, caps))).toEqual([])
			expect(posted.at(-1)).toMatchObject({
				centreHz: HOP,
				tuningTrust: "unverified",
			})
		} finally {
			branch.resume()
			await t.engine.stop()
		}
	})

	it("a frequency written during a rate restart opens the restarted stream unverified, then proves it", async () => {
		const t = await ready()
		// An operator rate change restarts the pipeline with its own `commanded` label.
		const finish = await heldRestart(t, () =>
			t.tuner.setSampleRate("rtl", FAST_RATE),
		)
		try {
			await settle()
			expect(t.hosts).toHaveLength(1)
			await t.tuner.setFrequency("rtl", F1)
			await settle()
			await finish()
			expect(t.hosts).toHaveLength(2)
			expect(t.streams(1)).toEqual(["unverified"])
			expect(t.epochs(1).at(-1)).toMatchObject({
				centreHz: F1,
				sampleRateHz: FAST_RATE,
				tuningTrust: "commanded",
			})
		} finally {
			await t.engine.stop()
		}
	})

	it("a scanner hop submitted during a restart is re-posted with its settle, timed from the new stream", async () => {
		const t = await ready()
		const held = lease(t)
		const finish = await heldRestart(t)
		try {
			await hop(t, held, HOP)
			await settle()
			await finish()
			// The old host, closing, never took it.
			expect(t.epochs(0).length - t.epochs(1).length).toBe(0)
			expect(t.streams(1)).toEqual(["unverified"])
			// The arbiter's own settle for a network link (100 ms here), not an operator settle.
			expect(t.epochs(1)).toEqual([
				expect.objectContaining({
					centreHz: HOP,
					tuningTrust: "commanded",
					commandSample: 0,
					settleSamples: (100 * RATE) / 1000,
					expectMarker: false,
				}),
			])
			expect(t.epochs(1)[0]?.verifiedFromSample).toBeUndefined()
		} finally {
			await t.engine.stop()
		}
	})

	it("a held hop whose write has not reached caps posts unverified at the caps centre", async () => {
		const t = await ready()
		const finish = await heldRestart(t)
		try {
			const clock = t.engine.sampleClock()
			t.engine.submitEpoch({
				epoch: t.engine.allocateEpoch(),
				commandSample: clock.commandSample,
				bufferedSamples: clock.bufferedSamples,
				settleSamples: 1024,
				expectMarker: true,
				markerTimeoutSamples: 4096,
				pllSettleSamples: 0,
				centreHz: HOP,
				sampleRateHz: RATE,
				gainKey: "agc",
				tuningTrust: "commanded",
				centreChanged: true,
			})
			await finish()
			expect(t.epochs(1).at(-1)).toMatchObject({
				centreHz: F0,
				tuningTrust: "unverified",
				expectMarker: false,
			})
		} finally {
			await t.engine.stop()
		}
	})

	it("a hop held during a restart that a disconnect follows is dropped with its connection", async () => {
		const t = await ready()
		const held = lease(t)
		const finish = await heldRestart(t)
		try {
			await hop(t, held, HOP)
			await settle()
			t.sources.emit("disconnected", "rtl")
			t.sources.emit("payload-started", "rtl")
			await settle()
			await finish()
			expect(t.streams(1)).toEqual(["unverified"])
			expect(t.epochs(1)).toEqual([])
		} finally {
			await t.engine.stop()
		}
	})
})

describe("real thread pipeline host: rate change, write, reconnect, replay, hop", () => {
	const dir = mkdtempSync(join(tmpdir(), "wavekit-kept-centre-"))
	const worker = join(dir, "spectrum-worker.mjs")
	beforeAll(async () => {
		await build({
			entryPoints: ["src/core/spectrum/spectrum-worker.ts"],
			bundle: true,
			platform: "node",
			format: "esm",
			outfile: worker,
			define: { __WAVEKIT_VERSION__: JSON.stringify("test") },
			// Bundled CommonJS dependencies need a require in an ES module worker.
			banner: {
				js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
			},
			logLevel: "silent",
		})
	}, 60_000)
	afterAll(() => rmSync(dir, { recursive: true, force: true }))

	it("never ends commanded at a centre other than caps", async () => {
		const chunk = Buffer.alloc(16_384, 127)
		for (let round = 0; round < 8; round++) {
			const t = await ready(pathToFileURL(worker))
			let flowing = true
			const pump = async () => {
				while (flowing) {
					t.fanout.write(chunk)
					t.fanout.write(chunk)
					await settle()
				}
			}
			const pumping = pump()
			try {
				for (let i = 0; i < 4; i++) await settle()
				// Rate change: the worker restarts behind a real backlog.
				await t.tuner.setSampleRate("rtl", FAST_RATE)
				await t.tuner.setFrequency("rtl", F1)
				const held = lease(t)
				for (let i = 0; i < round % 4; i++) await settle()
				t.sources.emit("disconnected", "rtl")
				t.sources.emit("payload-started", "rtl")
				t.tuner.synchronizeOnConnect("rtl")
				for (let i = 0; i < Math.floor(round / 4); i++) await settle()
				await hop(t, held, HOP + round * 10_000)
				// Let the restart finish and every posted epoch start on the worker.
				const restarting = () =>
					(t.engine as unknown as { restarting: boolean }).restarting
				for (let i = 0; i < 40 || (restarting() && i < 4000); i++)
					await new Promise(resolve => setTimeout(resolve, 2))
				await t.engine.exportState()
				for (let i = 0; i < 10; i++) await settle()
				const caps = t.sources.getCaps("rtl")?.centerFreq
				const epoch = t.engine.currentEpoch()
				expect(caps).toBe(HOP + round * 10_000)
				if (epoch.tuningTrust !== "unverified")
					expect({ round, centreHz: epoch.centreHz }).toEqual({
						round,
						centreHz: caps,
					})
			} finally {
				flowing = false
				await pumping
				await t.engine.stop()
			}
		}
	}, 60_000)
})

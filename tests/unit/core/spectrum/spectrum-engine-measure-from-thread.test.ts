/**
 * A track's re-measurement (measure-from) on the worker-thread pipeline host, with a long source
 * id: the track ids the pipeline makes start with the source id, so the worker must accept every
 * id it made (no length bound of its own), and a measure-from it cannot use is ignored, never a
 * worker error (a worker error raises a pipeline-error doubt, which would re-prove the tuning
 * and ask again: a doubt loop). Real SpectrumEngine, the bundled worker, a real TuningLedger, a
 * carrier on air at the same offset across the receipt's settle boundary.
 */
import { build } from "esbuild"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import pino from "pino"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ThreadPipelineHost } from "../../../../src/core/spectrum/pipeline-host.js"
import {
	SpectrumEngine,
	buildPipelineConfig,
	installSpectrumWorkerUrl,
	type EngineEpoch,
} from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	PipelineEvent,
	PipelineInput,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import { TuningLedger } from "../../../../src/core/tuning-ledger.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	packCu8,
	tone,
} from "../../../mocks/scanner/signals.js"

const CENTRE = 446_100_000
const RATE = 1_024_000
/** The ledger's settle: 100 ms at 1.024 Msps U8 = 204 800 bytes (no in-flight term). */
const SETTLE_MS = 100
/** A source id longer than any bound short of the id format: the pipeline's track ids exceed 64. */
const SOURCE = "a".repeat(60)

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, ms = 15_000): Promise<void> {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await wait(10)
	}
}

function frame(cmd: number, value: number): Buffer {
	const b = Buffer.alloc(5)
	b[0] = cmd
	b.writeUInt32BE(value, 1)
	return b
}

describe("measure-from on the worker-thread host", () => {
	const dir = mkdtempSync(join(tmpdir(), "wk-measure-worker-"))
	const worker = join(dir, "spectrum-worker.mjs")
	beforeAll(async () => {
		await build({
			entryPoints: ["src/core/spectrum/spectrum-worker.ts"],
			bundle: true,
			platform: "node",
			format: "esm",
			outfile: worker,
			define: { __WAVEKIT_VERSION__: JSON.stringify("test") },
			banner: {
				js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
			},
			logLevel: "silent",
		})
		installSpectrumWorkerUrl(pathToFileURL(worker))
	}, 60_000)
	afterAll(() => {
		installSpectrumWorkerUrl(undefined)
		rmSync(dir, { recursive: true, force: true })
	})

	it("a long source id: the carrier across the receipt is re-measured and trusted, with no worker error and no pipeline-error doubt", async () => {
		const sources = new FakeSources(SOURCE)
		const fanout = new FakeFanout()
		const ledger = new TuningLedger({
			settleLink: () => ({ configuredSettleMs: SETTLE_MS, inFlightBytes: 0 }),
			frameBytes: () => 2,
			capsRate: () => RATE,
		})
		const conn = ledger.connection(SOURCE)
		const session = conn.start()!
		const engine = new SpectrumEngine({
			sourceId: SOURCE,
			sources,
			routing: {
				getFanout: () => fanout as never,
				releaseUnused: () => undefined,
			},
			tuner: new FakeTuner(),
			ledger,
			settings: () => testSettings(),
			logger: pino({ level: "silent" }),
			host: "thread",
		})
		const errors: unknown[] = []
		engine.on("error", err => errors.push(err))
		const tracks: { track: TrackSnapshot; trust: string }[] = []
		engine.on("pipeline", (ev: PipelineEvent, epoch: EngineEpoch) => {
			if (
				ev.kind === "track-open" ||
				ev.kind === "track-update" ||
				ev.kind === "track-close"
			)
				tracks.push({ track: ev.track, trust: epoch.tuningTrust })
		})
		await engine.start()
		const rng = mulberry32(11)
		const chunk = 16_384
		const feed = async (chunks: number) => {
			for (let i = 0; i < chunks; i++) {
				const iq = gaussianNoise(rng, chunk, 0.02)
				addInto(iq, tone(chunk, RATE, 150_000, 0.3))
				const bytes = Buffer.from(packCu8(iq.re, iq.im))
				session.pos += bytes.length
				fanout.write(bytes)
				await wait(2)
			}
		}
		try {
			// The carrier is on air before the frames' receipt and stays at the same offset.
			await feed(8)
			conn.write(Buffer.concat([frame(0x02, RATE), frame(0x01, CENTRE)]), {
				writer: "operator",
			})(null)
			// Track updates come once per second of blocks: feed until the re-measured one is out (or
			// for 4 s of samples, 250 chunks).
			const done = () =>
				tracks.some(
					t =>
						t.trust === "commanded" && t.track.measuredFromSample !== undefined,
				)
			for (let i = 0; i < 250 && !done(); i++) await feed(1)
			await until(done, 5000).catch(err => {
				throw new Error(
					`${String(err)}: ${JSON.stringify({
						tracks: tracks.map(t => [t.trust, t.track.measuredFromSample]),
						errors: errors.map(String),
						doubts: ledger.doubts(SOURCE),
					})}`,
				)
			})
			const born = tracks[0]!
			expect(born.trust).toBe("unverified")
			expect(born.track.trackId.length).toBeGreaterThan(64)
			const trusted = tracks.find(t => t.trust === "commanded")!
			expect(trusted.track.trackId).toBe(born.track.trackId)
			expect(errors).toEqual([])
			expect(
				ledger.doubts(SOURCE).filter(d => d.reason === "pipeline-error"),
			).toEqual([])
		} finally {
			await engine.stop()
		}
	}, 60_000)

	it("a measure-from the worker cannot validate is dropped without a worker error", async () => {
		const cfg = buildPipelineConfig(SOURCE, "U8_IQ", RATE, testSettings(), {
			fftSize: null,
			integrationMs: null,
			thresholdDb: null,
			sensitivity: null,
		})
		const errors: Error[] = []
		const buffers: ArrayBuffer[] = []
		const host = new ThreadPipelineHost(
			cfg,
			{
				events: () => undefined,
				buffer: buf => buffers.push(buf),
				error: err => errors.push(err),
			},
			pathToFileURL(worker),
			pino({ level: "silent" }),
		)
		try {
			const bad = [
				{ kind: "measure-from", stream: 0, epoch: 1, trackId: "", sample: 5 },
				{ kind: "measure-from", stream: -1, epoch: 1, trackId: "t", sample: 5 },
				{
					kind: "measure-from",
					stream: 0,
					epoch: 1,
					trackId: "t",
					sample: 0.5,
				},
			]
			for (const input of bad) host.send(input as unknown as PipelineInput)
			// Then a malformed input of another kind: still an error (only measure-from is exempt).
			host.send({ kind: "spectrum-feed" } as unknown as PipelineInput)
			await until(() => errors.length > 0, 5000)
			await wait(50)
			expect(errors).toHaveLength(1)
			expect(errors[0]?.message).toMatch(/enabled/)
		} finally {
			await host.close()
		}
	}, 30_000)
})

import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import process from "node:process"
import pino from "pino"
import {
	InlinePipelineHost,
	ThreadPipelineHost,
} from "../../../../src/core/spectrum/pipeline-host.js"
import { buildPipelineConfig } from "../../../../src/core/spectrum/spectrum-engine.js"
import type { PipelineEvent } from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	packCu8,
	tone,
} from "../../../mocks/scanner/signals.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"

const WORKER = resolve("dist/spectrum-worker.js")
const KERNEL = resolve("dist/spectrum-frame.wasm")

// Runs after `pnpm run build`; skipped on a clean checkout.
describe.skipIf(!existsSync(WORKER))("built spectrum worker", () => {
	it("runs the pipeline off-thread, returns transferred buffers and exports state", async () => {
		const fs = 1_024_000
		const cfg = buildPipelineConfig("rtl", "U8_IQ", fs, testSettings(), {
			fftSize: null,
			integrationMs: null,
			thresholdDb: null,
			sensitivity: null,
		})
		const events: PipelineEvent[] = []
		const returned: ArrayBuffer[] = []
		const errors: Error[] = []
		const host = new ThreadPipelineHost(
			cfg,
			{
				events: evs => events.push(...evs),
				buffer: buf => returned.push(buf),
				error: err => errors.push(err),
			},
			pathToFileURL(WORKER),
			pino({ level: "silent" }),
		)
		host.send({
			kind: "new-stream",
			stream: 0,
			centreHz: 446_100_000,
			sampleRateHz: fs,
			gainKey: "m:296",
			tuningTrust: "commanded",
		})
		const iq = gaussianNoise(mulberry32(7), fs / 4, 0.05)
		const bytes = packCu8(iq.re, iq.im)
		const buf = new ArrayBuffer(bytes.length)
		new Uint8Array(buf).set(bytes)
		host.send(
			{ kind: "bytes", startSample: 0, bytes: new Uint8Array(buf) },
			buf,
		)
		expect(buf.byteLength).toBe(0)
		const state = await host.exportState()
		expect(state.version).toBe(1)
		// Artefact masks cross by structured clone (Task 35a): equal to an inline pipeline fed the same input.
		const inline = new InlinePipelineHost(cfg, {
			events: () => undefined,
			buffer: () => undefined,
			error: err => errors.push(err),
		})
		inline.send({
			kind: "new-stream",
			stream: 0,
			centreHz: 446_100_000,
			sampleRateHz: fs,
			gainKey: "m:296",
			tuningTrust: "commanded",
		})
		inline.send({
			kind: "bytes",
			startSample: 0,
			bytes: Uint8Array.from(bytes),
		})
		expect(await host.artefactMasks()).toEqual(await inline.artefactMasks())
		await inline.close()
		expect(returned.map(b => b.byteLength)).toEqual([bytes.length])
		expect(events.some(e => e.kind === "epoch-started")).toBe(true)
		await host.close()
		expect(errors).toEqual([])
	})
})

/** What the pipeline decided, without the ids (they carry each pipeline's start time). */
function decisions(events: PipelineEvent[]): unknown[] {
	return events.map(e => {
		if (
			e.kind === "track-open" ||
			e.kind === "track-update" ||
			e.kind === "track-close"
		)
			return [
				e.kind,
				e.track.centreHz,
				e.track.obwHz,
				e.track.dutyCycle,
				e.track.flags,
				e.track.snrDb,
			]
		if (e.kind === "block-summary")
			return [
				e.kind,
				e.summary.floorDbfs,
				e.summary.thresholdDb,
				e.summary.overload,
				e.summary.tracks.map(t => [t.startHz, t.endHz, t.flags]),
			]
		return [e.kind]
	})
}

// The bundled worker loads dist/spectrum-frame.wasm beside it (native/wavekit-frame/build.sh); the
// inline host is the JS frame path. Skipped unless both are built; with WAVEKIT_REQUIRE_FRAME_WASM=1
// a built worker without the kernel runs, and fails, instead (frame-wasm-harness.ts).
const SKIP_WASM_WORKER =
	!existsSync(WORKER) ||
	(!existsSync(KERNEL) && process.env["WAVEKIT_REQUIRE_FRAME_WASM"] !== "1")
describe.skipIf(SKIP_WASM_WORKER)(
	"built spectrum worker with the wasm frame kernel",
	() => {
		it("decides like the inline JS pipeline on a signal scene", async () => {
			expect(existsSync(KERNEL), KERNEL).toBe(true)
			const fs = 1_024_000
			const cfg = buildPipelineConfig("rtl", "U8_IQ", fs, testSettings(), {
				fftSize: null,
				integrationMs: null,
				thresholdDb: null,
				sensitivity: null,
			})
			const threadEvents: PipelineEvent[] = []
			const inlineEvents: PipelineEvent[] = []
			const errors: Error[] = []
			const host = new ThreadPipelineHost(
				cfg,
				{
					events: evs => threadEvents.push(...evs),
					buffer: () => undefined,
					error: err => errors.push(err),
				},
				pathToFileURL(WORKER),
				pino({ level: "silent" }),
			)
			const inline = new InlinePipelineHost(cfg, {
				events: evs => inlineEvents.push(...evs),
				buffer: () => undefined,
				error: err => errors.push(err),
			})
			const start = {
				kind: "new-stream" as const,
				stream: 0,
				centreHz: 446_100_000,
				sampleRateHz: fs,
				gainKey: "m:296",
				tuningTrust: "commanded" as const,
			}
			host.send(start)
			inline.send(start)
			host.send({ kind: "spectrum-feed", enabled: true })
			inline.send({ kind: "spectrum-feed", enabled: true })
			const total = fs
			const iq = gaussianNoise(mulberry32(17), total, 0.005)
			addInto(iq, tone(total, fs, 120_000, 0.003))
			const bytes = packCu8(iq.re, iq.im)
			for (let off = 0; off < bytes.length; off += 65_536) {
				const part = bytes.slice(off, off + 65_536)
				inline.send({
					kind: "bytes",
					startSample: off / 2,
					bytes: part.slice(),
				})
				host.send(
					{ kind: "bytes", startSample: off / 2, bytes: part },
					part.buffer,
				)
			}
			await host.exportState() // ordered after every input
			await host.close()
			await inline.close()
			expect(errors).toEqual([])
			expect(threadEvents.length).toBe(inlineEvents.length)
			expect(threadEvents.some(e => e.kind === "track-open")).toBe(true)
			expect(decisions(threadEvents)).toEqual(decisions(inlineEvents))
		})
	},
)

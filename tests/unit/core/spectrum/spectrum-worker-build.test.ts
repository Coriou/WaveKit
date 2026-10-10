import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import pino from "pino"
import {
	InlinePipelineHost,
	ThreadPipelineHost,
} from "../../../../src/core/spectrum/pipeline-host.js"
import { buildPipelineConfig } from "../../../../src/core/spectrum/spectrum-engine.js"
import type { PipelineEvent } from "../../../../src/core/spectrum/types.js"
import {
	gaussianNoise,
	mulberry32,
	packCu8,
} from "../../../mocks/scanner/signals.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"

const WORKER = resolve("dist/spectrum-worker.js")

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

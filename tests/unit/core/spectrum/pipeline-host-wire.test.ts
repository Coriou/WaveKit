import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import pino from "pino"
import { ThreadPipelineHost } from "../../../../src/core/spectrum/pipeline-host.js"
import { buildPipelineConfig } from "../../../../src/core/spectrum/spectrum-engine.js"
import type { PipelineEvent } from "../../../../src/core/spectrum/types.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"

const dir = mkdtempSync(join(tmpdir(), "wavekit-wire-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A stand-in worker that answers init with a wire summary, then a malformed one. */
const FAKE = `
import { parentPort } from "node:worker_threads"
const summary = bins => ({ sourceId: "rtl", stream: 0, epoch: 1, endSample: 0, centreHz: 1, sampleRateHz: 1, binHz: 1, startHz: 0, bins, floorDbfs: -90, thresholdDb: 6, tracks: [], masks: { dcHz: 1, dcGuardHz: 0, spurRanges: [] }, floorOccupied: false, overload: false })
parentPort.on("message", m => {
	if (m.type === "init") {
		const good = Int16Array.of(-181, 0, 32767, -32768)
		parentPort.postMessage({ type: "events", events: [{ kind: "block-summary", summary: summary([]), binsEncoding: "i16-half-db", binsI16: good, binCount: 4 }, { kind: "block-summary", summary: summary([-0, Infinity]) }] }, [good.buffer])
		const bad = new Int16Array(3)
		parentPort.postMessage({ type: "events", events: [{ kind: "block-summary", summary: summary([]), binsEncoding: "i16-half-db", binsI16: bad, binCount: 4 }] }, [bad.buffer])
	}
	if (m.type === "close") parentPort.close()
})
`

describe("ThreadPipelineHost wire decode", () => {
	it("decodes int16 summaries to number[] and refuses a length mismatch", async () => {
		const file = join(dir, "fake-worker.mjs")
		writeFileSync(file, FAKE)
		const cfg = buildPipelineConfig(
			"rtl",
			"U8_IQ",
			1_024_000,
			testSettings(),
			{
				fftSize: null,
				integrationMs: null,
				thresholdDb: null,
				sensitivity: null,
			},
			undefined,
			2048,
		)
		const events: PipelineEvent[] = []
		const errors: Error[] = []
		const host = new ThreadPipelineHost(
			cfg,
			{
				events: evs => events.push(...evs),
				buffer: () => undefined,
				error: err => errors.push(err),
			},
			pathToFileURL(file),
			pino({ level: "silent" }),
		)
		const deadline = Date.now() + 3000
		while (errors.length === 0 && Date.now() < deadline)
			await new Promise(r => setTimeout(r, 10))
		await host.close()
		expect(events).toHaveLength(2)
		const [a, b] = events
		if (a?.kind !== "block-summary" || b?.kind !== "block-summary")
			throw new Error("kinds")
		expect(Object.keys(a).sort()).toEqual(["kind", "summary"])
		expect(a.summary.bins).toEqual([-90.5, 0, 16383.5, -16384])
		expect(Object.is(b.summary.bins[0], -0)).toBe(true)
		expect(b.summary.bins[1]).toBe(Infinity)
		expect(errors).toHaveLength(1)
		expect(errors[0]?.message).toMatch(/Invalid spectrum worker message/)
	})
})

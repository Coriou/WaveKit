/**
 * A store refusal (`handle.ready` rejected: storage cap, disk-low, ...) is logged with its error
 * code (allowlisted fields only), at most once per code per STORE_REFUSAL_LOG_MS, so
 * `refused:store` is diagnosable from the log. Synthetic signals only.
 */
import { Writable } from "node:stream"
import pino from "pino"
import { describe, expect, it } from "vitest"
import { STORE_REFUSAL_LOG_MS } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import {
	AnalogStorageBytesError,
	AnalogStorageCountError,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { harness, input, snapshot } from "./wideband-recorder-harness.js"

function capture(): { logger: pino.Logger; lines: Record<string, unknown>[] } {
	const lines: Record<string, unknown>[] = []
	const sink = new Writable({
		write(chunk: Buffer, _enc, done) {
			for (const line of chunk.toString().split("\n"))
				if (line.trim() !== "")
					lines.push(JSON.parse(line) as Record<string, unknown>)
			done()
		},
	})
	return { logger: pino({ level: "info" }, sink), lines }
}

describe("WidebandAnalogRecorder store refusal log", () => {
	it("a rejected readiness logs its code once (the retry within 60 s is not logged again), never its message", async () => {
		const { logger, lines } = capture()
		const refusal = new WaveKitError(
			"secret-path /x/y",
			"SCANNER_ANALOG_STORAGE_CAP",
		)
		const readyHold = Promise.reject(refusal)
		readyHold.catch(() => undefined)
		const h = harness({ readyHold, logger })
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		await h.feed(6, true, () =>
			h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
		)
		await h.rec.idle()
		await new Promise(resolve => setImmediate(resolve))
		// Two admissions refused (the first retried once), one line.
		expect(h.ops).toHaveLength(2)
		const refused = lines.filter(
			l => l["msg"] === "Wideband analog recording refused by the store",
		)
		expect(refused).toHaveLength(1)
		expect(refused[0]).toMatchObject({
			level: 30,
			reason: "store-refused",
			err: { type: "WaveKitError", code: "SCANNER_ANALOG_STORAGE_CAP" },
		})
		expect(JSON.stringify(refused[0])).not.toContain("secret-path")
	}, 60_000)

	it("the window: a code again at 59 999 ms is not logged, at 60 000 ms it is; another code logs at once", () => {
		const { logger, lines } = capture()
		const h = harness({ logger })
		let now = 1_000_000
		const rec = h.rec as unknown as {
			deps: { now: () => number }
			noteStoreRefusal(err: unknown): void
		}
		rec.deps.now = () => now
		const cap = new WaveKitError("m", "SCANNER_ANALOG_STORAGE_CAP")
		const low = new WaveKitError("m", "SCANNER_ANALOG_DISK_LOW")
		const logged = (): unknown[] =>
			lines
				.filter(
					l => l["msg"] === "Wideband analog recording refused by the store",
				)
				.map(l => (l["err"] as { code?: string }).code)
		rec.noteStoreRefusal(cap)
		now += STORE_REFUSAL_LOG_MS - 1
		rec.noteStoreRefusal(cap)
		rec.noteStoreRefusal(low)
		now += 1
		rec.noteStoreRefusal(cap)
		expect(logged()).toEqual([
			"SCANNER_ANALOG_STORAGE_CAP",
			"SCANNER_ANALOG_DISK_LOW",
			"SCANNER_ANALOG_STORAGE_CAP",
		])
	})

	it("the byte and the count refusals share a code but are told apart (cap): both log within the window", () => {
		const { logger, lines } = capture()
		const h = harness({ logger })
		const now = 2_000_000
		const rec = h.rec as unknown as {
			deps: { now: () => number }
			noteStoreRefusal(err: unknown): void
		}
		rec.deps.now = () => now
		rec.noteStoreRefusal(new AnalogStorageBytesError("m"))
		rec.noteStoreRefusal(new AnalogStorageCountError("m"))
		// Repeats of either within the window are not logged again.
		rec.noteStoreRefusal(new AnalogStorageBytesError("m"))
		rec.noteStoreRefusal(new AnalogStorageCountError("m"))
		const logged = lines
			.filter(
				l => l["msg"] === "Wideband analog recording refused by the store",
			)
			.map(l => ({
				code: (l["err"] as { code?: string }).code,
				cap: l["cap"],
			}))
		expect(logged).toEqual([
			{ code: "SCANNER_ANALOG_STORAGE_CAP", cap: "bytes" },
			{ code: "SCANNER_ANALOG_STORAGE_CAP", cap: "count" },
		])
	})
})

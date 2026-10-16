/**
 * WG7 ambient hot-path budget (≤ 20 µs per message). Run with AMB_BENCH=1; skipped otherwise.
 * Uses fake decoder status (a Map lookup), so it measures AmbientEvidence plus the interpreters.
 */
import { describe, expect, it } from "vitest"
import { EventEmitter } from "node:events"
import pino from "pino"
import { AmbientEvidence } from "../../../../src/core/scanner/probes/ambient.js"
import type { DecoderOutputLike } from "../../../../src/core/scanner/probes/confirm/double-match.js"

const N = 10_000
const at = new Date(1_000)
const gen: Record<string, (i: number) => DecoderOutputLike> = {
	"ais-catcher": i => ({
		type: "ship",
		data: { mmsi: String(200_000_000 + (i % 500)), channel: i % 2 ? "A" : "B" },
		timestamp: at,
	}),
	acarsdec: i => ({
		type: "acars",
		data: { tail: `PH-${i % 500}`, frequency: 131_550_000, error: 0 },
		timestamp: at,
	}),
	dumpvdl2: i => ({
		type: "vdl2",
		data: {
			fromaddr: (0x400000 + (i % 500)).toString(16).toUpperCase(),
			frequency: 136_975_000,
		},
		timestamp: at,
	}),
	"lora-meshtastic": i => ({
		type: "meshtastic",
		data: { from: i % 500, frequency: 869_525_000, viaMqtt: false },
		timestamp: at,
	}),
}
const targets: Record<string, number[]> = {
	"ais-catcher": [161_975_000, 162_025_000],
	acarsdec: [131_550_000],
	dumpvdl2: [136_975_000],
	"lora-meshtastic": [869_525_000],
}

describe.skipIf(!process.env["AMB_BENCH"])("ambient WG7 bench", () => {
	it("stays within 20 µs per message", () => {
		const status = new Map<string, object>()
		const decoders = Object.assign(new EventEmitter(), {
			getAllStatus: () => [...status.values()],
			getStatus: (id: string) => status.get(id),
			getDecoder: () => undefined,
		})
		for (const type of Object.keys(gen))
			status.set(type, {
				id: type,
				type,
				owner: "config",
				running: true,
				health: "running",
				suspended: false,
			})
		const ambient = new AmbientEvidence({
			decoders: decoders as never,
			targetOf: id => {
				const t = targets[id] ?? [1]
				return { sourceId: "rtl", hz: t[0] ?? 1, targetsHz: t, external: false }
			},
			epochOf: () => 1,
			logger: pino({ level: "silent" }),
			tuningTrustOf: () => "commanded",
		})
		let n = 0
		ambient.on("evidence", () => n++)
		ambient.start()
		const lines: string[] = []
		for (const type of Object.keys(gen)) {
			const msgs = Array.from({ length: N }, (_, i) => gen[type]!(i))
			const runs: number[] = []
			for (let r = 0; r < 3; r++) {
				const t0 = performance.now()
				for (const m of msgs) decoders.emit("decoder:output", type, m)
				runs.push(((performance.now() - t0) * 1000) / N)
			}
			runs.sort((a, b) => a - b)
			const median = runs[1] ?? 0
			lines.push(`${type}: ${median.toFixed(2)} µs/message`)
			expect(median).toBeLessThan(20)
		}
		expect(n).toBeGreaterThan(0)
		process.stdout.write(`${lines.join("\n")}\n`)
	})
})

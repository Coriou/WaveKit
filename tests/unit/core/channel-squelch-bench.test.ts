/**
 * CPU cost of the channel squelch against the implementation it replaces, on demand only
 * (`WAVEKIT_SQUELCH_BENCH=1`; skipped otherwise). 60 s of 25 kHz complex float32 IQ in 4 KiB
 * chunks, alternating the two classes three times, for a closed gate (noise below the threshold),
 * an open gate without rotation (squelch off) and an open gate after an unmute (rotated IQ).
 * Prints CPU milliseconds per second of signal from `process.cpuUsage()`; asserts nothing.
 */

import { describe, it } from "vitest"
import { ChannelSquelch } from "../../../src/core/channel-squelch.js"
import { ReferenceChannelSquelch } from "./channel-squelch-reference.js"

const RATE = 25_000
const SECONDS = 60
const CHUNK = 4096

function signal(kind: "noise" | "tone"): Buffer {
	const samples = RATE * SECONDS
	const view = new Float32Array(samples * 2)
	let state = 12345
	for (let n = 0; n < samples; n++) {
		if (kind === "tone") {
			view[2 * n] = 0.3 * Math.cos(n * 0.2 + 1)
			view[2 * n + 1] = 0.3 * Math.sin(n * 0.2 + 1)
		} else {
			state = (Math.imul(state, 1103515245) + 12345) >>> 0
			view[2 * n] = 0.002 * (state / 4294967296 - 0.5)
			state = (Math.imul(state, 1103515245) + 12345) >>> 0
			view[2 * n + 1] = 0.002 * (state / 4294967296 - 0.5)
		}
	}
	return Buffer.from(view.buffer)
}

function cpuMsPerSecond(
	make: () => ChannelSquelch | ReferenceChannelSquelch,
	stream: Buffer,
): number {
	const squelch = make()
	let sink = 0
	const start = process.cpuUsage()
	for (let offset = 0; offset < stream.length; offset += CHUNK)
		for (const block of squelch.process(
			stream.subarray(offset, offset + CHUNK),
		))
			sink += block.length
	const used = process.cpuUsage(start)
	if (sink < 0) throw new RangeError("unreachable")
	return (used.user + used.system) / 1000 / SECONDS
}

describe.skipIf(process.env["WAVEKIT_SQUELCH_BENCH"] !== "1")(
	"ChannelSquelch bench",
	() => {
		it("prints CPU time per second of signal", () => {
			const noise = signal("noise")
			const tone = signal("tone")
			const cases = [
				{ name: "closed (noise, -30 dBFS)", stream: noise, thresholdDbfs: -30 },
				{ name: "open, no rotation (off)", stream: tone, thresholdDbfs: null },
				{
					name: "open after unmute (rotated)",
					stream: tone,
					thresholdDbfs: -30,
				},
			]
			const rows: string[] = [
				"| case | round | new ms/s | reference ms/s |",
				"|---|---|---|---|",
			]
			for (const c of cases) {
				const options = { sampleRate: RATE, thresholdDbfs: c.thresholdDbfs }
				for (let round = 1; round <= 3; round++) {
					const next = cpuMsPerSecond(
						() => new ChannelSquelch(options),
						c.stream,
					)
					const ref = cpuMsPerSecond(
						() => new ReferenceChannelSquelch(options),
						c.stream,
					)
					rows.push(
						`| ${c.name} | ${round} | ${next.toFixed(3)} | ${ref.toFixed(3)} |`,
					)
				}
			}
			process.stdout.write(`${rows.join("\n")}\n`)
		})
	},
)

/**
 * LoRa/Meshtastic full chain: the synthetic LongFast captures in fixtures/lora through the
 * exact pipeline LoraMeshtasticDecoder.getArgs() builds (sox resample to 500 kS/s, os_factor 2,
 * then the gr-lora_sdr wrapper with its carrier-offset search), parsed by the adapter's own
 * parseOutput. Each capture also runs shifted off its channel by up to the 25 kHz the
 * decoder must absorb (a pure shift, as a channel off the capture centre gives); the
 * wrapper's two paths must yield exactly one packet per frame.
 *
 * Opt-in: needs sox, gnuradio, gr-lora_sdr, python3-cryptography/protobuf and the wrapper at
 * /usr/local/bin, i.e. the core image. Run it there with
 *
 *   WAVEKIT_LORA_CHAIN=1 pnpm exec vitest run tests/integration/lora-meshtastic.test.ts
 *
 * Each capture is 0.91 s of 1.024 Msps cu8 centred on the channel (869.525 MHz) holding one
 * frame (fixtures/lora/README.md). The synthetic bench decoded 20 such frames in 7.7 s wall
 * on one CPU (about 0.4 s each), so 120 s per capture is a hang guard, not a budget.
 */

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import pino from "pino"
import { describe, expect, it, onTestFinished } from "vitest"
import {
	LoraMeshtasticDecoder,
	WRAPPER_SCRIPT_PATH,
} from "../../src/decoders/builtin/lora-meshtastic.js"
import type { DecoderOutput } from "../../src/decoders/types.js"

const CAPTURES = ["lora_longfast_dc_snr10.cu8", "lora_longfast_dc_snrm5.cu8"]
const CAPTURE_RATE_HZ = 1_024_000
/** Carrier offsets within the 50 kHz (bw/5) search, past the 2 kHz the old wrapper reached. */
const OFFSETS_HZ = [-25_000, -15_000, -5_000, 5_000, 15_000, 25_000]

/** The cu8 capture moved by offsetHz (complex rotation, then re-quantised to cu8). */
function shiftCu8(data: Buffer, offsetHz: number): Buffer {
	const out = Buffer.alloc(data.length)
	const step = (2 * Math.PI * offsetHz) / CAPTURE_RATE_HZ
	const quantise = (v: number): number =>
		Math.min(255, Math.max(0, Math.round(v * 127.5 + 127.5)))
	for (let n = 0; 2 * n + 1 < data.length; n++) {
		const i = ((data[2 * n] ?? 0) - 127.5) / 127.5
		const q = ((data[2 * n + 1] ?? 0) - 127.5) / 127.5
		const c = Math.cos(step * n)
		const s = Math.sin(step * n)
		out[2 * n] = quantise(i * c - q * s)
		out[2 * n + 1] = quantise(i * s + q * c)
	}
	return out
}
const runChain =
	process.env["WAVEKIT_LORA_CHAIN"] === "1" && existsSync(WRAPPER_SCRIPT_PATH)

class ChainDecoder extends LoraMeshtasticDecoder {
	command(): { command: string; args: string[] } {
		return { command: this.getCommand(), args: this.getArgs() }
	}
	parse(line: string): DecoderOutput | null {
		return this.parseOutput(line)
	}
}

async function decodeCapture(capture: Buffer): Promise<DecoderOutput[]> {
	const decoder = new ChainDecoder(
		{
			id: "chain-lora",
			type: "lora-meshtastic",
			enabled: true,
			options: {
				region: "EU_868",
				preset: "LongFast",
				frequency: 869_525_000,
				channelKey: "AQ==",
				inputSampleRate: 1_024_000,
			},
		},
		pino({ level: "silent" }),
	)
	const { command, args } = decoder.command()
	// The command is a shell pipeline; its own process group lets the cleanup kill every stage.
	const child = spawn(command, args, {
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	})
	// The group, not just the shell: a stage can outlive the shell and hold stdout open.
	const kill = (): void => {
		if (child.pid === undefined) return
		try {
			process.kill(-child.pid, "SIGKILL")
		} catch {
			// The group is already gone.
		}
	}
	// Runs after the test whatever its result, including a timeout.
	onTestFinished(kill)
	child.stdin.on("error", () => {
		// EPIPE when the chain exits before reading the whole capture.
	})
	child.stderr.resume()
	const outputs: DecoderOutput[] = []
	const lines = createInterface({ input: child.stdout })
	lines.on("line", line => {
		const out = decoder.parse(line)
		if (out) outputs.push(out)
	})
	try {
		child.stdin.end(capture)
		await new Promise<void>((done, fail) => {
			child.once("error", fail)
			child.once("close", () => done())
		})
		return outputs
	} finally {
		kill()
	}
}

const readCapture = (file: string): Buffer =>
	readFileSync(resolve("fixtures/lora", file))

describe.skipIf(!runChain)("lora-meshtastic full chain (opt-in)", () => {
	const cases = CAPTURES.flatMap(file => [
		{ file, offsetHz: 0 },
		...OFFSETS_HZ.map(offsetHz => ({ file, offsetHz })),
	])
	for (const { file, offsetHz } of cases) {
		it(`decodes the synthetic frame in ${file} shifted ${offsetHz} Hz`, async () => {
			const capture = readCapture(file)
			const outputs = await decodeCapture(
				offsetHz === 0 ? capture : shiftCu8(capture, offsetHz),
			)
			expect(outputs).toHaveLength(1)
			expect(outputs[0]?.type).toBe("meshtastic")
			expect(outputs[0]?.data).toMatchObject({
				from: 169_552_957,
				to: 0xffffffff,
				id: 305_419_896,
				hopLimit: 3,
				hopStart: 3,
				portnum: 1,
				payloadB64: "aGVsbG8gd2F2ZWtpdA==",
				frequency: 869_525_000,
			})
		}, 120_000)
	}
})

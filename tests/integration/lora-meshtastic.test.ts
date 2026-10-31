/**
 * LoRa/Meshtastic full chain: the synthetic LongFast captures in fixtures/lora through the
 * exact pipeline LoraMeshtasticDecoder.getArgs() builds (sox resample to 2 Msps, then the
 * gr-lora_sdr wrapper), parsed by the adapter's own parseOutput.
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
import { createReadStream, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	LoraMeshtasticDecoder,
	WRAPPER_SCRIPT_PATH,
} from "../../src/decoders/builtin/lora-meshtastic.js"
import type { DecoderOutput } from "../../src/decoders/types.js"

const CAPTURES = ["lora_longfast_dc_snr10.cu8", "lora_longfast_dc_snrm5.cu8"]
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

async function decodeCapture(file: string): Promise<DecoderOutput[]> {
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
	const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
	child.stderr.resume()
	const outputs: DecoderOutput[] = []
	const lines = createInterface({ input: child.stdout })
	lines.on("line", line => {
		const out = decoder.parse(line)
		if (out) outputs.push(out)
	})
	createReadStream(resolve("fixtures/lora", file)).pipe(child.stdin)
	await new Promise<void>((done, fail) => {
		child.once("error", fail)
		child.once("close", () => done())
	})
	return outputs
}

describe.skipIf(!runChain)("lora-meshtastic full chain (opt-in)", () => {
	for (const file of CAPTURES) {
		it(`decodes the synthetic frame in ${file}`, async () => {
			const outputs = await decodeCapture(file)
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

import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"

// Opt in against a built Mac container; these checks make no RF/acceptance claim.
const container = process.env["WAVEKIT_DECODER_SMOKE_CONTAINER"]
describe.skipIf(!container)("built decoder runtime", () => {
	it("includes ACARS JSON output support", () => {
		const result = spawnSync(
			"docker",
			["exec", container!, "acarsdec", "--output", "help"],
			{ encoding: "utf8", timeout: 10000 },
		)
		expect(result.error).toBeUndefined()
		expect(result.stdout + result.stderr).toContain('"json"')
	})
	it("processes finite synthetic IQ through LoRa and exits cleanly at EOF", () => {
		const result = spawnSync(
			"docker",
			[
				"exec",
				"-i",
				container!,
				"python3",
				"/usr/local/bin/lora_meshtastic_decode.py",
				"--bw",
				"250000",
				"--sf",
				"11",
				"--cr",
				"5",
				"--samp-rate",
				"2000000",
				"--frequency",
				"869525000",
				"--channel-key",
				"AQ==",
				"--region",
				"EU_868",
			],
			{
				input: Buffer.alloc(4000001, 128),
				timeout: 15000,
				encoding: "utf8",
				maxBuffer: 1000000,
			},
		)
		expect(result.error).toBeUndefined()
		expect(result.status).toBe(0)
		expect(result.stderr).toContain("flowgraph_start")
		expect(result.stderr).not.toMatch(
			/Segmentation fault|requesting more input data|startup_error/,
		)
	}, 20000)
	it("stops the LoRa scheduler cleanly on TERM during continuous IQ", () => {
		const result = spawnSync(
			"docker",
			[
				"exec",
				container!,
				"/bin/sh",
				"-c",
				"exec timeout --preserve-status -k 2 4 python3 /usr/local/bin/lora_meshtastic_decode.py --bw 250000 --sf 11 --cr 5 --samp-rate 2000000 --frequency 869525000 --channel-key AQ== --region EU_868 < /dev/zero",
			],
			{ encoding: "utf8", timeout: 15000 },
		)
		expect(result.error).toBeUndefined()
		expect(result.status).toBe(0)
		expect(result.stderr).toContain("signal_stop")
		expect(result.stderr).not.toMatch(
			/Segmentation fault|requesting more input data|startup_error/,
		)
	}, 20000)
})

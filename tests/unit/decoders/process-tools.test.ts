import { once } from "node:events"
import { describe, expect, it } from "vitest"
import { spawn, spawnSync } from "node:child_process"
import {
	iqResampleCommand,
	shellCommand,
} from "../../../src/decoders/process-tools.js"

describe("decoder pipeline arguments", () => {
	it("passes shell metacharacters as literal arguments", () => {
		const args = [
			"",
			"a b",
			"'quoted'",
			"$(echo unsafe)",
			"x; echo unsafe",
			"a\\b",
		]
		const command = shellCommand(process.execPath, [
			"-e",
			"process.stdout.write(JSON.stringify(process.argv.slice(1)))",
			...args,
		])
		const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" })
		expect(result.status).toBe(0)
		expect(JSON.parse(result.stdout)).toEqual(args)
	})
	it("rejects invalid sample rates", () => {
		for (const rate of [0, -1, NaN, Infinity])
			expect(() => iqResampleCommand(rate, 2400000)).toThrow()
	})
})

describe("paired IQ resampling with SoX", () => {
	const available = spawnSync("sox", ["--version"]).status === 0
	const inputRate = 2048000
	const frames = 20480
	function tone(frequency: number) {
		const data = Buffer.alloc(frames * 2)
		for (let n = 0; n < frames; n++) {
			const phase = (2 * Math.PI * frequency * n) / inputRate
			data[2 * n] = Math.round(128 + 70 * Math.cos(phase))
			data[2 * n + 1] = Math.round(128 + 70 * Math.sin(phase))
		}
		return data
	}
	it.skipIf(!available)(
		"produces exact rates and preserves complex phase",
		() => {
			for (const rate of [2400000, 384000, 1050000, 2000000]) {
				const result = spawnSync(
					"/bin/sh",
					["-c", iqResampleCommand(inputRate, rate)],
					{ input: tone(50000), maxBuffer: 1000000 },
				)
				expect(result.status).toBe(0)
				expect(result.stdout.length).toBe(
					2 * Math.round((frames * rate) / inputRate),
				)
				let error = 0
				for (let n = 100; n < result.stdout.length / 2 - 100; n++) {
					const phase = (2 * Math.PI * 50000 * n) / rate
					error +=
						Math.abs(result.stdout[2 * n]! - 128 - 70 * Math.cos(phase)) +
						Math.abs(result.stdout[2 * n + 1]! - 128 - 70 * Math.sin(phase))
				}
				expect(error / (result.stdout.length / 2 - 200)).toBeLessThan(3)
			}
		},
	)
	it.skipIf(!available)(
		"produces identical IQ for odd and whole-buffer input chunks",
		async () => {
			async function run(chunkSize: number) {
				const proc = spawn("/bin/sh", [
					"-c",
					iqResampleCommand(inputRate, 1050000),
				])
				const output: Buffer[] = []
				let stderr = ""
				let stdinError: Error | undefined
				proc.stdout.on("data", chunk => output.push(chunk))
				proc.stderr.on("data", chunk => (stderr += String(chunk)))
				// If the pipeline dies early (e.g. fork fails under host load) the
				// writes fail with EPIPE. Record it so the assertion below reports
				// the exit status and SoX/shell stderr instead of an unhandled error.
				proc.stdin.on("error", error => (stdinError = error))
				const closed = once(proc, "close")
				const input = tone(50000)
				for (let n = 0; n < input.length && !stdinError; n += chunkSize) {
					if (!proc.stdin.write(input.subarray(n, n + chunkSize)))
						await Promise.race([
							once(proc.stdin, "drain").catch(() => undefined),
							closed,
						])
				}
				proc.stdin.end()
				const [code, signal] = await closed
				expect(
					{ code, signal, stdinError: stdinError?.message },
					`SoX pipeline stderr: ${stderr}`,
				).toEqual({ code: 0, signal: null, stdinError: undefined })
				return Buffer.concat(output)
			}
			expect(await run(17)).toEqual(await run(frames * 2))
		},
		// Two real SoX subprocesses; allow for a loaded host without masking hangs.
		20_000,
	)

	it.skipIf(!available)(
		"filters signals above the output Nyquist frequency",
		() => {
			const result = spawnSync(
				"/bin/sh",
				["-c", iqResampleCommand(inputRate, 384000)],
				{ input: tone(300000) },
			)
			expect(result.status).toBe(0)
			const middle = result.stdout.subarray(400, -400)
			const rms = Math.sqrt(
				[...middle].reduce((sum, byte) => sum + (byte - 128) ** 2, 0) /
					middle.length,
			)
			expect(rms).toBeLessThan(2)
		},
	)
})

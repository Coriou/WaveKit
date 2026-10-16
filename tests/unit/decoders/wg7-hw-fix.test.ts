// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.3, 9.5
//
// WG7 R1 HW fixes: extraArgs is a config-only operator escape hatch (no flag
// allowlist, operands raw) but bounded by type, entry bytes and total bytes in one
// helper; decoder logs carry counts and presence, never option text, paths or hosts.
import { describe, expect, it } from "vitest"
import pino from "pino"
import fc from "fast-check"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import {
	EXTRA_ARGS_BOUNDS,
	readExtraArgsOption,
	type NumericOptionIssue,
} from "../../../src/decoders/option-values.js"
import { shellArg } from "../../../src/decoders/process-tools.js"
import { Rtl433Decoder } from "../../../src/decoders/builtin/rtl433.js"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import { MultimonDecoder } from "../../../src/decoders/builtin/multimon-ng.js"
import { AcarsdecDecoder } from "../../../src/decoders/builtin/acarsdec.js"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import { AisCatcherDecoder } from "../../../src/decoders/builtin/ais-catcher.js"
import { ReadsbDecoder } from "../../../src/decoders/builtin/readsb.js"
import { DirewolfDecoder } from "../../../src/decoders/builtin/direwolf.js"
import { rtl433OptionsSchema } from "../../../src/decoders/options/rtl433.js"

type Ctor = new (config: DecoderConfig, logger: pino.Logger) => unknown

function config(type: string, options: Record<string, unknown>): DecoderConfig {
	return {
		id: "review",
		type,
		enabled: true,
		options,
	} as unknown as DecoderConfig
}

function capture() {
	const logs: Record<string, unknown>[] = []
	const logger = pino(
		{ level: "trace" },
		{ write: (s: string) => void logs.push(JSON.parse(s)) },
	)
	return { logs, logger }
}

function collect() {
	const issues: [string, NumericOptionIssue][] = []
	return {
		issues,
		warn: (key: string, issue: NumericOptionIssue) =>
			void issues.push([key, issue]),
	}
}

describe("readExtraArgsOption", () => {
	it("absent is silent; a non-array is dropped as invalid", () => {
		const { issues, warn } = collect()
		expect(readExtraArgsOption(undefined, warn)).toBeUndefined()
		expect(readExtraArgsOption(null, warn)).toBeUndefined()
		expect(issues).toEqual([])
		expect(readExtraArgsOption("--evil", warn)).toBeUndefined()
		expect(issues).toEqual([["extraArgs", "invalid"]])
	})

	it("drops non-primitive-string entries without coercing or throwing", () => {
		const { issues, warn } = collect()
		const hostile = [
			"-a",
			{ toString: 0 },
			{ toString: () => "--coerced" },
			5,
			null,
			undefined,
			true,
			Symbol("s"),
			new String("--boxed"),
			["--nested"],
			"-b",
		]
		expect(readExtraArgsOption(hostile, warn)).toEqual(["-a", "-b"])
		expect(issues).toEqual([["extraArgs", "invalid"]])
	})

	it("keeps an entry of exactly 4096 serialized bytes and drops 4097", () => {
		const { issues, warn } = collect()
		const ok = "x".repeat(EXTRA_ARGS_BOUNDS.maxEntryBytes)
		expect(readExtraArgsOption([ok], warn)).toEqual([ok])
		expect(issues).toEqual([])
		expect(readExtraArgsOption(["-a", ok + "x", "-b"], warn)).toEqual([
			"-a",
			"-b",
		])
		expect(issues).toEqual([["extraArgs", "clamped"]])
	})

	it("counts serialized UTF-8 bytes, not UTF-16 units", () => {
		const { warn } = collect()
		// "é" needs quoting: 2 quote bytes + 2 bytes per character.
		const wide = "é".repeat(2048)
		expect(readExtraArgsOption([wide, "-b"], warn)).toEqual(["-b"])
		const fits = "é".repeat(2047)
		expect(readExtraArgsOption([fits], warn)).toEqual([fits])
	})

	it("stops adding entries once the aggregate would pass 65536 bytes", () => {
		const { issues, warn } = collect()
		// 16 × (4095 + 1 separator) = 65536 exactly.
		const big = "y".repeat(EXTRA_ARGS_BOUNDS.maxEntryBytes - 1)
		const sixteen = Array.from({ length: 16 }, () => big)
		expect(readExtraArgsOption(sixteen, warn)).toEqual(sixteen)
		expect(issues).toEqual([])
		const out = readExtraArgsOption([...sixteen, "z", "-later"], warn)
		expect(out).toEqual(sixteen)
		expect(issues).toEqual([["extraArgs", "clamped"]])
	})

	it("keeps the 64-entry cap", () => {
		const { issues, warn } = collect()
		const args = Array.from({ length: 65 }, (_, i) => `-x${i}`)
		expect(readExtraArgsOption(args, warn)).toEqual(args.slice(0, 64))
		expect(issues).toEqual([["extraArgs", "clamped"]])
	})

	it("property: output is a bounded subsequence of the string entries", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(
						fc.string({ maxLength: 5000 }),
						fc.integer(),
						fc.constant(null),
						fc.object(),
					),
					{ maxLength: 80 },
				),
				value => {
					const out = readExtraArgsOption(value, () => undefined) ?? []
					expect(out.length).toBeLessThanOrEqual(64)
					let total = 0
					for (const entry of out) {
						expect(typeof entry).toBe("string")
						const bytes = Buffer.byteLength(shellArg(entry), "utf8")
						expect(bytes).toBeLessThanOrEqual(4096)
						total += bytes + 1
					}
					expect(total).toBeLessThanOrEqual(65536)
					const strings = value.filter(v => typeof v === "string")
					let j = 0
					for (const entry of out) {
						while (j < strings.length && strings[j] !== entry) j++
						expect(j).toBeLessThan(strings.length)
						j++
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

const ADAPTERS: [string, Ctor][] = [
	["rtl433", Rtl433Decoder],
	["dsd-fme", DsdFmeDecoder],
	["acarsdec", AcarsdecDecoder],
	["dumpvdl2", Dumpvdl2Decoder],
	["ais-catcher", AisCatcherDecoder],
	["readsb", ReadsbDecoder],
	["direwolf", DirewolfDecoder],
]

describe.each(ADAPTERS)("%s extraArgs", (type, Decoder) => {
	function build(extraArgs: unknown) {
		const { logs, logger } = capture()
		const d = new Decoder(config(type, { extraArgs }), logger) as {
			options: { extraArgs?: string[] }
		}
		return { d, logs }
	}

	it("drops objects with toString, numbers and null instead of throwing", () => {
		expect(() => build([{ toString: 0 }])).not.toThrow()
		const { d, logs } = build(["-v", { toString: () => "-x" }, 7, null])
		expect(d.options.extraArgs).toEqual(["-v"])
		expect(logs.some(l => l["key"] === "extraArgs")).toBe(true)
	})

	it("drops an oversized entry with a key-only warning", () => {
		const { d, logs } = build(["SECRET-" + "x".repeat(1_048_576), "-v"])
		expect(d.options.extraArgs).toEqual(["-v"])
		expect(logs).toContainEqual(
			expect.objectContaining({ key: "extraArgs", issue: "clamped" }),
		)
		expect(JSON.stringify(logs)).not.toContain("SECRET-")
	})
})

describe("extraArgs operands pass raw (Main decision: operator escape hatch)", () => {
	it("rtl433 passes a sample-rate operand unvalidated", () => {
		const options = { targetSampleRate: 1_000_000, extraArgs: ["-s", "NaN"] }
		expect(rtl433OptionsSchema.safeParse(options).success).toBe(true)
		const d = new Rtl433Decoder(
			config("rtl433", options),
			pino({ level: "silent" }),
		) as unknown as { getDecoderArgs(): string[] }
		expect(d.getDecoderArgs().slice(-2)).toEqual(["-s", "NaN"])
	})
})

describe("extraArgs reaching sh -c are quoted", () => {
	const META = "a;touch /tmp/wg7-pwned $(id) `id` | x & 'q'"

	it("shellArg round-trips a metacharacter entry through /bin/sh", () => {
		const result = spawnSync("/bin/sh", ["-c", `printf %s ${shellArg(META)}`])
		expect(result.stdout.toString()).toBe(META)
	})

	it.each([
		["rtl433", Rtl433Decoder, {}],
		["dsd-fme", DsdFmeDecoder, {}],
		["acarsdec", AcarsdecDecoder, {}],
		["dumpvdl2", Dumpvdl2Decoder, {}],
		["ais-catcher", AisCatcherDecoder, {}],
		["readsb", ReadsbDecoder, {}],
		["direwolf", DirewolfDecoder, {}],
	] as [string, Ctor, Record<string, unknown>][])(
		"%s quotes the entry in its shell pipeline",
		(type, Decoder, extra) => {
			const d = new Decoder(
				config(type, { ...extra, extraArgs: [META] }),
				pino({ level: "silent" }),
			) as { getArgs(): string[] }
			const args = d.getArgs()
			expect(args[0]).toBe("-c")
			const command = args[1]!
			expect(command).toContain(shellArg(META))
			// -n: syntax check only, nothing runs.
			const result = spawnSync("/bin/sh", ["-n", "-c", command])
			expect(result.status).toBe(0)
		},
	)

	it("a maximal extraArgs list still fits a shell invocation", () => {
		const options = { extraArgs: ["x".repeat(1_048_576)] }
		const d = new Rtl433Decoder(
			config("rtl433", options),
			pino({ level: "silent" }),
		) as unknown as { getArgs(): string[] }
		const result = spawnSync("/bin/sh", ["-n", "-c", d.getArgs()[1]!])
		expect(result.error?.message).toBeUndefined()
		expect(d.getArgs()[1]!.length).toBeLessThan(70_000)
	})
})

describe("decoder logs carry no option text, paths or hosts", () => {
	it("updateOptions logs a count, not keys or values", () => {
		const { logs, logger } = capture()
		const d = new MultimonDecoder(config("multimon-ng", {}), logger)
		d.updateOptions({
			charset: "SECRET-option-text",
			"SECRET-key-text": "SECRET-value-text",
			fmGain: "SECRET-invalid-gain",
		})
		expect(JSON.stringify(logs)).not.toContain("SECRET-")
		expect(logs).toContainEqual(
			expect.objectContaining({
				updateCount: 3,
				msg: "Decoder options updated",
			}),
		)
	})

	it("start logs the argument count, not argv", async () => {
		const { logs, logger } = capture()
		const d = new Rtl433Decoder(
			config("rtl433", { extraArgs: ["SECRET-arg"] }),
			logger,
		) as unknown as {
			getCommand(): string
			getArgs(): string[]
			start(): Promise<void>
			stop(): Promise<void>
		}
		// Spawn a harmless command so no decoder or DSP stage runs.
		d.getCommand = () => "/usr/bin/true"
		d.getArgs = () => ["SECRET-argv"]
		await d.start().catch(() => undefined)
		await d.stop().catch(() => undefined)
		const started = logs.find(l => l["msg"] === "Starting decoder process")
		expect(started).toMatchObject({ command: "/usr/bin/true", argCount: 1 })
		expect(JSON.stringify(logs)).not.toContain("SECRET-")
	})

	it("a completed recorded call logs hasWavFile, not the recording path", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "wg7-hwfix-"))
		const dir = fs.mkdtempSync(path.join(root, "SECRET-recordings-"))
		try {
			const start = new Date(2026, 0, 9, 10, 53, 27)
			fs.writeFileSync(
				path.join(
					dir,
					"20260109_105327_123_DMR_CC_1_GROUP_TGT_100_SRC_200.wav",
				),
				"",
			)
			const { logs, logger } = capture()
			const d = new DsdFmeDecoder(
				config("dsd-fme", {
					enablePerCallRecording: true,
					perCallRecordingDir: dir,
				}),
				logger,
			) as unknown as {
				callState: unknown
				endCall(
					now: Date,
					timeout: boolean,
				): { data: { wavFile?: string } } | null
			}
			d.callState = {
				callId: "c",
				protocol: "dmr",
				talkgroup: 100,
				source: 200,
				startTime: start,
				lastUpdate: start,
				dmr: { cc: 1 },
				quality: { crcErrs: 0, fecErrs: 0 },
				flags: {},
			}
			const ended = d.endCall(new Date(start.getTime() + 5000), false)
			expect(ended?.data.wavFile).toContain(dir)
			expect(JSON.stringify(logs)).not.toContain("SECRET-recordings")
			expect(logs).toContainEqual(
				expect.objectContaining({ msg: "Call ended", hasWavFile: true }),
			)
		} finally {
			fs.rmSync(root, { recursive: true })
		}
	})
})

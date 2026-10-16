// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.3, 9.5
//
// WG7 HW R2 fixes: the extraArgs budget bounds the SERIALIZED (shell-quoted) form,
// error logs carry allowlisted fields only (no argv, paths or hosts), and option
// issue logs name known schema keys only.
import { describe, expect, it } from "vitest"
import pino from "pino"
import fc from "fast-check"
import { spawnSync } from "node:child_process"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import {
	EXTRA_ARGS_BOUNDS,
	readExtraArgsOption,
} from "../../../src/decoders/option-values.js"
import { shellArg } from "../../../src/decoders/process-tools.js"
import { safeErrorFields } from "../../../src/decoders/safe-error-fields.js"
import { DecoderSpawnError, WaveKitError } from "../../../src/utils/errors.js"
import { Rtl433Decoder } from "../../../src/decoders/builtin/rtl433.js"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import { AcarsdecDecoder } from "../../../src/decoders/builtin/acarsdec.js"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import { AisCatcherDecoder } from "../../../src/decoders/builtin/ais-catcher.js"
import { ReadsbDecoder } from "../../../src/decoders/builtin/readsb.js"
import { DirewolfDecoder } from "../../../src/decoders/builtin/direwolf.js"
import {
	NetworkProducerDecoder,
	type NetworkProducerConfig,
} from "../../../src/decoders/network-producer-decoder.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { DecoderCaps } from "../../../src/decoders/types.js"

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

const silent = pino({ level: "silent" })

const ADAPTERS: [string, Ctor][] = [
	["rtl433", Rtl433Decoder],
	["dsd-fme", DsdFmeDecoder],
	["acarsdec", AcarsdecDecoder],
	["dumpvdl2", Dumpvdl2Decoder],
	["ais-catcher", AisCatcherDecoder],
	["readsb", ReadsbDecoder],
	["direwolf", DirewolfDecoder],
]

const LIMIT = EXTRA_ARGS_BOUNDS.maxTotalBytes
/** Linux MAX_ARG_STRLEN: one argv string (the `sh -c` pipeline) must stay below. */
const MAX_ARG_STRLEN = 131072

function finalArgv(Decoder: Ctor, type: string, extraArgs?: unknown): string[] {
	const d = new Decoder(
		config(type, extraArgs === undefined ? {} : { extraArgs }),
		silent,
	) as { getArgs(): string[] }
	return d.getArgs()
}

function bytes(argv: string[]): number {
	return argv.reduce((n, a) => n + Buffer.byteLength(a, "utf8") + 1, 0)
}

/** Quote-heavy worst cases: every `'` expands to `'\''` inside the quoted form. */
const WORST_CASES: [string, string[]][] = [
	["16 × 4096 quotes (R1 repro)", Array(16).fill("'".repeat(4096))],
	[
		"64 × 1023 quotes (largest that fits per entry)",
		Array(64).fill("'".repeat(1023)),
	],
	["64 × 4094 mixed", Array(64).fill("a'".repeat(2047))],
	["64 × 2048 two-byte chars", Array(64).fill("é".repeat(2048))],
	["64 × 4096 plain", Array(64).fill("x".repeat(4096))],
]

describe("extraArgs: the serialized form is bounded (R2 MAJOR 1)", () => {
	it("R1 repro: 16 × 4096 quotes no longer yields a 262 KB pipeline", () => {
		const extra = Array(16).fill("'".repeat(4096))
		const pipeline = finalArgv(Rtl433Decoder, "rtl433", extra)[1]!
		expect(Buffer.byteLength(pipeline)).toBeLessThan(MAX_ARG_STRLEN)
	})

	describe.each(ADAPTERS)("%s", (type, Decoder) => {
		const base = finalArgv(Decoder, type)

		it.each(WORST_CASES)(
			"%s: extraArgs add at most 65536 B to the final command",
			(_name, extra) => {
				const argv = finalArgv(Decoder, type, extra)
				// Serialized contribution: the shell string for sh -c pipelines,
				// the whole argv otherwise (both counted against the no-extraArgs build).
				expect(bytes(argv) - bytes(base)).toBeLessThanOrEqual(LIMIT)
				for (const a of argv)
					expect(Buffer.byteLength(a)).toBeLessThan(MAX_ARG_STRLEN)
				if (argv[0] === "-c") {
					const result = spawnSync("/bin/sh", ["-n", "-c", argv[1]!])
					expect(result.error?.message).toBeUndefined()
					expect(result.status).toBe(0)
				}
			},
		)
	})

	it("property: kept entries fit 65536 B quoted and raw, separators included", () => {
		const quoteHeavy = fc.string({
			unit: fc.constantFrom("'", "a", "é", " ", "$", "😀"),
			maxLength: 4200,
		})
		fc.assert(
			fc.property(fc.array(quoteHeavy, { maxLength: 70 }), value => {
				const out = readExtraArgsOption(value, () => undefined) ?? []
				let quoted = 0
				let raw = 0
				for (const entry of out) {
					const q = Buffer.byteLength(shellArg(entry), "utf8")
					expect(q).toBeLessThanOrEqual(EXTRA_ARGS_BOUNDS.maxEntryBytes)
					quoted += q + 1
					raw += Buffer.byteLength(entry, "utf8") + 1
				}
				expect(quoted).toBeLessThanOrEqual(LIMIT)
				expect(raw).toBeLessThanOrEqual(quoted)
			}),
			{ numRuns: 100 },
		)
	})
})

describe("safeErrorFields (R2 MAJOR 2)", () => {
	it("keeps code, errno, syscall and class; drops message, stack, path, spawnargs", () => {
		const err = Object.assign(new Error("spawn readsb ENOENT SECRET-a"), {
			errno: -2,
			code: "ENOENT",
			syscall: "spawn readsb",
			path: "SECRET-path",
			spawnargs: ["--net-connector", "SECRET-host,1234"],
		})
		expect(safeErrorFields(err)).toEqual({
			type: "Error",
			code: "ENOENT",
			errno: -2,
			syscall: "spawn",
		})
	})

	it("drops DNS hostname and address", () => {
		const err = Object.assign(new Error("getaddrinfo ENOTFOUND SECRET-host"), {
			errno: -3008,
			code: "ENOTFOUND",
			syscall: "getaddrinfo",
			hostname: "SECRET-host",
			address: "SECRET-addr",
			port: 1234,
		})
		const fields = safeErrorFields(err)
		expect(JSON.stringify(fields)).not.toContain("SECRET")
		expect(fields).toEqual({
			type: "Error",
			code: "ENOTFOUND",
			errno: -3008,
			syscall: "getaddrinfo",
		})
	})

	it("rejects codes, errno and syscalls outside the allowlist", () => {
		const err = Object.assign(new TypeError("x"), {
			code: "SECRET lower-case text",
			errno: Number.NaN,
			syscall: "SECRET",
		})
		expect(safeErrorFields(err)).toEqual({ type: "TypeError" })
		expect(safeErrorFields({ code: "A".repeat(33) })).toEqual({
			type: "Object",
		})
	})

	it("WaveKitError keeps its code, never the message", () => {
		const err = new DecoderSpawnError("d", "SECRET-command --arg")
		const fields = safeErrorFields(err)
		expect(fields).toEqual({
			type: "DecoderSpawnError",
			code: "DECODER_SPAWN_ERROR",
		})
		expect(
			safeErrorFields(new WaveKitError("SECRET", "PROBE_NOT_WIRED")).code,
		).toBe("PROBE_NOT_WIRED")
	})

	it("does not run getters and handles non-objects", () => {
		let ran = false
		const hostile = {
			get code() {
				ran = true
				return "ENOENT"
			},
		}
		expect(safeErrorFields(hostile)).toEqual({ type: "Object" })
		expect(ran).toBe(false)
		expect(safeErrorFields("SECRET string")).toEqual({ type: "string" })
		expect(safeErrorFields(undefined)).toEqual({ type: "undefined" })
		expect(safeErrorFields(null)).toEqual({ type: "object" })
	})
})

class TestNetwork extends NetworkProducerDecoder {
	getCommand(): string {
		return "/usr/bin/true"
	}
	getArgs(): string[] {
		return []
	}
	parseNetworkData(): [] {
		return []
	}
	getCaps(): DecoderCaps {
		return {
			input: "external",
			output: "jsonl",
			integrationPattern: "network_producer",
		}
	}
}

describe("decoder error logs carry no argv or hosts (R2 MAJOR 2 repros)", () => {
	it("an ENOENT spawn error logs no spawnargs or path", async () => {
		const { logs, logger } = capture()
		const d = new ReadsbDecoder(
			config("readsb", {
				rtlTcpHost: "SECRET-rtltcp-host.invalid",
				extraArgs: ["SECRET-argv"],
			}),
			logger,
		) as unknown as {
			getCommand(): string
			start(): Promise<void>
			stop(): Promise<void>
		}
		// The command is code-defined (a binary name); argv and hosts are the secrets.
		d.getCommand = () => "/nonexistent/wavekit-missing-bin"
		await d.start().catch(() => undefined)
		await d.stop().catch(() => undefined)
		const line = logs.find(l => l["msg"] === "Decoder process error")
		expect(line).toBeDefined()
		expect(line?.["err"]).toMatchObject({ code: "ENOENT", syscall: "spawn" })
		expect(JSON.stringify(logs)).not.toContain("SECRET")
	})

	it("a TCP DNS failure logs no hostname, message or stack", async () => {
		const { logs, logger } = capture()
		const d = new TestNetwork(
			{
				...config("review", {}),
				outputHost: "SECRET-host.invalid",
				outputPort: 9,
				outputProtocol: "tcp",
			} as unknown as NetworkProducerConfig,
			logger,
		) as unknown as {
			connectToOutput(): Promise<void>
			stop(): Promise<void>
		}
		await d.connectToOutput().catch(() => undefined)
		await d.stop().catch(() => undefined)
		const line = logs.find(l => l["msg"] === "TCP connection error")
		expect(line).toBeDefined()
		expect(line?.["err"]).not.toHaveProperty("message")
		expect(line?.["err"]).not.toHaveProperty("stack")
		expect(JSON.stringify(logs)).not.toContain("SECRET")
	})
})

describe("option issue logs name known keys only (R2 MINOR 3)", () => {
	it("counts unknown keys, names known schema keys, never values", async () => {
		const { logs, logger } = capture()
		const manager = new DecoderManager(
			new DecoderRegistry(),
			new FanoutManager(logger),
			logger,
		)
		const check = (
			manager as unknown as {
				checkDecoderOptions(c: DecoderConfig): unknown
			}
		).checkDecoderOptions.bind(manager)
		check(
			config("rtl433", {
				"/SECRET/path?token=VALUE": 1,
				"SECRET-other": 2,
				targetSampleRate: "SECRET-value",
			}),
		)
		const line = logs.find(
			l => l["msg"] === "Decoder options have issues (reported only)",
		)
		expect(line).toMatchObject({
			issueCount: 3,
			paths: ["targetSampleRate"],
			unknownKeyCount: 2,
		})
		expect(JSON.stringify(logs)).not.toContain("SECRET")
		await manager.destroy()
	})
})

describe("safeErrorFields never throws and never trusts forged names (R3)", () => {
	it("survives a throwing constructor getter, revoked proxies and descriptor traps", () => {
		const getterBomb = {}
		Object.defineProperty(getterBomb, "constructor", {
			get() {
				throw new Error("SECRET-getter")
			},
		})
		expect(safeErrorFields(getterBomb)).toEqual({ type: "Object" })
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(safeErrorFields(proxy)).toEqual({ type: "unknown" })
		const trap = new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					throw new Error("SECRET-trap")
				},
			},
		)
		expect(safeErrorFields(trap)).toEqual({ type: "unknown" })
		const protoTrap = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("SECRET-proto")
				},
			},
		)
		expect(safeErrorFields(protoTrap)).toEqual({ type: "unknown" })
	})

	it("ignores forged constructor names and getter codes", () => {
		const forged: unknown = JSON.parse(
			'{"constructor":{"name":"SecretHostToken123"},"code":"ENOENT"}',
		)
		expect(safeErrorFields(forged)).toEqual({ type: "Object", code: "ENOENT" })
		class SecretHostToken123 extends Error {}
		expect(safeErrorFields(new SecretHostToken123("x"))).toEqual({
			type: "Error",
		})
		const err = new WaveKitError("fixed", "DECODER_X")
		expect(safeErrorFields(err)).toEqual({
			type: "WaveKitError",
			code: "DECODER_X",
		})
		const getterCode = new Error("SECRET")
		Object.defineProperty(getterCode, "code", {
			get() {
				throw new Error("SECRET-code")
			},
		})
		expect(safeErrorFields(getterCode)).toEqual({ type: "Error" })
	})
})

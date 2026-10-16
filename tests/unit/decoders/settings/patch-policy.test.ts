import { describe, expect, it } from "vitest"
import { DECODER_SETTINGS_PATCHABLE_TYPES } from "@wavekit/api-types"
import {
	DECODER_OPTION_SCHEMAS,
	decoderOptionDescriptors,
} from "../../../../src/decoders/options/index.js"
import { DecoderSettingsError } from "../../../../src/decoders/settings/contract.js"
import {
	isPatchableOption,
	sanitizeStoredOptions,
	validateDecoderPatch,
} from "../../../../src/decoders/settings/patch-policy.js"

const NEVER_PATCHABLE_KEY =
	/(path|file|dir|host|addr|port|device|serial|url|callsign|^lat$|^lon$|^output|^udp|record|prune|debug|inputIqFormat|extraArgs|voiceSlot)/i

/** Never patchable by meaning, beyond the key regex (requirement 2.3 and the brief). */
const NEVER_KEYS = new Set([
	"enableMlat",
	"inputSampleRate",
	"targetSampleRate",
	"inputCenterFreq",
	"followCenter",
	"sampleRate",
	"channelHz",
	"offsetHz",
	"oversampling",
	"channelKey",
	"charset",
	"filters",
])
/** Keys digital-voice preparation reads or rewrites (src/core/digital-voice.ts). */
const DIGITAL_VOICE_KEYS = ["output", "udpHost", "udpPort", "mode", "voiceSlot"]

const SENTINELS = ["/etc/passwd", "evil.host", "zz_secret_key_zz"]

function capture(fn: () => unknown): DecoderSettingsError {
	try {
		fn()
	} catch (err) {
		if (err instanceof DecoderSettingsError) return err
		throw err
	}
	throw new Error("expected a DecoderSettingsError")
}

function expectClean(err: DecoderSettingsError): void {
	const text = JSON.stringify(err.toBody()) + err.message
	for (const s of SENTINELS) expect(text).not.toContain(s)
}

const DSD = { frequency: 851_000_000 }

describe("allowlist by meaning", () => {
	for (const type of Object.keys(DECODER_OPTION_SCHEMAS)) {
		it(`${type}: every never-patchable meaning is false`, () => {
			for (const d of decoderOptionDescriptors(type) ?? []) {
				const never =
					NEVER_PATCHABLE_KEY.test(d.key) ||
					NEVER_KEYS.has(d.key) ||
					d.secret ||
					d.type === "string" ||
					d.type === "object" ||
					(type === "dsd-fme" && DIGITAL_VOICE_KEYS.includes(d.key)) ||
					(d.type === "string-list" && !d.enumValues?.length) ||
					!(DECODER_SETTINGS_PATCHABLE_TYPES as readonly string[]).includes(
						d.type,
					)
				if (never) {
					expect(d.patchable === true, `${type}.${d.key}`).toBe(false)
					expect(isPatchableOption(type, d.key)).toBe(false)
				}
				expect(isPatchableOption(type, d.key)).toBe(
					d.patchable === true && !never,
				)
			}
		})
	}

	it("is false for unknown types, unknown keys and non-patchable types", () => {
		expect(isPatchableOption("nope", "frequency")).toBe(false)
		expect(isPatchableOption("dsd-fme", "zz_secret_key_zz")).toBe(false)
		expect(isPatchableOption("dsd-fme", "__proto__")).toBe(false)
		expect(isPatchableOption("dsd-fme", "constructor")).toBe(false)
		expect(isPatchableOption("__proto__", "frequency")).toBe(false)
		expect(isPatchableOption("readsb", "gain")).toBe(false) // string
		expect(isPatchableOption("dumpvdl2", "gain")).toBe(false) // string
		expect(isPatchableOption("multimon-ng", "filters")).toBe(false) // object
		expect(isPatchableOption("lora-meshtastic", "channelKey")).toBe(false)
		expect(isPatchableOption("dsd-fme", "mode")).toBe(false)
		expect(isPatchableOption("readsb", "enableMlat")).toBe(false)
		expect(isPatchableOption("dsd-fme", "frequency")).toBe(true)
		expect(isPatchableOption("multimon-ng", "modes")).toBe(true)
	})
})

describe("validateDecoderPatch shape", () => {
	const bad: unknown[] = [
		null,
		undefined,
		[],
		[{ enabled: true }],
		"x",
		3,
		true,
		{},
		new Map(),
		Object.create({ enabled: true }) as object,
		{ enabled: "yes" },
		{ enabled: 1 },
		{ options: [] },
		{ options: null },
		{ options: "x" },
		{ enabled: true, extra: 1 },
		{ zz_secret_key_zz: "/etc/passwd" },
	]
	it.each(bad.map((b, i) => [i, b]))("refuses body %i", (_i, body) => {
		const err = capture(() => validateDecoderPatch("dsd-fme", DSD, body))
		expect(err.code).toBe("DECODER_OPTIONS_INVALID")
		expect(err.statusCode).toBe(400)
		expectClean(err)
	})

	it("accepts enabled alone and null enabled", () => {
		expect(validateDecoderPatch("dsd-fme", DSD, { enabled: false })).toEqual({
			enabled: false,
			options: {},
		})
		expect(validateDecoderPatch("dsd-fme", DSD, { enabled: null })).toEqual({
			enabled: null,
			options: {},
		})
	})

	it("refuses 65 option keys and checks 64 for patchability", () => {
		const of = (n: number) =>
			Object.fromEntries(
				Array.from({ length: n }, (_, i) => [`k${String(i)}`, 1]),
			)
		expect(
			capture(() => validateDecoderPatch("dsd-fme", DSD, { options: of(65) }))
				.code,
		).toBe("DECODER_OPTIONS_INVALID")
		const err = capture(() =>
			validateDecoderPatch("dsd-fme", DSD, { options: of(64) }),
		)
		expect(err.code).toBe("DECODER_OPTION_NOT_PATCHABLE")
		expect(err.unknownKeys).toBe(64)
	})
})

describe("validateDecoderPatch keys", () => {
	it("counts unknown and prototype keys, lists documented non-patchable", () => {
		const options = JSON.parse(
			'{"zz_secret_key_zz":"evil.host","__proto__":1,"constructor":2,"prototype":3,"wavDir":"/etc/passwd","mode":"dmr","frequency":1}',
		) as unknown
		const err = capture(() => validateDecoderPatch("dsd-fme", DSD, { options }))
		expect(err.code).toBe("DECODER_OPTION_NOT_PATCHABLE")
		expect(err.keys).toEqual(["wavDir", "mode"])
		expect(err.unknownKeys).toBe(4)
		expectClean(err)
	})

	it("refuses every key of a type without schema", () => {
		const err = capture(() =>
			validateDecoderPatch("nope", {}, { options: { frequency: 1 } }),
		)
		expect(err.code).toBe("DECODER_OPTION_NOT_PATCHABLE")
		expect(err.unknownKeys).toBe(1)
	})
})

describe("validateDecoderPatch values", () => {
	const invalid = (type: string, options: Record<string, unknown>) => {
		const err = capture(() => validateDecoderPatch(type, {}, { options }))
		expect(err.code).toBe("DECODER_OPTIONS_INVALID")
		expectClean(err)
		return err
	}

	it("refuses wrong types and out-of-range numbers with fixed text", () => {
		const err = invalid("multimon-ng", { verbosity: 11 })
		expect(err.issues).toEqual([
			{
				path: "verbosity",
				code: "invalid-value",
				message: "must be an integer from 0 to 10",
			},
		])
		invalid("multimon-ng", { verbosity: "2" }) // text for a number key
		invalid("multimon-ng", { verbosity: 1.5 })
		invalid("rtl433", { analyze: "true" })
		invalid("dsd-fme", { frequency: Number.NaN })
		invalid("dsd-fme", { frequency: { nested: "/etc/passwd" } })
		invalid("dsd-fme", { frequencies: [{ host: "evil.host" }] })
		invalid("dsd-fme", { frequency: "evil.host" })
	})

	it("checks enum and closed string-list membership", () => {
		const e = invalid("lora-meshtastic", { region: "evil.host" })
		expect(e.issues?.[0]).toEqual({
			path: "region",
			code: "invalid-value",
			message: "must be one of the documented values",
		})
		const l = invalid("multimon-ng", { modes: ["POCSAG1200", "/etc/passwd"] })
		expect(l.issues?.[0]?.path).toBe("modes.1")
		invalid("multimon-ng", { modes: "POCSAG1200" })
		const ok = validateDecoderPatch(
			"multimon-ng",
			{},
			{ options: { modes: ["POCSAG1200"], verbosity: 2 } },
		)
		expect(ok.options).toEqual({ modes: ["POCSAG1200"], verbosity: 2 })
	})

	it("reports the list index of a bad number", () => {
		const err = invalid("rtl433", { protocols: [1, -4] })
		expect(err.issues?.[0]?.path).toBe("protocols.1")
	})

	it("null reverts without validation", () => {
		expect(
			validateDecoderPatch("dsd-fme", DSD, {
				options: { frequency: null, fmGain: null },
			}),
		).toEqual({ options: { frequency: null, fmGain: null } })
	})

	it("invalid untouched configured keys do not fail a valid patch", () => {
		const configured = {
			wavDir: 42,
			zz_secret_key_zz: "evil.host",
			fmGain: -999,
			frequency: "bad",
		}
		expect(
			validateDecoderPatch("dsd-fme", configured, {
				options: { callTimeoutMs: 2000 },
			}),
		).toEqual({ options: { callTimeoutMs: 2000 } })
		// LoRa requires keys the patch does not touch.
		expect(
			validateDecoderPatch(
				"lora-meshtastic",
				{},
				{
					options: { spreadingFactor: 9 },
				},
			).options,
		).toEqual({ spreadingFactor: 9 })
	})

	it("never names unknown keys or values in the message", () => {
		const err = capture(() =>
			validateDecoderPatch(
				"readsb",
				{},
				{
					options: { zz_secret_key_zz: "/etc/passwd", rtlTcpHost: "evil.host" },
				},
			),
		)
		expect(err.keys).toEqual(["rtlTcpHost"])
		expectClean(err)
	})
})

describe("sanitizeStoredOptions", () => {
	it("drops non-patchable, unknown and invalid keys", () => {
		const stored = JSON.parse(
			'{"frequency":851000000,"fmGain":-5,"wavDir":"/etc/passwd","zz_secret_key_zz":1,"__proto__":{"x":1},"mode":"dmr","callTimeoutMs":null}',
		) as Record<string, unknown>
		const out = sanitizeStoredOptions("dsd-fme", stored)
		expect(out.options).toEqual({ frequency: 851_000_000 })
		expect(out.dropped).toBe(6)
		expect(Object.getPrototypeOf(out.options)).toBe(Object.prototype)
	})

	it("drops everything for a type without schema", () => {
		expect(sanitizeStoredOptions("nope", { frequency: 1 })).toEqual({
			options: {},
			dropped: 1,
		})
	})
})

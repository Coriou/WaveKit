/**
 * WG6 review fixes: values an adapter handles like a number (numeric text it only
 * stringifies into an argument) or like an absent key (null it defaults with `??`,
 * `||` or a truthiness check) must not be reported as issues.
 */

import { describe, expect, it } from "vitest"
import { validateDecoderOptions } from "../../../../src/decoders/options/index.js"

describe("numeric text the adapter stringifies", () => {
	it.each([
		["readsb", { ppm: "12" }],
		["readsb", { rtlTcpHost: "pi", rtlTcpPort: "1234" }],
		["rtl433", { protocols: ["1", 40] }],
		["multimon-ng", { filters: { highpass: "300", lowpass: "3000.5" } }],
		["multimon-ng", { filters: { gain: "-2" } }],
		["ais-catcher", { gain: "33.8", ppm: "-1" }],
		["direwolf", { agwPort: "8000" }],
		["dumpvdl2", { inputCenterFreq: "136800000" }],
		["dsd-fme", { output: "udp", udpHost: "127.0.0.1", udpPort: "7355" }],
	])("%s accepts %j", (type, options) => {
		expect(validateDecoderOptions(type, options)).toEqual([])
	})

	it.each([
		["readsb", { ppm: "twelve" }],
		["rtl433", { protocols: ["-1"] }],
		["multimon-ng", { filters: { highpass: "300Hz" } }],
		["direwolf", { agwPort: "80.5" }],
	])("%s still rejects non-numeric text %j", (type, options) => {
		expect(validateDecoderOptions(type, options)?.length).toBeGreaterThan(0)
	})

	it.each([
		// Arithmetic or a TCP connect on the value: text stays an issue.
		["readsb", { inputSampleRate: "2400000" }],
		["readsb", { outputPort: "30003" }],
		["direwolf", { kissPort: "8001" }],
		["dumpvdl2", { targetSampleRate: "1050000" }],
	])(
		"%s rejects numeric text where the adapter computes with it %j",
		(type, options) => {
			expect(validateDecoderOptions(type, options)?.length).toBeGreaterThan(0)
		},
	)
})

describe("null the adapter treats as absent", () => {
	it.each([
		["readsb", { outputFormat: null, outputPort: null, lat: null }],
		["rtl433", { outputFormat: null, protocols: null, analyze: null }],
		["dsd-fme", { mode: null, wavDir: null, callTimeoutMs: null }],
		["acarsdec", { extraArgs: null, debugRecordPath: null }],
		["ais-catcher", { outputFormat: null, inputSampleRate: null }],
		["direwolf", { kissPort: null, agwPort: null, channelHz: null }],
		["dumpvdl2", { followCenter: null, outputFormat: null }],
		["multimon-ng", { modes: null, filters: null, fmGain: null }],
	])("%s accepts %j", (type, options) => {
		expect(validateDecoderOptions(type, options)).toEqual([])
	})

	it.each([
		// `!== undefined` then toString()/String(): null would throw or print "null".
		["readsb", { gain: null }],
		["readsb", { ppm: null }],
		["ais-catcher", { gain: null }],
		["multimon-ng", { filters: { highpass: null } }],
		["dumpvdl2", { inputCenterFreq: null }],
		// Invalid and warned about rather than defaulted silently.
		["dsd-fme", { voiceSlot: null }],
		["acarsdec", { offsetHz: null }],
	])("%s still rejects null where it is not absent %j", (type, options) => {
		expect(validateDecoderOptions(type, options)?.length).toBeGreaterThan(0)
	})
})

describe("numeric text still meets the number range", () => {
	it.each([
		["readsb", { rtlTcpHost: "pi", rtlTcpPort: "65536" }, "rtlTcpPort"],
		["readsb", { rtlTcpHost: "pi", rtlTcpPort: "0" }, "rtlTcpPort"],
		["direwolf", { agwPort: "65536" }, "agwPort"],
		[
			"dsd-fme",
			{ output: "udp", udpHost: "127.0.0.1", udpPort: "65536" },
			"udpPort",
		],
		["dumpvdl2", { inputCenterFreq: "0" }, "inputCenterFreq"],
		["rtl433", { protocols: ["1", "1.5"] }, "protocols.1"],
	])("%s rejects out-of-range text %j", (type, options, path) => {
		const issues = validateDecoderOptions(type, options) ?? []
		expect(issues.map(i => i.path)).toEqual([path])
		expect(issues[0]?.code).toBe("invalid-value")
	})

	it.each([
		["readsb", { rtlTcpHost: "pi", rtlTcpPort: "65535" }],
		["direwolf", { agwPort: "1" }],
		["dsd-fme", { output: "udp", udpHost: "127.0.0.1", udpPort: "65535" }],
	])("%s accepts text at the bound %j", (type, options) => {
		expect(validateDecoderOptions(type, options)).toEqual([])
	})
})

describe("null frequencies are not absent", () => {
	// resolveDecoderTargetFrequencies skips only undefined: a null `frequencies`
	// stops resolution before `frequency`, so null is a real problem here.
	it.each([
		"rtl433",
		"acarsdec",
		"dumpvdl2",
		"readsb",
		"dsd-fme",
		"multimon-ng",
		"ais-catcher",
		"direwolf",
	])("%s reports null frequencies and frequency", type => {
		const issues =
			validateDecoderOptions(type, { frequencies: null, frequency: null }) ?? []
		expect(issues.map(i => i.path)).toEqual(["frequencies", "frequency"])
	})
})

describe("round 3 review fixes", () => {
	it("accepts integer text for multimon-ng verbosity, which the adapter compares", () => {
		expect(validateDecoderOptions("multimon-ng", { verbosity: "2" })).toEqual(
			[],
		)
		expect(
			validateDecoderOptions("multimon-ng", { verbosity: "1.5" })?.map(
				i => i.path,
			),
		).toEqual(["verbosity"])
	})

	it("reports multimon-ng verbosity above 10, as a number or as text (report only)", () => {
		expect(validateDecoderOptions("multimon-ng", { verbosity: 10 })).toEqual([])
		expect(validateDecoderOptions("multimon-ng", { verbosity: "10" })).toEqual(
			[],
		)
		for (const verbosity of [11, "11", 1e9, "999999999999"])
			expect(
				validateDecoderOptions("multimon-ng", { verbosity })?.map(i => i.path),
			).toEqual(["verbosity"])
	})

	it("keeps distinct issues whose paths share the first 256 units", () => {
		const options = Object.fromEntries(
			Array.from({ length: 40 }, (_, i) => ["k".repeat(256) + String(i), 0]),
		)
		const issues = validateDecoderOptions("rtl433", options) ?? []
		expect(issues).toHaveLength(32)
		expect(issues[31]).toEqual({
			path: "",
			code: "truncated",
			message: "9 more",
		})
		expect(issues.slice(0, 31).every(i => i.path.length === 256)).toBe(true)
	})
})

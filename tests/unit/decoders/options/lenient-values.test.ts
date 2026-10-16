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
		["multimon-ng", { verbosity: "2" }],
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
		["acarsdec", { frequencies: null, extraArgs: null, debugRecordPath: null }],
		["ais-catcher", { outputFormat: null, inputSampleRate: null }],
		["direwolf", { kissPort: null, agwPort: null, channelHz: null }],
		["dumpvdl2", { followCenter: null, outputFormat: null, frequency: null }],
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

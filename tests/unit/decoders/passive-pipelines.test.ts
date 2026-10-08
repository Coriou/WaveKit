import { describe, expect, it } from "vitest"
import pino from "pino"
import { ReadsbDecoder } from "../../../src/decoders/builtin/readsb.js"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"
import { LoraMeshtasticDecoder } from "../../../src/decoders/builtin/lora-meshtastic.js"

const logger = pino({ level: "silent" })
function pipeline(decoder: unknown): string {
	return (decoder as { getArgs(): string[] }).getArgs().join(" ")
}
describe("passive shared IQ pipelines", () => {
	it("adapts readsb to 2.4 Msps without requiring source ownership", () => {
		const decoder = new ReadsbDecoder(
			{
				id: "adsb",
				type: "readsb",
				enabled: true,
				options: { inputSampleRate: 2048000, outputFormat: "sbs" },
			},
			logger,
		)
		expect(decoder.caps.wantsExclusiveSource).toBe(false)
		expect(pipeline(decoder)).toContain("-r 2048000")
		expect(pipeline(decoder)).toContain("rate -h 2400000 | readsb")
		decoder.updateOptions({ inputSampleRate: 2400000 })
		expect(pipeline(decoder)).not.toContain("sox")
	})
	it("updates VDL2 center frequency and supplies exact 105 kHz multiples", () => {
		const decoder = new Dumpvdl2Decoder(
			{
				id: "vdl",
				type: "dumpvdl2",
				enabled: true,
				options: {
					frequencies: [136975000],
					followCenter: true,
					inputSampleRate: 2048000,
				},
			},
			logger,
		)
		decoder.updateOptions({
			inputSampleRate: 1024000,
			inputCenterFreq: 137000000,
		})
		expect(pipeline(decoder)).toContain("-r 1024000")
		expect(pipeline(decoder)).toContain("rate -h 1050000")
		expect(pipeline(decoder)).toContain(
			"--oversample 10 --centerfreq 137000000",
		)
		expect(pipeline(decoder)).toMatch(/137000000$/)
	})
	it("updates LoRa tuning metadata while retaining its exact modem rate", () => {
		const decoder = new LoraMeshtasticDecoder(
			{
				id: "lora",
				type: "lora-meshtastic",
				enabled: true,
				options: {
					region: "EU_868",
					preset: "LongFast",
					frequency: 869525000,
					channelKey: "AQ==",
					followCenter: true,
					inputSampleRate: 2048000,
				},
			},
			logger,
		)
		decoder.updateOptions({
			inputSampleRate: 1024000,
			inputCenterFreq: 869525000,
		})
		expect(pipeline(decoder)).toContain("-r 1024000")
		expect(pipeline(decoder)).toContain("--samp-rate 2000000")
		expect(pipeline(decoder)).toContain("--frequency 869525000")
	})
})

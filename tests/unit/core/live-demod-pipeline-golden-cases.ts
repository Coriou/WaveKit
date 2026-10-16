/**
 * The 128 golden live-demod pipeline cases: 8 modulations x deEmphasis x
 * lowPass x highPass x audio format. Shared by the golden test and any
 * property test that wants the same grid.
 */

import {
	LiveDemodConfigSchema,
	type LiveDemodConfig,
} from "../../../src/config.js"
import {
	liveDemodRates,
	planLiveDemodPipeline,
	type LiveDemodPipelinePlan,
} from "../../../src/core/live-demod-pipeline.js"
import { DISABLED_CSDR_BUFFER_POLICY } from "../../../src/decoders/csdr-buffers.js"

export const GOLDEN_IQ_SAMPLE_RATE = 2_048_000

export const GOLDEN_MODULATIONS = [
	"nfm",
	"wfm",
	"am",
	"usb",
	"lsb",
	"dsb",
	"cw",
	"raw",
] as const

export interface GoldenCase {
	key: string
	config: LiveDemodConfig
}

export function goldenCases(): GoldenCase[] {
	const cases: GoldenCase[] = []
	for (const modulation of GOLDEN_MODULATIONS) {
		for (const deEmphasis of [false, true]) {
			for (const lowPass of [0, 3000]) {
				for (const highPass of [0, 300]) {
					for (const audioFormat of ["s16le", "f32le"] as const) {
						const key = `${modulation}|de=${deEmphasis ? 1 : 0}|lp=${lowPass}|hp=${highPass}|${audioFormat}`
						const config = LiveDemodConfigSchema.parse({
							modulation,
							deEmphasis,
							lowPass,
							highPass,
							audioFormat,
						})
						cases.push({ key, config })
					}
				}
			}
		}
	}
	return cases
}

export function planGoldenCase(config: LiveDemodConfig): LiveDemodPipelinePlan {
	const rates = liveDemodRates(GOLDEN_IQ_SAMPLE_RATE, config)
	return planLiveDemodPipeline({
		config,
		iqSampleRate: GOLDEN_IQ_SAMPLE_RATE,
		iqFormat: "U8_IQ",
		decimation: rates.decimation,
		logger: { info: () => undefined },
		bufferPolicy: DISABLED_CSDR_BUFFER_POLICY,
	})
}

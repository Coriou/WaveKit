import { describe, expect, it, vi } from "vitest"
import type { DecoderOptionDescriptor } from "@wavekit/api-types"
import type * as OptionsModule from "../../../../src/decoders/options/index.js"

// Every descriptor is forced to claim it is patchable (with a patchable type), so only the
// exact-key denylist can still refuse the keys below.
vi.mock("../../../../src/decoders/options/index.js", async importOriginal => {
	const actual = await importOriginal<typeof OptionsModule>()
	return {
		...actual,
		decoderOptionDescriptors: (type: string) =>
			actual.decoderOptionDescriptors(type)?.map(
				(d): DecoderOptionDescriptor => ({
					...d,
					patchable: true,
					secret: false,
					type: "number",
				}),
			),
	}
})

const { DECODER_OPTION_SCHEMAS } =
	await import("../../../../src/decoders/options/index.js")
const { isPatchableOption } =
	await import("../../../../src/decoders/settings/patch-policy.js")

const DENIED = [
	"enableMlat",
	"inputSampleRate",
	"targetSampleRate",
	"inputCenterFreq",
	"followCenter",
	"sampleRate",
	"channelHz",
	"offsetHz",
	"oversampling",
	"lat",
	"lon",
	"output",
	"udpHost",
	"udpPort",
	"voiceSlot",
	"outputFormat",
	"charset",
	"filters",
	"channelKey",
	"extraArgs",
]

describe("exact-key denylist backstop", () => {
	it("the forced descriptors make an ordinary key patchable (mock is live)", () => {
		expect(isPatchableOption("rtl433", "analyze")).toBe(true)
	})

	it.each(DENIED)(
		"refuses %s for every type even when flagged patchable",
		key => {
			for (const type of Object.keys(DECODER_OPTION_SCHEMAS))
				expect(isPatchableOption(type, key)).toBe(false)
		},
	)

	it("refuses dsd-fme mode, keeps multimon-ng modes", () => {
		expect(isPatchableOption("dsd-fme", "mode")).toBe(false)
		expect(isPatchableOption("multimon-ng", "modes")).toBe(true)
	})
})

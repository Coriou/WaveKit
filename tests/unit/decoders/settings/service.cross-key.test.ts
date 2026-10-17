import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ZodTypeAny } from "zod"
import type * as OptionsModule from "../../../../src/decoders/options/index.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"
import { makeTmp, removeTmp, stubLogger } from "../../core/station/helpers.js"

// A path-less cross-key rule on rtl433: analyze needs a frequency of at least 400 MHz.
vi.mock("../../../../src/decoders/options/index.js", async importOriginal => {
	const actual = await importOriginal<typeof OptionsModule>()
	const base = actual.DECODER_OPTION_SCHEMAS["rtl433"] as ZodTypeAny
	return {
		...actual,
		DECODER_OPTION_SCHEMAS: {
			...actual.DECODER_OPTION_SCHEMAS,
			rtl433: base.refine(
				(o: unknown) => {
					const r = o as { analyze?: unknown; frequency?: unknown }
					return !(
						r.analyze === true &&
						typeof r.frequency === "number" &&
						r.frequency < 400_000_000
					)
				},
				{ message: "analyze needs 400 MHz or more" },
			),
		},
	}
})

const { DecoderSettingsError } =
	await import("../../../../src/decoders/settings/contract.js")
const { openDecoderSettingsService } =
	await import("../../../../src/decoders/settings/service.js")

const ISM: DecoderConfig = {
	id: "ism",
	type: "rtl433",
	enabled: true,
	options: { frequency: 433_920_000 },
}

let stateDir: string
beforeEach(async () => {
	stateDir = await makeTmp()
})
afterEach(async () => {
	await removeTmp(stateDir)
})

describe("decoder settings service cross-key validation", () => {
	it("checks a PATCH against retained overrides, not the configured options alone", async () => {
		const service = await openDecoderSettingsService({
			configs: [ISM],
			stateDir,
			logger: stubLogger().logger,
			manager: {
				getStatus: () => undefined,
				stageDecoderOptions: () => true,
				isRestartPending: () => false,
			},
			now: () => Date.parse("2026-10-16T12:00:00.000Z"),
		})
		const first = await service.update("ism", {
			options: { frequency: 300_000_000 },
		})
		let code: string | undefined
		try {
			await service.update("ism", { options: { analyze: true } })
		} catch (err) {
			if (err instanceof DecoderSettingsError) code = err.code
			else throw err
		}
		expect(code).toBe("DECODER_OPTIONS_INVALID")
		expect(service.revision()).toBe(first.revision)
		await service.close()
	})
})

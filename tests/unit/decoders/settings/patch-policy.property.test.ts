import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { DECODER_SETTINGS_PATCHABLE_TYPES } from "@wavekit/api-types"
import {
	DECODER_OPTION_SCHEMAS,
	decoderOptionDescriptors,
} from "../../../../src/decoders/options/index.js"
import { DecoderSettingsError } from "../../../../src/decoders/settings/contract.js"
import {
	isPatchableOption,
	validateDecoderPatch,
} from "../../../../src/decoders/settings/patch-policy.js"

const TYPES = Object.keys(DECODER_OPTION_SCHEMAS)
const NEVER_PATCHABLE_KEY =
	/(path|file|dir|host|addr|port|device|serial|url|callsign|^lat$|^lon$|^output|^udp|record|prune|debug|inputIqFormat|extraArgs|voiceSlot)/i

describe("patch policy properties", () => {
	// Feature: web-gaps-8, Property 3: Patchable by meaning
	// Validates: Requirements 2.3, 2.4
	it("a key is patchable only when documented, flagged and consistent; others are refused", () => {
		const documented = TYPES.flatMap(t =>
			(decoderOptionDescriptors(t) ?? []).map(d => [t, d.key] as const),
		)
		fc.assert(
			fc.property(
				fc.oneof(
					fc.constantFrom(...documented),
					fc.tuple(fc.constantFrom(...TYPES, "nope"), fc.string()),
				),
				([type, key]) => {
					const d = decoderOptionDescriptors(type)?.find(x => x.key === key)
					const patchable = isPatchableOption(type, key)
					if (patchable) {
						expect(d?.patchable).toBe(true)
						expect(d?.secret).toBe(false)
						expect(key).not.toMatch(NEVER_PATCHABLE_KEY)
						expect(
							(DECODER_SETTINGS_PATCHABLE_TYPES as readonly string[]).includes(
								d?.type ?? "",
							),
						).toBe(true)
						return
					}
					try {
						validateDecoderPatch(type, {}, { options: { [key]: 1 } })
						expect.unreachable("non-patchable key accepted")
					} catch (err) {
						expect(err).toBeInstanceOf(DecoderSettingsError)
						const e = err as DecoderSettingsError
						// "__proto__" via a computed key sets the prototype: no key at all.
						if (key === "__proto__") return
						expect(e.code).toBe("DECODER_OPTION_NOT_PATCHABLE")
						const body = JSON.stringify(e.toBody())
						if (!d) expect(e.keys).toEqual([])
						if (!d && key.length > 3) expect(body).not.toContain(key)
					}
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: web-gaps-8, Property 4: Unrelated issues never fail a patch
	// Validates: Requirements 2.4
	it("garbage in untouched configured keys never fails a valid patch", () => {
		fc.assert(
			fc.property(
				fc.dictionary(
					fc.constantFrom(
						"fmGain",
						"wavDir",
						"mode",
						"udpPort",
						"zz_secret_key_zz",
						// Not "frequencies": a configured one shadows the patched frequency (WG8 R1).
						"offsetHz",
						"extraArgs",
					),
					fc.anything(),
				),
				fc.integer({ min: 1, max: 6_000_000_000 }),
				fc.integer({ min: 0, max: 30_000 }),
				(configured, frequency, delay) => {
					const out = validateDecoderPatch("dsd-fme", configured, {
						options: { frequency, callStartDelayMs: delay },
					})
					expect(out.options).toEqual({ frequency, callStartDelayMs: delay })
				},
			),
			{ numRuns: 200 },
		)
	})
})

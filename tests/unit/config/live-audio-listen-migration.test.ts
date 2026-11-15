/**
 * Listen (2026-11-15) live-audio squelch contract: `open`, `voiceOnly`, `listenMode` and the
 * migration of deprecated `noise` and of `manual` at 0.
 */

import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	LIVE_AUDIO_LISTEN_MODES,
	LIVE_AUDIO_LISTEN_MODE_DEFAULT,
	LIVE_AUDIO_SQUELCH_INPUT_MODES,
	LIVE_AUDIO_SQUELCH_MODES,
	LIVE_AUDIO_SQUELCH_POSITIONS,
	LIVE_AUDIO_VOICE_ONLY_DEFAULT,
} from "@wavekit/api-types"
import {
	ConfigSchema,
	LiveDemodConfigSchema,
	migrateLiveAudioSquelch,
	migrateLiveAudioSquelchUpdate,
} from "../../../src/config.js"
import { evidenceGateApplies } from "../../../src/core/evidence-squelch/contract.js"

describe("Listen contract constants", () => {
	it("adds positions, inputs and listen modes; the WG7 list is unchanged", () => {
		expect(LIVE_AUDIO_SQUELCH_MODES).toEqual(["manual", "auto", "noise"])
		expect(LIVE_AUDIO_SQUELCH_POSITIONS).toEqual(["auto", "manual", "open"])
		expect(LIVE_AUDIO_SQUELCH_INPUT_MODES).toEqual([
			"auto",
			"manual",
			"open",
			"noise",
		])
		expect(LIVE_AUDIO_LISTEN_MODES).toEqual(["auto", "analog", "digital"])
		expect(LIVE_AUDIO_LISTEN_MODE_DEFAULT).toBe("auto")
		expect(LIVE_AUDIO_VOICE_ONLY_DEFAULT).toBe(true)
	})
})

describe("migrateLiveAudioSquelch", () => {
	it("noise becomes auto without the voice check", () => {
		expect(
			migrateLiveAudioSquelch({ squelchMode: "noise", squelch: -40 }),
		).toEqual({ squelchMode: "auto", squelch: -40, voiceOnly: false })
		// An explicit voiceOnly true with noise still means "no voice check".
		expect(
			migrateLiveAudioSquelch({
				squelchMode: "noise",
				squelch: 0,
				voiceOnly: true,
			}),
		).toEqual({ squelchMode: "auto", squelch: 0, voiceOnly: false })
	})

	it("manual at exactly 0 becomes open; just below 0 stays manual", () => {
		expect(
			migrateLiveAudioSquelch({ squelchMode: "manual", squelch: 0 }),
		).toEqual({ squelchMode: "open", squelch: 0 })
		expect(
			migrateLiveAudioSquelch({ squelchMode: "manual", squelch: -0 }),
		).toMatchObject({ squelchMode: "open" })
		const below = { squelchMode: "manual" as const, squelch: -0.001 }
		expect(migrateLiveAudioSquelch(below)).toBe(below)
	})

	it("returns every other config unchanged (same object)", () => {
		for (const config of [
			{ squelch: 0 },
			{ squelchMode: "auto" as const, squelch: 0 },
			{ squelchMode: "open" as const, squelch: -50 },
			{ squelchMode: "auto" as const, squelch: -50, voiceOnly: false },
		])
			expect(migrateLiveAudioSquelch(config)).toBe(config)
	})

	// Feature: listen, Property 2: the migrated squelch is never noise nor manual at 0, and idempotent
	// Validates: design C (API and migration)
	it("property: output is a position, idempotent, other keys kept", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...LIVE_AUDIO_SQUELCH_INPUT_MODES, undefined),
				fc.oneof(fc.constant(0), fc.double({ min: -160, max: 0, noNaN: true })),
				fc.option(fc.boolean(), { nil: undefined }),
				(squelchMode, squelch, voiceOnly) => {
					const input = {
						...(squelchMode !== undefined ? { squelchMode } : {}),
						squelch,
						...(voiceOnly !== undefined ? { voiceOnly } : {}),
						gain: 2,
					}
					const out = migrateLiveAudioSquelch(input)
					expect(out.squelchMode).not.toBe("noise")
					expect(out.squelchMode === "manual" && out.squelch === 0).toBe(false)
					expect(migrateLiveAudioSquelch(out)).toBe(out)
					expect(out.squelch).toBe(squelch)
					expect(out.gain).toBe(2)
					if (squelchMode === "noise") expect(out.voiceOnly).toBe(false)
					else expect(out.voiceOnly).toBe(voiceOnly)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("migrateLiveAudioSquelchUpdate", () => {
	const auto = {
		squelchMode: "auto" as const,
		squelch: 0,
		modulation: "nfm" as const,
	}
	const manual = {
		squelchMode: "manual" as const,
		squelch: -50,
		modulation: "nfm" as const,
	}

	it("PATCH manual while the stored squelch is 0 stores open", () => {
		expect(
			migrateLiveAudioSquelchUpdate(auto, { squelchMode: "manual" }),
		).toEqual({ squelchMode: "open" })
	})

	it("PATCH squelch 0 on a manual config stores open", () => {
		expect(migrateLiveAudioSquelchUpdate(manual, { squelch: 0 })).toEqual({
			squelch: 0,
			squelchMode: "open",
		})
		expect(migrateLiveAudioSquelchUpdate(manual, { squelch: -60 })).toEqual({
			squelch: -60,
		})
	})

	it("PATCH noise on FM stores auto with voiceOnly false", () => {
		const updates = { squelchMode: "noise" as const }
		expect(migrateLiveAudioSquelchUpdate(auto, updates)).toEqual({
			squelchMode: "auto",
			voiceOnly: false,
		})
		expect(
			migrateLiveAudioSquelchUpdate(
				{ ...auto, modulation: "am" },
				{ squelchMode: "noise", modulation: "wfm" },
			),
		).toEqual({ squelchMode: "auto", modulation: "wfm", voiceOnly: false })
	})

	it("PATCH noise on a modulation noise does not support passes through (still refused)", () => {
		const updates = { squelchMode: "noise" as const }
		expect(
			migrateLiveAudioSquelchUpdate({ ...auto, modulation: "am" }, updates),
		).toBe(updates)
		const moved = { squelchMode: "noise" as const, modulation: "usb" as const }
		expect(migrateLiveAudioSquelchUpdate(auto, moved)).toBe(moved)
	})

	it("leaves unrelated updates as they are", () => {
		const updates = { voiceOnly: true, listenMode: "digital" as const }
		expect(migrateLiveAudioSquelchUpdate(auto, updates)).toBe(updates)
		const open = { squelchMode: "open" as const }
		expect(migrateLiveAudioSquelchUpdate(manual, open)).toBe(open)
	})
})

describe("startup config", () => {
	const load = (liveDemod: Record<string, unknown>) =>
		ConfigSchema.parse({ sources: [], decoders: [], liveDemod }).liveDemod

	it("a loaded config stores noise and manual at 0 migrated", () => {
		expect(load({ squelchMode: "noise" })).toMatchObject({
			squelchMode: "auto",
			voiceOnly: false,
		})
		expect(load({ squelchMode: "manual", squelch: 0 })).toMatchObject({
			squelchMode: "open",
		})
		expect(load({ squelchMode: "manual", squelch: -40 })).toMatchObject({
			squelchMode: "manual",
			squelch: -40,
		})
	})

	it("keeps the parsed config as written: no voiceOnly or listenMode defaults", () => {
		const parsed = load({})
		expect(parsed).toBeDefined()
		expect(parsed).not.toHaveProperty("voiceOnly")
		expect(parsed).not.toHaveProperty("listenMode")
		expect(parsed).not.toHaveProperty("squelchMode")
	})

	it("accepts the new keys and refuses malformed values", () => {
		expect(
			load({ squelchMode: "open", voiceOnly: false, listenMode: "digital" }),
		).toMatchObject({
			squelchMode: "open",
			voiceOnly: false,
			listenMode: "digital",
		})
		for (const bad of [
			{ squelchMode: "off" },
			{ voiceOnly: "yes" },
			{ listenMode: "decoded" },
		])
			expect(LiveDemodConfigSchema.safeParse(bad).success).toBe(false)
		// The deprecated input keeps its WG7 rule: noise on AM is refused.
		expect(
			LiveDemodConfigSchema.safeParse({
				squelchMode: "noise",
				modulation: "am",
			}).success,
		).toBe(false)
	})
})

describe("evidenceGateApplies voiceOnly (live audio stage 2)", () => {
	const base = { squelchMode: "auto" as const, modulation: "nfm" as const }

	it("applies with voiceOnly absent or true, not with false", () => {
		expect(evidenceGateApplies(base)).toBe(true)
		expect(evidenceGateApplies({ ...base, voiceOnly: true })).toBe(true)
		expect(evidenceGateApplies({ ...base, voiceOnly: undefined })).toBe(true)
		expect(evidenceGateApplies({ ...base, voiceOnly: false })).toBe(false)
	})

	it("never applies in open, manual or noise, whatever voiceOnly", () => {
		for (const squelchMode of ["open", "manual", "noise"] as const)
			for (const voiceOnly of [true, false, undefined])
				expect(evidenceGateApplies({ ...base, squelchMode, voiceOnly })).toBe(
					false,
				)
	})

	it("keeps the tone and modulation rules", () => {
		expect(
			evidenceGateApplies({
				...base,
				toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 },
			}),
		).toBe(false)
		expect(evidenceGateApplies({ ...base, modulation: "am" })).toBe(false)
	})
})

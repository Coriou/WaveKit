import { describe, expect, it } from "vitest"
import {
	buildDecoderSettingsView,
	effectiveDecoderConfig,
} from "../../../../src/decoders/settings/layers.js"
import type { DecoderOverride } from "../../../../src/decoders/settings/contract.js"
import { isPatchableOption } from "../../../../src/decoders/settings/patch-policy.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"

function rtl433(options: Record<string, unknown> = {}): DecoderConfig {
	return { id: "ism", type: "rtl433", enabled: true, options }
}

function override(
	options: DecoderOverride["options"],
	extra: Partial<DecoderOverride> = {},
): DecoderOverride {
	return {
		type: "rtl433",
		options,
		updatedAt: "2026-10-16T00:00:00.000Z",
		...extra,
	}
}

describe("effectiveDecoderConfig", () => {
	it("returns a copy when there is no override", () => {
		const config = rtl433({ frequency: 433_920_000 })
		const out = effectiveDecoderConfig(config, undefined)
		expect(out).toEqual(config)
		expect(out).not.toBe(config)
		expect(out.options).not.toBe(config.options)
	})

	it("replaces only override keys and enabled when present", () => {
		const config = rtl433({ frequency: 433_920_000, analyze: true })
		const out = effectiveDecoderConfig(
			config,
			override({ frequency: 868_000_000 }, { enabled: false }),
		)
		expect(out.options).toEqual({ frequency: 868_000_000, analyze: true })
		expect(out.enabled).toBe(false)
		expect(config.options["frequency"]).toBe(433_920_000)
		expect(config.enabled).toBe(true)
		expect(effectiveDecoderConfig(config, override({})).enabled).toBe(true)
	})
})

describe("buildDecoderSettingsView", () => {
	it("lists descriptors in order with sources, presence and values", () => {
		const config = rtl433({
			frequency: 433_920_000,
			extraArgs: ["-M", "level"],
			mystery: 1,
			"another-undocumented": "x",
		})
		const view = buildDecoderSettingsView({
			config,
			override: override({ analyze: true }),
			revision: 7,
			pendingRestart: true,
		})
		expect(view.decoderId).toBe("ism")
		expect(view.revision).toBe(7)
		expect(view.pendingRestart).toBe(true)
		expect(view.undocumentedKeys).toBe(2)
		expect(view.enabled).toEqual({ value: true, source: "config" })
		expect(view.overrideIgnored).toBeUndefined()
		expect(view.options.map(o => o.key)).toEqual([
			"analyze",
			"channelHz",
			"extraArgs",
			"frequencies",
			"frequency",
			"inputSampleRate",
			"outputFormat",
			"protocols",
			"targetSampleRate",
		])
		const by = Object.fromEntries(view.options.map(o => [o.key, o]))
		expect(by["analyze"]).toMatchObject({ source: "override", present: true })
		expect(by["frequency"]).toMatchObject({ source: "config", present: true })
		expect(by["protocols"]).toMatchObject({ source: "default", present: false })
		expect(by["extraArgs"]).toMatchObject({ patchable: false, present: true })
		expect(by["extraArgs"]).not.toHaveProperty("value")
		for (const o of view.options) {
			expect(o.patchable).toBe(isPatchableOption("rtl433", o.key))
			if (!o.patchable || o.secret) expect(o).not.toHaveProperty("value")
			else
				expect(o.value).toEqual(o.present ? (by[o.key]?.value ?? null) : null)
		}
		const json = JSON.stringify(view)
		expect(json).not.toContain("mystery")
		expect(json).not.toContain("another-undocumented")
		expect(json).not.toContain("level")
	})

	it("hides secret values", () => {
		const view = buildDecoderSettingsView({
			config: {
				id: "mesh",
				type: "lora-meshtastic",
				enabled: true,
				options: { channelKey: "c2VjcmV0" },
			},
			override: undefined,
			revision: 0,
			pendingRestart: false,
		})
		const key = view.options.find(o => o.key === "channelKey")
		expect(key).toMatchObject({ secret: true, present: true })
		expect(key).not.toHaveProperty("value")
		expect(JSON.stringify(view)).not.toContain("c2VjcmV0")
	})

	it("flags and ignores a retyped override", () => {
		const view = buildDecoderSettingsView({
			config: rtl433({ analyze: false }),
			override: override(
				{ analyze: true },
				{ type: "acarsdec", enabled: false },
			),
			revision: 1,
			pendingRestart: false,
		})
		expect(view.overrideIgnored).toBe("type-changed")
		expect(view.enabled).toEqual({ value: true, source: "config" })
		expect(view.options.find(o => o.key === "analyze")?.source).toBe("config")
	})

	it("reports an enabled override", () => {
		const view = buildDecoderSettingsView({
			config: rtl433(),
			override: override({}, { enabled: false }),
			revision: 1,
			pendingRestart: false,
		})
		expect(view.enabled).toEqual({ value: false, source: "override" })
	})
})

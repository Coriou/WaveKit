import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { ServicesContext } from "../../src/app/context.ts"
import { createServices } from "../../src/app/services.ts"
import type { AppServices } from "../../src/app/services.ts"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"
import {
	bandGainFromDraft,
	bandGainStore,
	draftOf,
} from "../../src/data/receiver-band-gain.ts"
import {
	BAND_GAIN_ROW_ID,
	BandGainRow,
} from "../../src/features/settings/BandGainRow.tsx"
import { receiverSlot } from "../../src/features/receiver/ReceiverIsland.tsx"
import {
	bandGainText,
	overloadHintText,
} from "../../src/features/receiver/gain.ts"
import { haystack, matches } from "../../src/features/settings/model.ts"
import { SETTINGS_REGISTRY } from "../../src/features/settings/registry.ts"
import { bandGainRow } from "../../src/features/settings/BandGainRow.tsx"
import type { IslandContext } from "../../src/shell/ShellIsland.tsx"

let open: { services: AppServices; server: MockServer } | null = null
afterEach(async () => {
	if (!open) return
	open.services.dispose()
	await open.server.close()
	open = null
})

/** App services over the mock core (requests go through Fastify inject, bodies included). */
async function mocked(
	options: { overloadHint?: boolean } = {},
): Promise<{ services: AppServices; server: MockServer }> {
	const server = await buildMockServer({ port: 0, ...options })
	await server.app.ready()
	const services = createServices({
		fetch: async (input, init) => {
			const body = typeof init?.body === "string" ? init.body : undefined
			const res = await server.app.inject({
				method: (init?.method ?? "GET") as "GET" | "POST" | "PUT",
				url: input,
				...(body === undefined
					? {}
					: {
							payload: body,
							headers: { "content-type": "application/json" },
						}),
			})
			return new Response(res.body, { status: res.statusCode })
		},
		createSocket: () => ({
			readyState: 0,
			onopen: null,
			onclose: null,
			onerror: null,
			onmessage: null,
			send: () => undefined,
			close: () => undefined,
		}),
	})
	open = { services, server }
	return open
}

const renderRow = (services: AppServices) =>
	renderToStaticMarkup(
		createElement(
			ServicesContext.Provider,
			{ value: services },
			createElement(BandGainRow, { flash: false }),
		),
	)

const ctx: IslandContext = {
	open: true,
	toggle: () => undefined,
	trigger: {
		"aria-expanded": true,
		"aria-controls": "rx",
		onClick: () => undefined,
		ref: null,
	},
}
const renderIsland = (services: AppServices) =>
	renderToStaticMarkup(
		createElement(
			ServicesContext.Provider,
			{ value: services },
			receiverSlot.panel?.(ctx),
		),
	)

describe("Settings › Per-band gain", () => {
	it("is a Receiver row that search and ⌘K find", () => {
		const row = bandGainRow()
		expect(row).toMatchObject({ id: BAND_GAIN_ROW_ID, group: "receiver" })
		for (const q of ["band gain", "overload", "868"])
			expect(matches(haystack(row, "Receiver"), q), q).toBe(true)
		expect(SETTINGS_REGISTRY.some(e => e.id === BAND_GAIN_ROW_ID)).toBe(true)
	})

	it("shows the core's table with Keep, the switch off and its explanation", async () => {
		const { services } = await mocked()
		expect(renderRow(services)).toContain("Loading…")
		await bandGainStore(services.data.api).load()
		const html = renderRow(services)
		expect(html).toContain('data-setting="rx.bandGain"')
		for (const value of ["863", "870", "37.2", "868 MHz ISM", "ADS-B"])
			expect(html).toContain(`value="${value}"`)
		// 2 m, 70 cm and ADS-B keep the gain: no dB field, Keep pressed
		expect(html.match(/aria-pressed="true"/g)).toHaveLength(3)
		expect(html).not.toContain('aria-label="2 m gain in dB"')
		expect(html).toContain('aria-label="868 MHz ISM gain in dB"')
		expect(html).toContain("Per-band gain for my tuning")
		expect(html).toMatch(/role="switch" aria-checked="false"/)
		expect(html).toContain("Off: only the scanner uses the table.")
		expect(html).not.toContain("data-changed")
		expect(html).not.toContain(">Save<")
	})

	it("edits, refuses an invalid draft and saves a valid one through PUT", async () => {
		const { services, server } = await mocked()
		const store = bandGainStore(services.data.api)
		await store.load()
		const view = store.get().view
		if (!view) throw new Error("no view")
		const d = draftOf(view.settings)
		const [r0, r1, r2, ...rest] = d.rows
		if (!r0 || !r1 || !r2) throw new Error("rows")
		// 868 down to 29.7 dB, plus a new band that touches 868's end: refused before any request
		const bad = bandGainFromDraft({
			...d,
			rows: [
				r0,
				r1,
				{ ...r2, gainDb: "29.7" },
				...rest,
				{ ...r2, key: "n", minMHz: "870", maxMHz: "872", label: "SRD" },
			],
		})
		expect("errors" in bad && bad.errors.rows["n"]).toEqual({
			minMHz: "Overlaps 868 MHz ISM",
		})
		const good = bandGainFromDraft({
			...d,
			rows: [
				r0,
				r1,
				{ ...r2, gainDb: "29.7" },
				...rest,
				{ ...r2, key: "n", minMHz: "870.1", maxMHz: "872", label: "SRD" },
			],
		})
		if (!("settings" in good)) throw new Error("invalid")
		expect(await store.save(good.settings)).toEqual({ ok: true })
		const stored = await server.app.inject({
			method: "GET",
			url: "/api/tuner-band-gain",
		})
		expect(stored.json()).toMatchObject({
			provenance: "runtime",
			settings: {
				entries: expect.arrayContaining([
					{
						minHz: 863_000_000,
						maxHz: 870_000_000,
						gain: 297,
						label: "868 MHz ISM",
					},
					{ minHz: 870_100_000, maxHz: 872_000_000, gain: 372, label: "SRD" },
				]),
			},
		})
		const html = renderRow(services)
		expect(html).toContain('value="29.7"')
		expect(html).toContain('value="SRD"')
		expect(html).toContain("data-changed")
	})

	it("shows the core's refusal and keeps the saved table", async () => {
		const { services } = await mocked()
		const store = bandGainStore(services.data.api)
		await store.load()
		const before = store.get().view?.settings
		const result = await store.save({
			applyToMyTuning: false,
			entries: [
				{ minHz: 863_000_000, maxHz: 870_000_000, gain: 372 },
				{ minHz: 870_000_000, maxHz: 871_000_000, gain: 372 },
			],
		})
		expect(result.ok).toBe(false)
		expect(!result.ok && result.message).toMatch(
			/^Invalid band gain settings at 1: entries 0 and 1 overlap/,
		)
		expect(store.get().view?.settings).toEqual(before)
	})

	it("turns Per-band gain for my tuning on at once", async () => {
		const { services } = await mocked()
		const store = bandGainStore(services.data.api)
		await store.load()
		const view = store.get().view
		if (!view) throw new Error("no view")
		await store.save({ ...view.settings, applyToMyTuning: true })
		expect(renderRow(services)).toMatch(/role="switch" aria-checked="true"/)
	})
})

describe("Receiver island band gain indicator", () => {
	it("words the core's confirmed band gain: its value, label and owner", () => {
		expect(
			bandGainText({ tenthsDb: 372, label: "868 MHz ISM", owner: "scanner" }),
		).toBe("Band gain 37.2 dB · 868 MHz ISM · while the scanner tunes")
		expect(bandGainText({ tenthsDb: 402, owner: "user" })).toBe(
			"Band gain 40.2 dB · for your tuning",
		)
	})

	it("words the scanner's overload hint for this source only", () => {
		const hint = {
			reason: "front end may be overloaded at this gain" as const,
			gain: 496,
			blankedPercent: 7.5,
		}
		expect(
			overloadHintText([{ sourceId: "rtl-0", overloadHint: hint }], "rtl-0"),
		).toBe(
			"Front end may be overloaded at this gain (49.6 dB, 7.5 % of frames blanked)",
		)
		expect(
			overloadHintText([{ sourceId: "rtl-1", overloadHint: hint }], "rtl-0"),
		).toBeNull()
		expect(overloadHintText([{ sourceId: "rtl-0" }], "rtl-0")).toBeNull()
	})

	it("renders the band gain in effect and the overload hint under Gain", async () => {
		const { services, server } = await mocked({ overloadHint: true })
		const { data } = services
		await Promise.all([data.sources.load(), data.tuner.load()])
		await data.receiver.loadCaps("rtl-0")
		await data.scanner.load()
		const store = bandGainStore(data.api)
		await store.load()
		// the default table, outside its bands: nothing about band gain
		let html = renderIsland(services)
		expect(html).not.toContain("data-band-gain")
		expect(html).toContain("data-overload")
		expect(html).toContain(
			"Front end may be overloaded at this gain (29.7 dB, 7.5 % of frames blanked)",
		)
		// the switch on but no retune yet: the core has applied nothing, so nothing is claimed
		const view = store.get().view
		if (!view) throw new Error("no view")
		await store.save({ ...view.settings, applyToMyTuning: true })
		await data.tuner.load()
		expect(renderIsland(services)).not.toContain("data-band-gain")
		// your own tuning inside 868 MHz with the switch on: the core confirms it
		await server.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-0/frequency",
			payload: { hz: 868_300_000 },
		})
		await data.tuner.load()
		html = renderIsland(services)
		expect(html).toContain("Band gain 37.2 dB · 868 MHz ISM · for your tuning")
		// a manual gain change (even to the same value) supersedes it
		await data.receiver.write("rtl-0", { key: "gain", value: 372 })
		await data.tuner.load()
		expect(renderIsland(services)).not.toContain("data-band-gain")
		// a band gain the dongle snaps (40.0 dB on an R820T) shows the gain on the tuner
		await store.save({
			applyToMyTuning: true,
			entries: [{ minHz: 863_000_000, maxHz: 870_000_000, gain: 400 }],
		})
		await server.app.inject({
			method: "POST",
			url: "/api/tuner/rtl-0/frequency",
			payload: { hz: 868_400_000 },
		})
		await data.tuner.load()
		expect(renderIsland(services)).toContain(
			"Band gain 40.2 dB · for your tuning",
		)
		// AGC: no overload hint (the core sends none either)
		await data.receiver.write("rtl-0", { key: "gainMode", value: "agc" })
		await data.scanner.load()
		expect(renderIsland(services)).not.toContain("data-overload")
	})
})

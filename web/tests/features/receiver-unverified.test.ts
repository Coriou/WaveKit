// After a plain resume of a paused feed the core lists centre, rate and gain in unknownFields with their
// last known values (another client may have retuned the receiver); an adopted rate is in measuredFields.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ExtendedSourceStatus, TunerState } from "@wavekit/api-types"
import { ServicesContext } from "../../src/app/context.ts"
import { createServices } from "../../src/app/services.ts"
import type { AppServices } from "../../src/app/services.ts"
import { buildMockServer } from "../../mock/server.ts"
import { receiverSlot } from "../../src/features/receiver/ReceiverIsland.tsx"
import {
	centreText,
	isMeasured,
	rateDoubtNote,
	rateText,
	receiverSummary,
} from "../../src/features/receiver/summary.ts"
import type { IslandContext } from "../../src/shell/ShellIsland.tsx"

const tuner = (over: Partial<TunerState> = {}): TunerState =>
	({
		sourceId: "rtl-0",
		frequency: 145_000_000,
		sampleRate: 2_400_000,
		gainMode: "manual",
		gain: 297,
		agcMode: false,
		...over,
	}) as TunerState
const source = { id: "rtl-0", connected: true } as ExtendedSourceStatus

describe("unverified centre and rate in words", () => {
	it("a known centre and rate read plainly", () => {
		expect(centreText(tuner())).toBe("145.000 MHz")
		expect(rateText(tuner())).toBe("2.4 MS/s")
		expect(rateDoubtNote(tuner())).toBeNull()
		expect(centreText(undefined)).toBe("—")
	})

	it("an unverified centre or rate reads as last known, never as known", () => {
		const t = tuner({ unknownFields: ["frequency", "sampleRate"] })
		expect(centreText(t)).toBe("last known 145.000 MHz · unverified")
		expect(rateText(t)).toBe("last known 2.4 MS/s · unverified")
		expect(rateDoubtNote(t)).toBe(
			"Unverified: another client may have changed it. Last known 2.4 MS/s; pick a rate to set it.",
		)
	})

	it("says Unknown when there is no value behind the field", () => {
		const t = tuner({
			frequency: 0,
			sampleRate: 0,
			unknownFields: ["frequency", "sampleRate"],
		})
		expect(centreText(t)).toBe("Unknown")
		expect(rateText(t)).toBe("Unknown")
		expect(receiverSummary(t, source)).toBe("Rate unknown · 29.7 dB")
		expect(rateDoubtNote(t)).toBe("Rate unknown: pick a rate to set it.")
	})

	it("labels an adopted rate measured, only while it is unverified", () => {
		const t = tuner({
			sampleRate: 2_160_000,
			unknownFields: ["sampleRate"],
			measuredFields: ["sampleRate"],
		})
		expect(isMeasured(t, "sampleRate")).toBe(true)
		expect(rateText(t)).toBe("2.16 MS/s · measured")
		expect(rateDoubtNote(t)).toMatch(/^Measured from the stream: 2\.16 MS\/s\./)
		// a stray measuredFields on a known rate claims nothing
		const known = tuner({ measuredFields: ["sampleRate"] })
		expect(isMeasured(known, "sampleRate")).toBe(false)
		expect(rateText(known)).toBe("2.4 MS/s")
	})

	it("the header line carries the unverified or measured rate", () => {
		expect(
			receiverSummary(
				tuner({ unknownFields: ["sampleRate", "gainMode", "gain"] }),
				source,
			),
		).toBe("last known 2.4 MS/s · unverified · Gain unknown")
		expect(
			receiverSummary(
				tuner({
					sampleRate: 2_160_000,
					unknownFields: ["sampleRate"],
					measuredFields: ["sampleRate"],
				}),
				source,
			),
		).toBe("2.16 MS/s · measured · 29.7 dB")
	})
})

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

/** The sample-rate radio group's markup. */
const rateGroup = (html: string): string => {
	const at = html.indexOf('aria-label="Sample rate"')
	return at < 0 ? "" : html.slice(at, html.indexOf("</div>", at))
}

const render = (services: AppServices, part: "panel" | "head") =>
	renderToStaticMarkup(
		createElement(
			ServicesContext.Provider,
			{ value: services },
			part === "panel" ? receiverSlot.panel?.(ctx) : receiverSlot.head?.(ctx),
		),
	)

async function resumedPlain(measuredRateHz?: number) {
	const server = await buildMockServer({
		port: 0,
		resumeMs: 0,
		...(measuredRateHz !== undefined ? { measuredRateHz } : {}),
	})
	await server.app.ready()
	const inject = (url: string, method: "GET" | "POST" = "GET") =>
		server.app.inject({ method, url })
	await inject("/api/sources/rtl-0/pause", "POST")
	await inject("/api/sources/rtl-0/resume", "POST")
	const services = createServices({
		fetch: async (input, init) => {
			const res = await server.app.inject({
				method: (init?.method ?? "GET") as "GET" | "POST",
				url: input,
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
	const { data } = services
	await Promise.all([data.sources.load(), data.tuner.load()])
	await data.receiver.loadCaps("rtl-0")
	await data.receiver.loadRelay()
	return {
		services,
		close: async () => {
			services.dispose()
			await server.close()
		},
	}
}

describe("Receiver island after a plain resume", () => {
	it("shows the centre and rate as last known and selects no rate", async () => {
		const { services, close } = await resumedPlain()
		const state = services.data.tuner.state("rtl-0") as TunerState
		expect(state.unknownFields).toEqual(
			expect.arrayContaining(["frequency", "sampleRate"]),
		)
		const html = render(services, "panel")
		expect(html).toContain("last known")
		expect(html).toContain("MHz · unverified")
		expect(html).toContain('aria-label="Sample rate"')
		// no option reads as the current rate: picking the shown one is a real write
		const group = rateGroup(html)
		expect(group).toMatch(/aria-checked="false"[^>]*>2\.4</)
		expect(group).not.toContain('aria-checked="true"')
		expect(html).toContain("Unverified: another client may have changed it.")
		await close()
	})

	it("labels an adopted rate measured", async () => {
		const { services, close } = await resumedPlain(2_048_000)
		const html = render(services, "panel")
		expect(html).toContain("Measured from the stream: 2.048 MS/s.")
		const group = rateGroup(html)
		expect(group).toContain(">2.048<")
		expect(group).not.toContain('aria-checked="true"')
		await close()
	})
})

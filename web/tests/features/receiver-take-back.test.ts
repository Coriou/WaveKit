// After a plain resume the core may leave the tuning as found: GET /api/sources carries the source's
// `tuningUnproven`, which the Receiver island shows with "Take the tuning back"
// (POST /api/tuner/:sourceId/take-back); a 409 shows the core's own message.
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
	offersTakeBack,
	takeTuningBack,
} from "../../src/features/receiver/take-back.ts"
import type { IslandContext } from "../../src/shell/ShellIsland.tsx"

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

const panel = (services: AppServices) =>
	renderToStaticMarkup(
		createElement(
			ServicesContext.Provider,
			{ value: services },
			receiverSlot.panel?.(ctx),
		),
	)

async function resumedPlain(
	takeBackRefusal?: "TUNER_TAKE_BACK_BLOCKED" | "TUNER_NOTHING_HELD",
) {
	const server = await buildMockServer({
		port: 0,
		resumeMs: 0,
		...(takeBackRefusal !== undefined ? { takeBackRefusal } : {}),
	})
	await server.app.ready()
	await server.app.inject({ method: "POST", url: "/api/sources/rtl-0/pause" })
	await server.app.inject({ method: "POST", url: "/api/sources/rtl-0/resume" })
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

const unproven = (services: AppServices) =>
	services.data.sources.byId("rtl-0")?.tuningUnproven

describe("Take the tuning back", () => {
	it("is offered beside the core's sentence while the source's tuning is unproven", async () => {
		const { services, close } = await resumedPlain()
		expect(unproven(services)?.cause).toBe("plain-resume")
		const html = panel(services)
		expect(html).toContain("Tuning not proven since a resume without restore")
		expect(html).toContain("Take the tuning back")
		expect(html).toContain('data-cause="plain-resume"')
		await close()
	})

	it("is a plain wrapper, not a live region: only the refusal text is one (no nested live regions)", async () => {
		const { services, close } = await resumedPlain()
		const html = panel(services)
		const open =
			/<span class="wkf-warn wkf-rx-error wkf-rx-unproven"[^>]*>/.exec(
				html,
			)?.[0]
		expect(open).toBeDefined()
		expect(open).not.toMatch(/role=|aria-live/)
		// Before any refusal there is no live region inside it at all.
		const note = html.slice(html.indexOf(open ?? ""))
		const body = note.slice(0, note.indexOf("Take the tuning back"))
		expect(body).not.toMatch(/role="(status|alert)"|aria-live/)
		await close()
	})

	it("hides the action without a connection (cause no-session) and keeps the core's sentence", async () => {
		const { services, close } = await resumedPlain()
		services.data.sources.update(s => ({
			...s,
			sources: s.sources.map(row =>
				row.id === "rtl-0" && row.tuningUnproven
					? {
							...row,
							tuningUnproven: {
								...row.tuningUnproven,
								cause: "no-session",
								message: "Tuning not proven: no connection",
							},
						}
					: row,
			),
		}))
		const html = panel(services)
		expect(html).toContain('data-cause="no-session"')
		expect(html).toContain("Tuning not proven: no connection")
		expect(html).not.toContain("Take the tuning back")
		await close()
	})

	it("takes the tuning back: the outcome reads operator and the notice goes", async () => {
		const { services, close } = await resumedPlain()
		expect(await takeTuningBack(services.data, "rtl-0")).toBeNull()
		const state = services.data.tuner.state("rtl-0") as TunerState
		expect(state.resumeOutcome).toEqual({
			outcome: "restored",
			reason: "operator",
			message: "tuning taken back by the operator",
		})
		expect(state.unknownFields ?? []).not.toContain("frequency")
		// the source row is read again: its tuningUnproven is gone, and so is the action
		await services.data.sources.load()
		expect(unproven(services)).toBeUndefined()
		expect(panel(services)).not.toContain("Take the tuning back")
		await close()
	})

	it("shows the core's message on a 409 TUNER_NOTHING_HELD or TUNER_TAKE_BACK_BLOCKED", async () => {
		const nothing = await resumedPlain("TUNER_NOTHING_HELD")
		expect(await takeTuningBack(nothing.services.data, "rtl-0")).toBe(
			"No held centre and sample rate to take back; set the tuning (POST /api/tuner/:sourceId/tune)",
		)
		// the hold stays
		await nothing.services.data.sources.load()
		expect(unproven(nothing.services)?.cause).toBe("plain-resume")
		await nothing.close()
		const blocked = await resumedPlain("TUNER_TAKE_BACK_BLOCKED")
		expect(await takeTuningBack(blocked.services.data, "rtl-0")).toBe(
			"The tuning cannot be taken back now (relay-attached)",
		)
		await blocked.close()
	})

	it("any other failure reads as a failed take-back, never throws", async () => {
		const { services, close } = await resumedPlain()
		expect(await takeTuningBack(services.data, "nope")).toMatch(
			/^Could not take the tuning back: /,
		)
		await close()
	})

	it("is not offered under the causes the core always refuses", () => {
		for (const cause of [
			"relay-attached",
			"external-control",
			"scanner-lease",
			"lost-ownership",
			"no-session",
		])
			expect(offersTakeBack(cause)).toBe(false)
		for (const cause of [
			"plain-resume",
			"doubt:untracked-retune",
			"no-receipt",
			"declared-write-off",
		])
			expect(offersTakeBack(cause)).toBe(true)
	})

	it("Resume says when the tuning is written back", async () => {
		const { services, close } = await resumedPlain()
		await services.data.api.post("/api/sources/rtl-0/pause")
		await services.data.sources.load()
		expect(panel(services)).toContain(
			"Reconnect; the tuning is written back only when WaveKit is the receiver&#x27;s only client",
		)
		await close()
	})

	it("shows no notice on a live source whose tuning is proven", async () => {
		const server = await buildMockServer({ port: 0 })
		await server.app.ready()
		const res = await server.app.inject({ method: "GET", url: "/api/sources" })
		const rows = JSON.parse(res.body) as ExtendedSourceStatus[]
		expect(rows[0]?.tuningUnproven).toBeUndefined()
		await server.close()
	})
})

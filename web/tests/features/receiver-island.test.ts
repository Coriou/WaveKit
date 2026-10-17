import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { TunerState } from "@wavekit/api-types"
import { ServicesContext } from "../../src/app/context.ts"
import { createServices } from "../../src/app/services.ts"
import type { AppServices } from "../../src/app/services.ts"
import { RTL_TUNER_GAIN_TABLES } from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import { receiverSlot } from "../../src/features/receiver/ReceiverIsland.tsx"
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

const render = (services: AppServices) =>
	renderToStaticMarkup(
		createElement(
			ServicesContext.Provider,
			{ value: services },
			receiverSlot.panel?.(ctx),
		),
	)

async function loaded(): Promise<{
	services: AppServices
	close: () => Promise<void>
	relayClient: (active: boolean) => void
}> {
	const server = await buildMockServer({ port: 0 })
	await server.app.ready()
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
		relayClient: active => server.receiver.relayClient(active),
		close: async () => {
			services.dispose()
			await server.close()
		},
	}
}

describe("Receiver island panel", () => {
	it("renders the controls from the core's state and capabilities", async () => {
		const { services, close } = await loaded()
		const html = render(services)
		expect(html).toContain("RTL-SDR · R820T")
		expect(html).toContain('aria-label="Sample rate"')
		expect(html).toMatch(/aria-checked="true"[^>]*>2\.4</)
		expect(html).toContain('aria-label="Tuner gain"')
		expect(html).toContain(
			`max="${(RTL_TUNER_GAIN_TABLES[5]?.valuesTenthsDb.length ?? 0) - 1}"`,
		)
		expect(html).toContain("29.7 dB")
		expect(html).toContain("Steps follow the R820T&#x27;s own gain table.")
		expect(html).toContain("Only E4000 tuners have offset tuning")
		expect(html).toContain(
			"WaveKit has control. SDR++ can take over through the relay on port 1234.",
		)
		expect(html).not.toContain("Take control")
		await close()
	})

	it("locks the controls and offers to take control while a relay client has the tuner", async () => {
		const { services, close, relayClient } = await loaded()
		relayClient(true)
		await services.data.tuner.load()
		await services.data.receiver.loadRelay()
		const state = services.data.tuner.state("rtl-0") as TunerState
		expect(state.controlMode).toBe("external")
		const html = render(services)
		expect(html).toContain(
			"An rtl_tcp client at 192.168.1.23:51544 has the tuner",
		)
		expect(html).toContain("Take control")
		expect(html).toMatch(/<input type="range"[^>]*disabled=""/)
		await close()
	})
})

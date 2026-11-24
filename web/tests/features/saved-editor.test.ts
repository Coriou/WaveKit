import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import type { SavedFrequency } from "@wavekit/api-types"
import { ServicesContext } from "../../src/app/context.ts"
import { createServices } from "../../src/app/services.ts"
import type { AppServices } from "../../src/app/services.ts"
import { inputOf } from "../../src/data/saved-frequencies-store.ts"
import {
	EditField,
	SaveForm,
} from "../../src/features/tuner/SavedFrequencies.tsx"
import { withCentre } from "../../src/features/tuner/saved.ts"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

let open: { services: AppServices; server: MockServer } | null = null
afterEach(async () => {
	if (!open) return
	open.services.dispose()
	await open.server.close()
	open = null
})

async function mocked(): Promise<AppServices> {
	const server = await buildMockServer({ port: 0 })
	await server.app.ready()
	const services = createServices({
		fetch: async (input, init) => {
			const res = await server.app.inject({
				method: (init?.method ?? "GET") as "GET",
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
	open = { services, server }
	return services
}

const row: SavedFrequency = {
	id: "00000000-0000-4000-8000-000000000042",
	createdAt: "2026-10-14T08:00:00.000Z",
	updatedAt: "2026-10-14T08:00:00.000Z",
	name: "Band middle",
	frequencyHz: 161_500_000,
	mode: "nfm",
	bandwidthHz: 12_500,
	tone: { kind: "none" },
	centre: true,
}

/** The "Tune as centre" switch in a markup: its aria-checked, or null when absent. */
function centreSwitch(html: string): string | null {
	const label = /<span id="([^"]+)">Tune as centre<\/span>/.exec(html)
	if (!label) return null
	const sw = new RegExp(`<button[^>]*aria-labelledby="${label[1]}"[^>]*>`).exec(
		html,
	)?.[0]
	return sw ? (/aria-checked="(true|false)"/.exec(sw)?.[1] ?? null) : null
}

describe("saved frequency editor: Tune as centre", () => {
	it("the save form offers one Tune as centre switch, off by default", async () => {
		const services = await mocked()
		const html = renderToStaticMarkup(
			createElement(
				ServicesContext.Provider,
				{ value: services },
				createElement(SaveForm, { hz: 161_500_000, onDone: () => undefined }),
			),
		)
		expect(html.match(/Tune as centre/g)).toHaveLength(1)
		expect(html).toContain('role="switch"')
		expect(centreSwitch(html)).toBe("false")
	})

	it("the edit field shows the saved flag next to the name", async () => {
		const services = await mocked()
		const render = (r: SavedFrequency) =>
			renderToStaticMarkup(
				createElement(
					ServicesContext.Provider,
					{ value: services },
					createElement(EditField, { row: r, onDone: () => undefined }),
				),
			)
		const on = render(row)
		expect(on).toContain('aria-label="New name for Band middle"')
		expect(centreSwitch(on)).toBe("true")
		const plain = { ...row }
		delete plain.centre
		expect(centreSwitch(render(plain))).toBe("false")
	})

	it("the switch sets or clears the field, and a rename keeps it", () => {
		const input = inputOf(row)
		expect(input.centre).toBe(true)
		expect(withCentre({ ...input, name: "New" }, true)).toMatchObject({
			name: "New",
			centre: true,
		})
		const off = withCentre(input, false)
		expect(Object.hasOwn(off, "centre")).toBe(false)
		expect(input.centre).toBe(true)
	})
})

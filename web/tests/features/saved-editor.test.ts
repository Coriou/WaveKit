import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
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
import { FakeNode, installFakeDom } from "../shell/fake-dom.ts"
import type { FakeElement } from "../shell/fake-dom.ts"

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

// ---- interaction: the real EditField mounted with react-dom/client on the minimal DOM (tests/shell/fake-dom.ts).
// That DOM dispatches no events, so each step calls the handler React attached to the element (its props),
// with an event object shaped as the browser's would be; React's state updates and re-renders are real.

type Handler = (e: Record<string, unknown>) => void

/** The React props on a mounted element (react-dom keeps them under `__reactProps$<id>`). */
function propsOf(el: FakeElement): Record<string, unknown> {
	const key = Object.keys(el).find(k => k.startsWith("__reactProps$"))
	if (!key) throw new Error(`no React props on ${el.tagName}`)
	return (el as unknown as Record<string, Record<string, unknown>>)[key] ?? {}
}

function fire(
	el: FakeElement,
	name: string,
	init: Record<string, unknown> = {},
) {
	const h = propsOf(el)[name] as Handler | undefined
	let prevented = false
	const e = {
		target: el,
		currentTarget: el,
		relatedTarget: null,
		get defaultPrevented() {
			return prevented
		},
		preventDefault: () => {
			prevented = true
		},
		stopPropagation: () => undefined,
		...init,
	}
	act(() => h?.(e))
	return { prevented }
}

describe("saved frequency editor: interaction", () => {
	let dom: ReturnType<typeof installFakeDom> | null = null
	let root: Root | null = null
	const g = globalThis as Record<string, unknown>
	const oldNode = g["Node"]
	afterEach(() => {
		if (root) act(() => root?.unmount())
		root = null
		dom?.restore()
		dom = null
		if (oldNode === undefined) delete g["Node"]
		else g["Node"] = oldNode
	})

	async function mount(r: SavedFrequency) {
		const services = await mocked()
		const replace = vi
			.spyOn(services.data.savedFrequencies, "replace")
			.mockResolvedValue(undefined)
		const onDone = vi.fn()
		dom = installFakeDom()
		g["Node"] = FakeNode
		const container = dom.doc.createElement("div")
		dom.doc.body.appendChild(container)
		const mounted = createRoot(container as unknown as HTMLElement)
		root = mounted
		act(() =>
			mounted.render(
				createElement(
					ServicesContext.Provider,
					{ value: services },
					createElement(EditField, { row: r, onDone }),
				),
			),
		)
		const find = (name: string, value: string) => {
			const el = container.find(name, value)
			if (!el) throw new Error(`no ${name}=${value}`)
			return el
		}
		const group = find("role", "group")
		const sw = find("role", "switch")
		const input = find("aria-label", `New name for ${r.name}`)
		/** Bubbles one event from `el` to the group, as the browser would (React's bubbling). */
		const bubble = (
			el: FakeElement,
			name: string,
			init: Record<string, unknown>,
		) => {
			const own = el === group ? { prevented: false } : fire(el, name, init)
			const up = fire(group, name, { ...init, target: el })
			return { prevented: own.prevented || up.prevented }
		}
		return { replace, onDone, group, sw, input, bubble }
	}

	it("pressing the switch where the browser does not focus a clicked button keeps the editor and toggles", async () => {
		const m = await mount(row)
		// Safari, iOS and macOS Firefox: mousedown on a button moves no focus; unless its default is
		// prevented, the input blurs with relatedTarget null before the click lands.
		const down = fire(m.sw, "onMouseDown")
		if (!down.prevented) fire(m.group, "onBlur", { relatedTarget: null })
		fire(m.sw, "onClick")
		expect(down.prevented).toBe(true)
		expect(m.onDone).not.toHaveBeenCalled()
		expect(m.sw.getAttribute("aria-checked")).toBe("false")
		expect(m.replace).not.toHaveBeenCalled()
	})

	it("Enter saves; turning the flag off removes the field via replace", async () => {
		const m = await mount(row)
		fire(m.sw, "onMouseDown")
		fire(m.sw, "onClick")
		const enter = m.bubble(m.input, "onKeyDown", { key: "Enter" })
		expect(enter.prevented).toBe(true)
		expect(m.onDone).toHaveBeenCalledTimes(1)
		expect(m.replace).toHaveBeenCalledTimes(1)
		const [id, input] = m.replace.mock.calls[0] ?? []
		expect(id).toBe(row.id)
		expect(input).toMatchObject({ name: "Band middle" })
		expect(Object.hasOwn(input ?? {}, "centre")).toBe(false)
		// The blur of the row unmounting after Enter saves nothing more.
		fire(m.group, "onBlur", { relatedTarget: null })
		expect(m.replace).toHaveBeenCalledTimes(1)
		expect(m.onDone).toHaveBeenCalledTimes(1)
	})

	it("Enter on the focused switch saves rather than toggles", async () => {
		const plain = { ...row }
		delete plain.centre
		const m = await mount(plain)
		fire(m.sw, "onMouseDown")
		fire(m.sw, "onClick")
		expect(m.sw.getAttribute("aria-checked")).toBe("true")
		// Enter's default (the button's click activation) is prevented by the group: no second toggle.
		const enter = m.bubble(m.sw, "onKeyDown", { key: "Enter" })
		expect(enter.prevented).toBe(true)
		expect(m.replace).toHaveBeenCalledTimes(1)
		expect(m.replace.mock.calls[0]?.[1]).toMatchObject({ centre: true })
		expect(m.onDone).toHaveBeenCalledTimes(1)
	})

	it("Escape cancels: nothing saved, even by the blur that follows", async () => {
		const m = await mount(row)
		fire(m.sw, "onMouseDown")
		fire(m.sw, "onClick")
		m.bubble(m.input, "onKeyDown", { key: "Escape" })
		fire(m.group, "onBlur", { relatedTarget: null })
		expect(m.onDone).toHaveBeenCalledTimes(1)
		expect(m.replace).not.toHaveBeenCalled()
	})

	it("focus moving inside the group keeps editing; leaving it saves", async () => {
		const plain = { ...row }
		delete plain.centre
		const m = await mount(plain)
		fire(m.group, "onBlur", { relatedTarget: m.sw })
		expect(m.onDone).not.toHaveBeenCalled()
		fire(m.sw, "onClick")
		const outside = dom?.doc.createElement("button")
		fire(m.group, "onBlur", { relatedTarget: outside })
		expect(m.onDone).toHaveBeenCalledTimes(1)
		expect(m.replace).toHaveBeenCalledTimes(1)
		expect(m.replace.mock.calls[0]?.[1]).toMatchObject({
			name: "Band middle",
			centre: true,
		})
	})

	it("leaving with nothing changed saves nothing", async () => {
		const m = await mount(row)
		fire(m.group, "onBlur", { relatedTarget: null })
		expect(m.onDone).toHaveBeenCalledTimes(1)
		expect(m.replace).not.toHaveBeenCalled()
	})
})

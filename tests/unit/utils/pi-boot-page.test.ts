import { readFileSync } from "node:fs"
import { createContext, runInContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

function page() {
	const elements = new Map<
		string,
		{
			textContent: string
			hidden: boolean
			href: string
			dataset: Record<string, string>
			replaceChildren: (...nodes: (string | { textContent: string })[]) => void
		}
	>()
	const get = (id: string) => {
		if (!elements.has(id)) {
			const element = {
				textContent: "",
				hidden: false,
				href: "",
				dataset: {},
				// Enough of Element.replaceChildren for boot.js: keep the visible text.
				replaceChildren(...nodes: (string | { textContent: string })[]) {
					element.textContent = nodes
						.map(node => (typeof node === "string" ? node : node.textContent))
						.join("")
				},
			}
			elements.set(id, element)
		}
		return elements.get(id)!
	}
	const phases = ["cloud-init", "install", "publish"].map(phase => ({
		dataset: { phase } as Record<string, string>,
		small: { textContent: "" },
		setAttribute: vi.fn(),
		removeAttribute: vi.fn(),
		querySelector() {
			return this.small
		},
	}))
	const replace = vi.fn()
	const context = createContext({
		document: {
			getElementById: get,
			querySelectorAll: () => phases,
			createElement: () => ({ className: "", textContent: "" }),
		},
		window: {
			location: { href: "http://[::1]/?private=value", replace },
			setTimeout: vi.fn(),
			setInterval: vi.fn(),
		},
		URL,
		AbortSignal,
		fetch: () => new Promise(() => {}),
	})
	runInContext(readFileSync("packages/sdr-host/ui/boot.js", "utf8"), context)
	return { context, get, phases, replace }
}

const completed = {
	state: "complete",
	phase: "done",
	updatedAt: "2026-10-08T10:00:00Z",
	updatedAgeMs: 1000,
	receiverPageReady: false,
}

describe("Pi first-boot browser handoff", () => {
	it("waits for an actual receiver page, then reloads the same address without query data", () => {
		const { context, replace, get } = page()
		context["render"](completed)
		expect(replace).not.toHaveBeenCalled()
		expect(get("setup-title").textContent).toBe("Setup complete")
		context["render"]({ ...completed, receiverPageReady: true })
		// Port 80 serves the status page itself once setup is complete.
		expect(replace).toHaveBeenCalledWith("http://[::1]/")
	})

	it("keeps failures visible even if the receiver page exists", () => {
		const { context, replace, get } = page()
		context["render"]({
			...completed,
			state: "failed",
			exitCode: 23,
			receiverPageReady: true,
		})
		expect(replace).not.toHaveBeenCalled()
		expect(get("setup-title").textContent).toBe("Setup needs attention")
		expect(get("setup-detail").textContent).toContain("exit 23")
		expect(get("receiver-link-wrap").hidden).toBe(false)
		// Port 80 keeps the setup page after a failure; the link goes direct.
		expect(get("receiver-link").href).toBe("http://[::1]:8080/")
	})

	it("does not present old progress as live after contact is lost", async () => {
		const { context, get, phases } = page()
		context["render"]({
			...completed,
			state: "running",
			phase: "install",
			updatedAgeMs: null,
		})
		expect(get("setup-age").textContent).toBe("Stage time unavailable")
		expect(get("setup-clock").textContent).toBe("—")
		context["fetch"] = () => Promise.reject(new Error("offline"))
		await context["poll"]()
		expect(get("setup-title").textContent).toBe("Contact lost")
		expect(get("contact").dataset["state"]).toBe("reconnecting")
		expect(get("receiver-link-wrap").hidden).toBe(true)
		expect(phases.map(phase => phase.small.textContent)).toEqual([
			"Unknown",
			"Unknown",
			"Unknown",
		])
		expect(phases.map(phase => phase.dataset["state"])).toEqual([
			"unknown",
			"unknown",
			"unknown",
		])
		expect(get("setup-clock").textContent).toBe("—")
	})

	it("lights finished stages, marks the current one and times it from the Pi's clock", () => {
		const { context, get, phases } = page()
		context["render"]({
			...completed,
			state: "running",
			phase: "install",
			updatedAgeMs: 89_400,
		})
		expect(phases.map(phase => phase.small.textContent)).toEqual([
			"Done",
			"In progress",
			"Waiting",
		])
		expect(phases.map(phase => phase.dataset["state"])).toEqual([
			"ok",
			"ok",
			"unknown",
		])
		expect(phases[1]?.setAttribute).toHaveBeenCalledWith("aria-current", "step")
		expect(get("setup-clock").textContent).toBe("1:29")
		expect(get("setup-age").textContent).toBe("in this stage")
		expect(get("setup-note").hidden).toBe(false)
	})

	it("escalates lost contact after ten seconds, as the status page does", async () => {
		const { context, get } = page()
		let now = 1_000_000
		context["Date"] = { now: () => now }
		context["render"]({ ...completed, state: "running", phase: "install" })
		context["fetch"] = () => Promise.reject(new Error("offline"))
		now += 12_000
		await context["poll"]()
		expect(get("contact").dataset["state"]).toBe("offline")
		expect(get("contact-text").textContent).toBe("Lost · 12 s ago")
	})

	it("does not guess which stage a failure stopped in", () => {
		const { context, get, phases } = page()
		context["render"]({
			...completed,
			state: "failed",
			phase: null,
			exitCode: 1,
		})
		expect(get("setup-screen").dataset["state"]).toBe("fault")
		expect(phases.map(phase => phase.small.textContent)).toEqual([
			"Unknown",
			"Unknown",
			"Unknown",
		])
		expect(get("setup-note").hidden).toBe(true)
	})
})

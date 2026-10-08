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
		}
	>()
	const get = (id: string) => {
		if (!elements.has(id))
			elements.set(id, {
				textContent: "",
				hidden: false,
				href: "",
				dataset: {},
			})
		return elements.get(id)!
	}
	const phases = ["cloud-init", "install", "publish"].map(phase => ({
		dataset: { phase },
		small: { textContent: "" },
		setAttribute: vi.fn(),
		removeAttribute: vi.fn(),
		querySelector() {
			return this.small
		},
	}))
	const replace = vi.fn()
	const context = createContext({
		document: { getElementById: get, querySelectorAll: () => phases },
		window: {
			location: { href: "http://[::1]/?private=value", replace },
			setTimeout: vi.fn(),
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
	it("waits for an actual receiver page, then opens the same host without query data", () => {
		const { context, replace, get } = page()
		context["render"](completed)
		expect(replace).not.toHaveBeenCalled()
		expect(get("setup-title").textContent).toBe("Setup complete")
		context["render"]({ ...completed, receiverPageReady: true })
		expect(replace).toHaveBeenCalledWith("http://[::1]:8080/")
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
	})

	it("does not present old progress as live after contact is lost", async () => {
		const { context, get, phases } = page()
		context["render"]({
			...completed,
			state: "running",
			phase: "install",
			updatedAgeMs: null,
		})
		expect(get("setup-age").textContent).toBe("Stage update time unavailable")
		context["fetch"] = () => Promise.reject(new Error("offline"))
		await context["poll"]()
		expect(get("setup-title").textContent).toBe("Contact lost")
		expect(get("receiver-link-wrap").hidden).toBe(true)
		expect(phases.map(phase => phase.small.textContent)).toEqual([
			"Unknown",
			"Unknown",
			"Unknown",
		])
	})
})

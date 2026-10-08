import { Box, Text } from "ink"
import { describe, expect, it, vi } from "vitest"
import { useTerminalSize } from "../hooks/use-terminal-size.js"
import { renderAt } from "../test/harness.js"
import { ConfirmBar } from "./confirm-bar.js"
import { ErrorBoundary } from "./error-boundary.js"
import { ColorContext } from "./lines.js"
import { TooSmall } from "./too-small.js"

function Size() {
	const { columns, rows } = useTerminalSize()
	return <Text>{`${columns}x${rows}`}</Text>
}

function Boom(): never {
	throw new Error("boom \u001b[2J")
}

describe("chrome components", () => {
	it("tracks resize through its own stdout listener (works under CI=true)", async () => {
		const h = await renderAt(<Size />, { cols: 120, rows: 40 })
		expect(h.text()).toBe("120x40")
		await h.resize(60, 16)
		expect(h.text()).toBe("60x16")
		expect(h.writes().some(w => w.includes("\u001b[2J"))).toBe(true)
		h.unmount()
	})
	it("renders the too-small line", async () => {
		const h = await renderAt(<TooSmall cols={50} rows={12} />, {
			cols: 50,
			rows: 12,
		})
		expect(h.text()).toBe("wavekit: 50×12 too small (min 60×16)")
		h.unmount()
	})
	it("renders the confirm bar", async () => {
		const confirm = {
			kind: "decoder" as const,
			prompt: "restart readsb · up 51s · pid 1531",
			yes: "restart",
			no: "cancel",
			intent: {
				kind: "decoder" as const,
				op: "restart" as const,
				decoderId: "readsb",
			},
		}
		const h = await renderAt(
			<ColorContext.Provider value={false}>
				<ConfirmBar confirm={confirm} width={119} />
			</ColorContext.Provider>,
			{ cols: 120, rows: 10 },
		)
		expect(h.text()).toBe(
			" ▶ restart readsb · up 51s · pid 1531   y restart  n cancel",
		)
		h.unmount()
	})
	// R27: sanitize strips the whole CSI sequence, so no "[2J" residue survives.
	it("catches render errors with a sanitised one-line fallback", async () => {
		// M8: React logs the caught error; keep the test output clean.
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const h = await renderAt(
			<Box>
				<ErrorBoundary>
					<Boom />
				</ErrorBoundary>
			</Box>,
			{ cols: 80, rows: 10 },
		)
		expect(h.text()).toBe(" wavekit: render error · boom · q quit")
		h.unmount()
		spy.mockRestore()
	})
})

describe("error boundary (M7)", () => {
	function Thrower({ value }: { value: unknown }): never {
		throw value
	}
	it("handles non-Error throws", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
		for (const [value, text] of [
			["plain string", " wavekit: render error · plain string · q quit"],
			[42, " wavekit: render error · 42 · q quit"],
			[null, " wavekit: render error · null · q quit"],
		] as const) {
			const h = await renderAt(
				<ErrorBoundary>
					<Thrower value={value} />
				</ErrorBoundary>,
				{ cols: 80, rows: 10 },
			)
			expect(h.text()).toBe(text)
			h.unmount()
		}
		spy.mockRestore()
	})
})

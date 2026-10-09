import { Text, useInput, useStdout } from "ink"
import { useEffect, useState } from "react"
import { describe, expect, it } from "vitest"
import { KEYS, renderAt } from "./harness.js"

function Echo() {
	const [last, setLast] = useState("none")
	useInput((input, key) => {
		if (key.escape) setLast("esc")
		else if (key.upArrow) setLast("up")
		else if (key.backspace || key.delete) setLast("backspace")
		else setLast(`input:${input}`)
	})
	return <Text>last {last}</Text>
}

/** Applies each key's effect only after a delay, like a slow host would. */
function LateEcho() {
	const [last, setLast] = useState("none")
	useInput(input => {
		setTimeout(() => setLast(`late:${input}`), 60)
	})
	return <Text>last {last}</Text>
}

/** Input turns on only after mount + 60 ms, like a passive effect on a loaded host. */
function LateListener() {
	const [active, setActive] = useState(false)
	const [last, setLast] = useState("none")
	useEffect(() => {
		const t = setTimeout(() => setActive(true), 60)
		return () => clearTimeout(t)
	}, [])
	useInput(input => setLast(`input:${input}`), { isActive: active })
	return <Text>last {last}</Text>
}

function Ticker() {
	const [n, setN] = useState(0)
	useEffect(() => {
		const t = setTimeout(() => setN(1), 80)
		return () => clearTimeout(t)
	}, [])
	return <Text>tick {n}</Text>
}

/** Re-renders on stdout "resize" itself, as the app does (Ink ignores resize under CI=true). */
function Width() {
	const { stdout } = useStdout()
	const [cols, setCols] = useState(stdout.columns)
	useEffect(() => {
		const on = () => setCols(stdout.columns)
		stdout.on("resize", on)
		return () => {
			stdout.off("resize", on)
		}
	}, [stdout])
	return <Text>cols {cols}</Text>
}

describe("render harness", () => {
	it("captures the last full frame", async () => {
		const h = await renderAt(<Text>hello</Text>, { cols: 80, rows: 24 })
		expect(h.frame()).toEqual(["hello"])
		h.unmount()
	})
	it("delivers one key per chunk", async () => {
		const h = await renderAt(<Echo />, { cols: 80, rows: 24 })
		await h.press("q")
		expect(h.text()).toBe("last input:q")
		await h.press(KEYS.up)
		expect(h.text()).toBe("last up")
		await h.press(KEYS.backspace)
		expect(h.text()).toBe("last backspace")
		await h.press(KEYS.esc)
		expect(h.text()).toBe("last esc")
		h.unmount()
	})
	it("press waits for a frame that lands late", async () => {
		const h = await renderAt(<LateEcho />, { cols: 80, rows: 24 })
		await h.press("x")
		expect(h.text()).toBe("last late:x")
		h.unmount()
	})
	it("press with expectWrite false returns without a frame change", async () => {
		const h = await renderAt(<Echo />, { cols: 80, rows: 24 })
		const before = h.writes().length
		await h.press(KEYS.up)
		await h.press(KEYS.up, { expectWrite: false })
		expect(h.writes().length).toBe(before + 1)
		expect(h.text()).toBe("last up")
		h.unmount()
	})
	it("waitFor polls until the predicate holds and throws with the frame on timeout", async () => {
		const h = await renderAt(<Ticker />, { cols: 80, rows: 24 })
		await h.waitFor(f => f[0] === "tick 1")
		expect(h.text()).toBe("tick 1")
		await expect(h.waitFor(f => f[0] === "never", 50)).rejects.toThrow(
			/last frame:\ntick 1/,
		)
		h.unmount()
	})
	it("resize waits for the re-rendered frame", async () => {
		const h = await renderAt(<Width />, { cols: 80, rows: 24 })
		expect(h.text()).toBe("cols 80")
		await h.resize(40, 24)
		expect(h.text()).toBe("cols 40")
		h.unmount()
	})
})

describe("press waits for Ink's stdin listener (R69 M2)", () => {
	it("a key pressed before useInput is active is not dropped", async () => {
		const h = await renderAt(<LateListener />, { cols: 40, rows: 5 })
		await h.press("x")
		expect(h.text()).toContain("last input:x")
		h.unmount()
	})
})

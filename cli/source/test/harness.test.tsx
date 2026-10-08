import { Text, useInput } from "ink"
import { useState } from "react"
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
})

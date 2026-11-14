import { describe, expect, it } from "vitest"
import { graphicsAfter } from "../../src/plot/graphics.ts"

describe("the plot's graphics state", () => {
	it("is what the engine says draws", () => {
		expect(
			graphicsAfter({
				type: "renderer",
				kind: "canvas2d",
				reason: "no WebGL2",
			}),
		).toEqual({ kind: "canvas2d", reason: "no WebGL2" })
		expect(graphicsAfter({ type: "renderer", kind: "webgl2" })).toEqual({
			kind: "webgl2",
			reason: null,
		})
	})

	it("is cleared when the canvas remounts: the basic-mode chip does not outlive its canvas", () => {
		expect(graphicsAfter({ type: "remount" })).toBeNull()
	})
})

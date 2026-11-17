import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The palette and the player both prefix their classes with `wkp-`, and both stylesheets load globally: a class
// defined in both restyles the other (the player's 2 px `.wkp-head` playhead once collapsed the palette's header,
// leaving its input 0 px wide)
const classes = (path: string) =>
	new Set(
		readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8").match(
			/\.wkp-[a-z0-9-]+/g,
		) ?? [],
	)

describe("wkp- class names", () => {
	it("the palette and the player define no class in common", () => {
		const palette = classes("features/palette/palette.css")
		const player = classes("features/playback/playback.css")
		expect([...palette].filter(c => player.has(c))).toEqual([])
	})
})

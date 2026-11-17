// The hint writing rules (docs/web/DESIGN.md, Hints) as code, over every Listen hint.
import { isValidElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"

import { LISTEN_HINTS } from "../../src/features/listen/hints.ts"
import { VOICE_ONLY_SUB } from "../../src/features/listen/ListenIsland.tsx"

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
const sentences = (s: string) =>
	s
		.split(/(?<=\.)\s+/)
		.map(x => x.trim())
		.filter(Boolean)

/** Plain text of a learn row (a string, or strings around a key cap). */
function plain(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node)
	if (Array.isArray(node)) return node.map(plain).join("")
	if (isValidElement<{ children?: ReactNode }>(node))
		return plain(node.props.children)
	return ""
}

const BANNED = [
	"dBFS",
	"high-pass",
	"click",
	"drag",
	"simply",
	"just",
	"please",
	"currently",
	"allows you to",
	"!",
]

describe("Listen hint copy", () => {
	for (const [label, hint] of Object.entries(LISTEN_HINTS))
		it(`${label}: one sentence of 15 words at most, a short second only for a cost or choice`, () => {
			const parts = sentences(hint.text)
			expect(parts.length).toBeGreaterThanOrEqual(1)
			expect(parts.length).toBeLessThanOrEqual(2)
			expect(words(parts[0] ?? "")).toBeLessThanOrEqual(15)
			if (parts[1] !== undefined) expect(words(parts[1])).toBeLessThanOrEqual(8)
			expect(hint.text.endsWith(".")).toBe(true)
			expect(hint.text[0]).toBe(hint.text[0]?.toUpperCase())
			// never restates the label
			expect(hint.text.toLowerCase().startsWith(label.toLowerCase())).toBe(
				false,
			)
			const all = [
				hint.text,
				...(hint.learn?.rows.map(r => plain(r.text)) ?? []),
				hint.learn?.foot ?? "",
			].join(" ")
			for (const word of BANNED)
				expect(all.toLowerCase(), word).not.toMatch(
					new RegExp(`(^|\\W)${word.replace("!", "\\!")}(\\W|$)`, "i"),
				)
			for (const row of hint.learn?.rows ?? [])
				expect(words(plain(row.text)), row.term).toBeLessThanOrEqual(14)
			expect(hint.learn?.rows.length ?? 0).toBeLessThanOrEqual(4)
		})

	it("Settings and Listen share the Voice only sentence", () => {
		expect(VOICE_ONLY_SUB).toBe(LISTEN_HINTS["Voice only"]?.text)
	})
})

// The hint writing rules (docs/web/DESIGN.md, Hints) as code, over every Listen hint.
import { isValidElement, type ReactNode } from "react"
import { describe, expect, it } from "vitest"

import {
	LISTEN_HINTS,
	PLAY_ANYWAY_TEXT,
} from "../../src/features/listen/hints.ts"

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

/** A banned word or punctuation mark found in `text` (a word on word boundaries, a mark anywhere). */
function bannedIn(text: string, banned: readonly string[]): string[] {
	const lower = text.toLowerCase()
	return banned.filter(b =>
		/^\w/.test(b)
			? new RegExp(`(^|\\W)${b}(\\W|$)`, "i").test(lower)
			: lower.includes(b.toLowerCase()),
	)
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
			expect(bannedIn(all, BANNED)).toEqual([])
			for (const row of hint.learn?.rows ?? [])
				expect(words(plain(row.text)), row.term).toBeLessThanOrEqual(14)
			expect(hint.learn?.rows.length ?? 0).toBeLessThanOrEqual(4)
		})

	it("the ban catches a word and a mark wherever it sits", () => {
		expect(bannedIn("Done!", BANNED)).toEqual(["!"])
		expect(bannedIn("It is just here.", BANNED)).toEqual(["just"])
		// a banned word inside another word is not that word
		expect(bannedIn("Adjusts the level.", BANNED)).toEqual([])
		expect(bannedIn("Clicks less.", BANNED)).toEqual([])
	})

	it("Play anyway's description keeps the rules: one sentence, 15 words at most", () => {
		expect(sentences(PLAY_ANYWAY_TEXT)).toHaveLength(1)
		expect(words(PLAY_ANYWAY_TEXT)).toBeLessThanOrEqual(15)
		expect(PLAY_ANYWAY_TEXT.endsWith(".")).toBe(true)
		expect(bannedIn(PLAY_ANYWAY_TEXT, BANNED)).toEqual([])
	})
})

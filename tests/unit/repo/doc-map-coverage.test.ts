/**
 * Every code area a user can see has a page in docs/doc-map.json, and every mapped page exists.
 * Adding a directory under one of the areas below without a map entry fails here.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

interface DocMap {
	entries: { code: string[]; docs: string[] }[]
}

const map = JSON.parse(
	readFileSync(join(root, "docs/doc-map.json"), "utf8"),
) as DocMap

const prefixes = map.entries.flatMap(e => e.code)

/** Entries of `dir`, as repository paths; directories end with a slash. */
function children(dir: string, dirsOnly = false): string[] {
	return readdirSync(join(root, dir), { withFileTypes: true })
		.filter(d => (dirsOnly ? d.isDirectory() : true))
		.map(d => `${dir}/${d.name}${d.isDirectory() ? "/" : ""}`)
}

/** The code areas that must each have a page. */
function areas(): string[] {
	return [
		...children("src", true),
		"src/config.ts",
		...children("src/core"),
		...children("web/src/features", true),
		...children("packages", true),
		"cli/source/",
		"docker/",
		"Makefile",
		...children("native", true),
	]
}

describe("doc-map coverage", () => {
	it("maps every code area to a page", () => {
		const unmapped = areas().filter(a => !prefixes.some(p => a.startsWith(p)))
		expect(unmapped).toEqual([])
	})

	it("lists areas that exist", () => {
		for (const a of areas()) expect(existsSync(join(root, a)), a).toBe(true)
	})

	it("names only pages that exist", () => {
		for (const e of map.entries)
			for (const d of e.docs) expect(existsSync(join(root, d)), d).toBe(true)
	})

	it("uses only code prefixes that match something", () => {
		for (const p of prefixes) {
			const parent = p.endsWith("/") ? dirname(p.slice(0, -1)) : dirname(p)
			const name = p.slice(parent === "." ? 0 : parent.length + 1)
			const match = readdirSync(join(root, parent)).some(f =>
				`${f}/`.startsWith(name),
			)
			expect(match, p).toBe(true)
		}
	})
})

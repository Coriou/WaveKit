/**
 * The documentation checker (scripts/check-docs.mjs): link extraction, broken links in the
 * user docs, and the code-to-page map that flags stale pages.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
	brokenLinks,
	linkTargets,
	stalePages,
	userDocs,
} from "../../../scripts/check-docs.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

const MAP = {
	entries: [
		{ code: ["web/src/features/"], docs: ["docs/WEB-APP.md"] },
		{ code: ["src/api/routes/"], docs: ["docs/API.md"] },
	],
}

describe("check-docs", () => {
	it("finds Markdown and HTML targets, not those in code", () => {
		const text = [
			'[a](docs/A.md) ![b](img/b.png "title") <img src="c.svg">',
			"`[not](this.md)`",
			"```",
			"[nor](that.md)",
			"```",
		].join("\n")
		expect(linkTargets(text)).toEqual(["docs/A.md", "img/b.png", "c.svg"])
	})

	it("finds no broken link in the user docs", () => {
		const broken = userDocs(root).flatMap(f =>
			brokenLinks(f, root).map(t => `${f}: ${t}`),
		)
		expect(broken).toEqual([])
	})

	it("flags mapped code that changed without its page", () => {
		const changed = [
			"web/src/features/map/engine.ts",
			"src/api/routes/x.ts",
			"docs/API.md",
		]
		expect(stalePages(changed, MAP)).toEqual([
			{ docs: ["docs/WEB-APP.md"], code: ["web/src/features/map/engine.ts"] },
		])
	})

	it("accepts a Docs: none trailer, or one that names the page", () => {
		const changed = ["web/src/features/map/engine.ts"]
		expect(stalePages(changed, MAP, ["none"])).toEqual([])
		expect(stalePages(changed, MAP, ["docs/WEB-APP.md"])).toEqual([])
	})

	it("maps only paths that exist", () => {
		const map = JSON.parse(
			readFileSync(join(root, "docs/doc-map.json"), "utf8"),
		) as {
			entries: { code: string[]; docs: string[] }[]
		}
		for (const e of map.entries)
			for (const p of [...e.code, ...e.docs])
				expect(existsSync(join(root, p)), p).toBe(true)
	})
})

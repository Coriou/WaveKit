import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { loadUiAssets } from "../../src/api/routes/ui.js"

// The pages are served from three hand-kept lists: the status API's routes,
// the boot server's routes and the image builder's copy list. A missing entry
// only shows on a freshly flashed card, so check them against the pages.
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const UI = path.join(PKG, "ui")
const read = (file: string) => fs.readFileSync(path.join(PKG, file), "utf8")

/** Same-origin files a page or stylesheet loads, as absolute routes. */
function references(...files: string[]): string[] {
	const found = new Set<string>()
	for (const file of files)
		for (const match of read(file).matchAll(
			/(?:href|src)="([^"]+)"|url\("([^"#]+)"\)/g,
		)) {
			const ref = match[1] ?? match[2] ?? ""
			if (/^(data:|https?:|#)/.test(ref)) continue
			found.add(`/${ref.replace(/^\.?\//, "")}`)
		}
	return [...found]
}

describe("operator page assets", () => {
	it("serves every file the status page loads", () => {
		const routes = [...(loadUiAssets(UI)?.keys() ?? [])]
		expect(routes).not.toHaveLength(0)
		for (const ref of references("ui/index.html", "ui/app.css"))
			expect(routes).toContain(ref === "/index.html" ? "/" : ref)
	})

	it("serves and images every file the setup page loads", () => {
		const server = read("scripts/pi-boot-status.py")
		const routes = [...server.matchAll(/'(\/[^']*)': \('([^']+)'/g)]
		const image = read("scripts/build-pi-image.py")
		const copied = /BOOT_ASSETS = \(([^)]*)\)/.exec(image)?.[1] ?? ""
		for (const ref of references("ui/boot.html", "ui/boot.css", "ui/app.css"))
			expect(routes.map(r => r[1])).toContain(ref)
		for (const [, , file] of routes) expect(copied).toContain(`'${file}'`)
	})

	it("keeps vendored brand files identical to the recorded copies", () => {
		const readme = read("ui/brand/README.md")
		const hashes = [...readme.matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)]
		expect(hashes.length).toBeGreaterThan(0)
		for (const [, hash, file] of hashes) {
			const body = fs.readFileSync(path.join(UI, "brand", file ?? ""))
			expect(createHash("sha256").update(body).digest("hex")).toBe(hash)
		}
	})
})

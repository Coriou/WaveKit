import { fileURLToPath } from "node:url"
import { build } from "vite"
import { describe, expect, it } from "vitest"
import { CACHE_PREFIX } from "../../src/pwa/sw-policy.ts"

const webRoot = fileURLToPath(new URL("../../", import.meta.url))

interface Chunk {
	fileName: string
	code: string
}

/** `vite build` in memory under `nodeEnv`; the JavaScript it emits. */
async function bundle(nodeEnv: string): Promise<Chunk[]> {
	const before = process.env["NODE_ENV"]
	process.env["NODE_ENV"] = nodeEnv
	try {
		const result = await build({
			root: webRoot,
			logLevel: "silent",
			build: { write: false, sourcemap: false },
		})
		const outputs = Array.isArray(result) ? result : [result]
		const chunks: Chunk[] = []
		for (const output of outputs) {
			if (!("output" in output)) continue
			for (const file of output.output)
				if (file.type === "chunk")
					chunks.push({ fileName: file.fileName, code: file.code })
		}
		return chunks
	} finally {
		if (before === undefined) delete process.env["NODE_ENV"]
		else process.env["NODE_ENV"] = before
	}
}

// The dev server removes a service worker left on its address (src/pwa/stale.ts). In a bundle that
// code would unregister the app's own worker and delete its caches for every user.
describe("a bundle never removes service workers", () => {
	it.each(["production", "test", "development"])(
		"built under NODE_ENV=%s",
		async nodeEnv => {
			const chunks = await bundle(nodeEnv)
			expect(chunks.length).toBeGreaterThan(1)
			const page = chunks.filter(c => c.fileName !== "sw.js")
			// stale.ts's calls: listing the registrations, and the shell caches' prefix
			expect(
				page
					.filter(c => c.code.includes("getRegistrations"))
					.map(c => c.fileName),
			).toEqual([])
			expect(
				page.filter(c => c.code.includes(CACHE_PREFIX)).map(c => c.fileName),
			).toEqual([])
			// the worker itself is still built, and it is the only holder of the prefix
			expect(
				chunks.find(c => c.fileName === "sw.js")?.code.includes(CACHE_PREFIX),
			).toBe(true)
		},
		300_000,
	)
})

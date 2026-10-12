import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createRegionalRegistry } from "../../../src/core/regional/registry.js"
import { createRegionalRegistration } from "../../../src/core/regional/data.js"

const root = resolve(import.meta.dirname, "../../..")
const preserved = [
	[
		"src/decoders/band-region.ts",
		5881,
		"63c91216445c10312257045087cb58fc09ff6173b17e594a05316f5d8a4eb306",
	],
	[
		"src/decoders/band-defaults.ts",
		7912,
		"cfa8f532698a254ec51eff0e02e4c2bb5b8db0e78483dc215a89adf22fe043bd",
	],
	[
		"src/core/scanner/bandplan/index.ts",
		3651,
		"9c64cdaadc08fada6f4c5ce8b3d711edf9b86a5c9ee53db0e1ff110a91e7c1a7",
	],
	[
		"src/core/scanner/bandplan/builtin.ts",
		4270,
		"a147b79cdbfbb7fa07c38473a2ee5b68fca495f6648dd7a26cf509de4524a619",
	],
] as const

// Feature: regional-display-registry, Property 6: Isolation
// Validates: Requirements 1.5, 4.3
// Static dependency confinement supplements executable pure reads. This is not
// a copy of the operational modules or a claimed hardware qualification.
describe("regional operational isolation", () => {
	it.each(preserved)(
		"preserves exact legacy blob %s",
		(path, bytes, sha256) => {
			const actual = readFileSync(resolve(root, path))
			expect(actual.byteLength).toBe(bytes)
			expect(createHash("sha256").update(actual).digest("hex")).toBe(sha256)
		},
	)
	it("confines runtime imports to validators, crypto, errors and the regional modules", () => {
		const allow = new Set([
			"node:crypto",
			"node:util",
			"zod",
			"../../utils/errors.js",
			"./types.js",
			"@wavekit/api-types",
		])
		for (const path of ["types.ts", "registry.ts", "data.ts"]) {
			const source = readFileSync(
				resolve(root, "src/core/regional", path),
				"utf8",
			)
			const imports = [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map(
				match => match[1],
			)
			expect(imports.length).toBeGreaterThan(0)
			for (const name of imports) expect(allow.has(name!)).toBe(true)
			expect(source).not.toMatch(
				/\bimport\s*\(|\brequire\s*\(|\bprocess\s*\.|\bfetch\s*\(|\bset(?:Timeout|Interval)\s*\(/,
			)
		}
	})
	it("all production provider operations leave the operational blobs unchanged", () => {
		const before = preserved.map(([path]) => readFileSync(resolve(root, path)))
		const registry = createRegionalRegistry(
			createRegionalRegistration({ code: "EU", source: "default" }),
		)
		for (const region of ["EU", "US", "CA", "AU", "NZ", "JP", "CN"] as const) {
			registry.listFamilies(region)
			registry.listChannels({ region, family: "frs", offset: 1024, limit: 128 })
			registry.resolveAlias({ region, family: "frs", alias: "test" })
		}
		for (let index = 0; index < preserved.length; index++)
			expect(readFileSync(resolve(root, preserved[index]![0]))).toEqual(
				before[index],
			)
	})
})

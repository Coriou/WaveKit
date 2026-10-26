import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { transition } from "../../../src/core/bandplans/domain.js"
import { projectBuiltinPacks } from "../../../src/core/bandplans/builtin-packs.js"
import { resolveBandPlans } from "../../../src/core/bandplans/resolve.js"
import type { DomainContext } from "../../../src/core/bandplans/contract.js"

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
		3800,
		"2fc7ea5c676784a444124e2415784edcad88aeb98fce2873f91ba599d4bb307d",
	],
	[
		"src/core/scanner/bandplan/builtin.ts",
		7171,
		"28ef63402d2c4ae4abd9cb4f136d10dc816f936681f8711c5cab3ec6e2ba8809",
	],
] as const

const allowedImports = new Set([
	"node:crypto",
	"node:util",
	"zod",
	"@wavekit/api-types",
	"../../utils/errors.js",
	"../scanner/bandplan/index.js",
	"../scanner/bandplan/builtin.js",
	"../scanner/types.js",
	"./contract.js",
	"./builtin-packs.js",
	"./builtin-supplement.js",
	"./resolve.js",
	"./domain.js",
	"./presets.js",
	"./scanner-feed.js",
	"./group-map.js",
	"../contract.js",
])
// Composition and durable storage may add these; pure modules may not.
const ioOnlyImports = new Set([
	"node:fs",
	"node:fs/promises",
	"node:path",
	"../../utils/lock-owner.js",
	"../../utils/logger.js",
	"./storage.js",
	"./service.js",
	"./import/sdrpp.js",
	"./import/sdrsharp.js",
	"./import/gqrx.js",
	// WG6: the barrel wires the URL-import update diff (a pure module) into the service.
	"./import/update-diff.js",
])
const ioModules = new Set(["index.ts", "service.ts", "storage.ts"])

// Feature: band-plans, Property 15: Authority isolation
// Validates: Requirements 1.1, 10.2
// Feature: band-plans, Property 14: Projection fidelity
// Validates: Requirements 1.3, 2.4
describe("band plan authority isolation", () => {
	it.each(preserved)(
		"preserves exact legacy blob %s",
		(path, bytes, sha256) => {
			const actual = readFileSync(resolve(root, path))
			expect(actual.byteLength).toBe(bytes)
			expect(createHash("sha256").update(actual).digest("hex")).toBe(sha256)
		},
	)

	it("confines src/core/bandplans imports to the scanner bandplan modules and types", () => {
		const dir = resolve(root, "src/core/bandplans")
		const files = readdirSync(dir, {
			recursive: true,
			encoding: "utf8",
		}).filter(name => name.endsWith(".ts"))
		expect(files.length).toBeGreaterThan(0)
		for (const file of files) {
			const source = readFileSync(resolve(dir, file), "utf8")
			const imports = [
				...source.matchAll(/\b(?:from|import)\s+"([^"]+)"/g),
			].map(match => match[1]!)
			expect(imports.length).toBeGreaterThan(0)
			const io = ioModules.has(file)
			for (const specifier of imports)
				expect(
					allowedImports.has(specifier) || (io && ioOnlyImports.has(specifier)),
					`${file} imports ${specifier}`,
				).toBe(true)
			if (io) continue
			expect(source).not.toMatch(
				/\bimport\s*\(|\brequire\s*\(|\bprocess\s*\.|\bfetch\s*\(|\bset(?:Timeout|Interval)\s*\(/,
			)
		}
	})

	it("keeps every projected citation URL literally present in builtin.ts", () => {
		const source = readFileSync(
			resolve(root, "src/core/scanner/bandplan/builtin.ts"),
			"utf8",
		)
		const urls = new Set<string>()
		for (const pack of projectBuiltinPacks()) {
			for (const band of pack.bands) {
				if (band.provenance.kind !== "builtin-cited") continue
				for (const citation of band.provenance.citations) urls.add(citation.url)
			}
		}
		expect(urls.size).toBeGreaterThan(0)
		for (const url of urls) expect(source).toContain(url)
	})

	it("leaves the pinned blobs unchanged after projection, resolution and transition", () => {
		const before = preserved.map(([path]) => readFileSync(resolve(root, path)))
		const packs = projectBuiltinPacks()
		resolveBandPlans({
			packs: new Map(packs.map(pack => [pack.id, pack])),
			stack: [{ packId: "builtin-eu", enabled: true }],
			operatorBands: [],
			edits: [],
		})
		const context: DomainContext = {
			region: "EU",
			now: () => "2026-01-02T00:00:00.000Z",
			uuid: () => "00000000-0000-4000-8000-000000000002",
			randomHex12: () => "0123456789ab",
		}
		transition(
			{
				version: 1,
				storeId: "00000000-0000-4000-8000-0000000000aa",
				revision: 0,
				stack: null,
				importedPacks: [],
				operatorBands: [],
				edits: [],
				presets: [],
			},
			{
				type: "patch-band-edit",
				expected: {
					storeId: "00000000-0000-4000-8000-0000000000aa",
					revision: 0,
				},
				packId: "builtin-eu",
				bandId: "airband",
				set: { name: "Air" },
				reset: [],
			},
			context,
			null,
		)
		for (let index = 0; index < preserved.length; index += 1)
			expect(readFileSync(resolve(root, preserved[index]![0]))).toEqual(
				before[index],
			)
	})
})

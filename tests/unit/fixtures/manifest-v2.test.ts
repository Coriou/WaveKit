import { existsSync, readFileSync } from "node:fs"
import { describe, it, expect } from "vitest"
import {
	loadManifest,
	parseManifest,
} from "../../integration/fixtures/manifest.js"

const sha = "a".repeat(64)
function golden(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: "own_ais_162m_2048k",
		role: "channelizer-golden",
		decoder: "ais-catcher",
		license: "private",
		provenance: { notes: "own capture" },
		fetch: { kind: "private" },
		file: "raw/own_ais_162m_2048k.cu8",
		sha256: sha,
		format: "cu8",
		sample_rate: 2_048_000,
		center_hz: 162_000_000,
		duration_s: 20.5,
		expected: {
			min_count: 3,
			payloads: [{ mmsi: "211234560" }],
			key_fields: ["mmsi"],
		},
		...overrides,
	}
}
function manifest(fixtures: unknown[], candidates: unknown[] = []): string {
	return JSON.stringify({ version: 2, fixtures, candidates }) // JSON is valid YAML
}

describe("fixture manifest v2", () => {
	it("accepts a well-formed channelizer golden", () => {
		const m = parseManifest(manifest([golden()]))
		expect(m.fixtures[0]?.playback_speed).toBe(1)
		expect(m.fixtures[0]?.large).toBe(false)
	})
	it("rejects duplicate ids across fixtures and candidates", () => {
		const candidate = {
			id: "own_ais_162m_2048k",
			decoder: "x",
			url: null,
			license: null,
			blockers: ["dup"],
		}
		expect(() => parseManifest(manifest([golden()], [candidate]))).toThrow(
			/duplicate id/,
		)
	})
	it("rejects null sample rates and bad sha256", () => {
		expect(() =>
			parseManifest(manifest([golden({ sample_rate: null })])),
		).toThrow()
		expect(() => parseManifest(manifest([golden({ sha256: "ABC" })]))).toThrow()
	})
	it("requires a channelizer golden to be cu8 >= 2.048 Msps with a centre and key fields", () => {
		expect(() =>
			parseManifest(manifest([golden({ sample_rate: 1_024_000 })])),
		).toThrow(/channelizer golden/)
		expect(() =>
			parseManifest(manifest([golden({ center_hz: undefined })])),
		).toThrow(/channelizer golden/)
		expect(() =>
			parseManifest(
				manifest([golden({ expected: { min_count: 1, payloads: [] } })]),
			),
		).toThrow(/key_fields/)
	})
	it("ties the private license to private fetch", () => {
		expect(() =>
			parseManifest(manifest([golden({ license: "CC-BY-4.0" })])),
		).toThrow(/private/)
	})
	it("requires negative fixtures to expect zero decodes", () => {
		expect(() =>
			parseManifest(
				manifest([
					golden({
						role: "negative",
						expected: { min_count: 1, payloads: [] },
					}),
				]),
			),
		).toThrow(/negative/)
	})
	it("accepts a generated fixture that names its recipe (channelizer T7a)", () => {
		const m = parseManifest(
			manifest([
				golden({
					license: "composed: synthetic (WaveKit, AGPL-3.0-or-later)",
					fetch: {
						kind: "generated",
						recipe: "recipes/own_ais_162m_2048k.json",
					},
				}),
			]),
		)
		expect(m.fixtures[0]?.fetch).toEqual({
			kind: "generated",
			recipe: "recipes/own_ais_162m_2048k.json",
		})
	})
	it("rejects a generated fixture with a stray recipe path, extra keys or a private license", () => {
		const generated = (fetch: Record<string, unknown>, license = "CC0-1.0") =>
			manifest([golden({ license, fetch: { kind: "generated", ...fetch } })])
		expect(() => parseManifest(generated({ recipe: "../x.json" }))).toThrow()
		expect(() =>
			parseManifest(generated({ recipe: "recipes/x.yaml" })),
		).toThrow()
		expect(() =>
			parseManifest(
				generated({ recipe: "recipes/x.json", url: "https://x.test/a" }),
			),
		).toThrow()
		expect(() =>
			parseManifest(generated({ recipe: "recipes/x.json" }, "private")),
		).toThrow(/private/)
	})
	it("validates the committed manifest", () => {
		expect(() => loadManifest("fixtures/manifest.yaml")).not.toThrow()
	})
	it("keeps every committed generated fixture in step with its recipe", () => {
		const generated = loadManifest("fixtures/manifest.yaml").fixtures.filter(
			f => f.fetch.kind === "generated",
		)
		expect(generated.length).toBeGreaterThan(0)
		for (const f of generated) {
			if (f.fetch.kind !== "generated") continue
			const path = `fixtures/${f.fetch.recipe}`
			expect(existsSync(path), path).toBe(true)
			const recipe = JSON.parse(readFileSync(path, "utf8")) as {
				id: string
				sampleRate: number
				centerHz: number
				durationS: number
			}
			expect(f.file, f.id).toBe(`raw/${recipe.id}.cu8`)
			expect(f.format, f.id).toBe("cu8")
			expect(f.sample_rate, f.id).toBe(recipe.sampleRate)
			expect(f.center_hz, f.id).toBe(recipe.centerHz)
			expect(f.duration_s, f.id).toBe(recipe.durationS)
		}
	})
	it("points every composed fixture's channel options at a recipe component (channelizer T7c)", () => {
		const fixtures = loadManifest("fixtures/manifest.yaml").fixtures
		const byId = new Map(fixtures.map(f => [f.id, f]))
		for (const f of fixtures) {
			if (f.fetch.kind !== "generated") continue
			const recipe = JSON.parse(
				readFileSync(`fixtures/${f.fetch.recipe}`, "utf8"),
			) as { centerHz: number; components: { offsetHz: number }[] }
			const offsets = recipe.components.map(c => c.offsetHz)
			const absolute = offsets.map(o => recipe.centerHz + o)
			const o = f.decoder_options
			if (o["offsetHz"] !== undefined)
				expect(offsets, f.id).toContain(o["offsetHz"])
			for (const hz of (o["frequencies"] as number[] | undefined) ?? [])
				expect(absolute, f.id).toContain(hz)
		}
		for (const id of ["composed_ais_162m_2048k", "composed_ais_162m_2400k"])
			expect(byId.get(id)?.decoder_options["channelHz"], id).toBe(162_000_000)
		const vdl2 = byId.get("composed_vdl2_136800k_2048k")
		expect(vdl2?.decoder).toBe("dumpvdl2")
		expect(vdl2?.role).toBe("channelizer-golden")
		expect(vdl2?.decoder_options["frequencies"]).toEqual([
			136_725_000, 136_875_000, 136_975_000,
		])
		const dmr = byId.get("composed_dmr_446m_2048k")
		expect(dmr?.decoder).toBe("dsd-fme")
		expect(dmr?.role).toBe("channelizer-golden")
		expect(dmr?.decoder_options).toEqual({ offsetHz: 6000 })
		expect(dmr?.expected).toEqual({
			min_count: 1,
			payloads: [],
			output_types: ["call_start"],
			key_fields: ["talkgroup", "source"],
		})
	})
})

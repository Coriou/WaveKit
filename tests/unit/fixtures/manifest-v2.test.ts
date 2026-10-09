import { describe, it, expect } from "vitest"
import { parseManifest } from "../../integration/fixtures/manifest.js"

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
	it("validates the committed manifest", async () => {
		const { loadManifest } =
			await import("../../integration/fixtures/manifest.js")
		expect(() => loadManifest("fixtures/manifest.yaml")).not.toThrow()
	})
})

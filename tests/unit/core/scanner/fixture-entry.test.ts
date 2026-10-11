import { describe, expect, it } from "vitest"
import { FixtureSchema } from "../../../../src/core/fixtures/manifest-schema.js"
import {
	buildFixtureEntry,
	type CaptureFacts,
} from "../../../../src/core/scanner/evidence/fixture-entry.js"
import * as manifestModule from "../../../integration/fixtures/manifest.js"

const facts = (over: Partial<CaptureFacts> = {}): CaptureFacts => ({
	id: "cap_01j9z8x7w6v5u4t3s2r1q0p9n8",
	mode: "wideband",
	sampleRateHz: 2_048_000,
	sourceCentreHz: 446_187_750,
	targetHz: 446_193_750,
	durationS: 12.5,
	sha256: "a".repeat(64),
	bytes: 51_200_000,
	decoderType: "dsd-fme",
	decoderOptions: { mode: "auto" },
	protocol: "dmr",
	decoded: true,
	metadata: {
		talkgroups: ["9"],
		sources: ["2060945"],
		capcodes: [],
		callsigns: [],
		ismModels: [],
	},
	identity: { kind: "dmr-cc", value: "1" },
	jobId: "j_1",
	sourceId: "rtl",
	createdAt: "2026-10-09T12:00:00.000Z",
	...over,
})

describe("buildFixtureEntry", () => {
	it("builds a channelizer golden for a decoded wideband DMR capture", () => {
		const e = buildFixtureEntry(facts())
		expect(e).toEqual({
			id: "cap_01j9z8x7w6v5u4t3s2r1q0p9n8",
			role: "channelizer-golden",
			decoder: "dsd-fme",
			decoder_options: { mode: "auto" },
			license: "private",
			provenance: { notes: expect.stringContaining("job j_1") },
			fetch: { kind: "private" },
			file: "raw/cap_01j9z8x7w6v5u4t3s2r1q0p9n8.cu8",
			sha256: "a".repeat(64),
			format: "cu8",
			sample_rate: 2_048_000,
			center_hz: 446_187_750,
			duration_s: 12.5,
			playback_speed: 1,
			large: false,
			expected: {
				min_count: 1,
				payloads: [{ talkgroup: 9, source: 2060945 }],
				key_fields: ["talkgroup", "source"],
			},
			channel: { center_hz: 446_193_750 },
		})
		expect(FixtureSchema.parse(e)).toEqual(e)
	})

	it("makes channel captures and undecoded captures tail goldens", () => {
		const ch = buildFixtureEntry(
			facts({ mode: "channel", sampleRateHz: 51_200, bytes: 1_280_000 }),
		)
		expect(ch).toMatchObject({
			role: "tail-golden",
			sample_rate: 51_200,
			center_hz: 446_193_750,
		})
		expect(ch).not.toHaveProperty("channel")
		const raw = buildFixtureEntry(
			facts({
				decoded: false,
				metadata: {
					talkgroups: [],
					sources: [],
					capcodes: [],
					callsigns: [],
					ismModels: [],
				},
			}),
		)
		expect(raw).toMatchObject({
			role: "tail-golden",
			expected: { min_count: 0, payloads: [] },
		})
		const pager = buildFixtureEntry(
			facts({
				decoderType: "multimon-ng",
				protocol: "pocsag",
				identity: { kind: "pocsag-capcode", value: "1234567" },
				metadata: {
					talkgroups: [],
					sources: [],
					capcodes: ["1234567"],
					callsigns: [],
					ismModels: [],
				},
			}),
		)
		expect(pager.expected).toEqual({
			min_count: 1,
			payloads: [{ capcode: "1234567" }],
			key_fields: ["capcode"],
		})
	})

	it("rejects ids and hashes the manifest would reject", () => {
		expect(() => buildFixtureEntry(facts({ id: "Cap-1" }))).toThrow()
		expect(() => buildFixtureEntry(facts({ sha256: "XYZ" }))).toThrow()
	})

	it("validates with the fixture manifest's own schema object (one schema, no copy)", () => {
		expect(manifestModule.FixtureSchema).toBe(FixtureSchema)
		for (const f of [
			facts(),
			facts({ mode: "channel", sampleRateHz: 51_200 }),
			facts({ decoded: false }),
		]) {
			const e = buildFixtureEntry(f)
			expect(manifestModule.FixtureSchema.parse(e)).toEqual(e)
		}
	})
})

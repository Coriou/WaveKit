import { RECEIVER_SAMPLE_RATE_PRESETS_HZ } from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import { createReceiverCapabilitiesProvider } from "../../../src/core/tuner-capabilities/provider.js"
import { RECEIVER_CONTROL_METADATA } from "../../../src/core/tuner-capabilities/rtl-tcp.js"
import {
	RECEIVER_CAPABILITIES_LIMITS,
	receiverCapabilitiesPageSchema,
	receiverCapabilitiesSchema,
} from "../../../src/core/tuner-capabilities/types.js"
import type {
	ReceiverRestCommandPolicy,
	SourceReceiverEvidence,
} from "../../../src/core/tuner-capabilities/types.js"

const now = Date.UTC(2026, 0, 2)
const token = (value: number) => value.toString(16).padStart(32, "0")
// The sampleRate command's validated ranges (src/core/tuner-controller.ts).
const RANGES = [
	{ min: 225_001, max: 300_000 },
	{ min: 900_001, max: 3_200_000 },
] as const

function policy(): ReceiverRestCommandPolicy {
	return RECEIVER_CONTROL_METADATA.map(row => {
		const base = { id: row.id, unit: row.unit, opcode: row.opcode }
		if (row.kind === "boolean")
			return { ...base, rule: { kind: "boolean" as const } }
		if (row.kind === "uint16-pair")
			return { ...base, rule: { kind: "uint16-pair" as const } }
		if (row.kind === "enum")
			return {
				...base,
				rule: {
					kind: "enum" as const,
					values: row.id === "gainMode" ? ["manual", "agc"] : ["off", "i", "q"],
				},
			}
		if (row.kind === "integer-ranges")
			return {
				...base,
				rule: { kind: "integer-ranges" as const, ranges: RANGES },
			}
		return {
			...base,
			rule: {
				kind: "integer-range" as const,
				min: row.id === "ppm" ? -10 : 1,
				max: 100,
			},
		}
	})
}

function evidence(
	type: "rtl_tcp" | "sdrpp-network" | "recording",
	sourceId = "s",
): SourceReceiverEvidence {
	const rtl = type === "rtl_tcp"
	const bytes = Buffer.alloc(12)
	bytes.set([0x52, 0x54, 0x4c, 0x30])
	return {
		sourceId,
		sourceStateToken: {},
		sourceIncarnation: token(1),
		sessionId: type === "recording" ? null : token(2),
		snapshotId: token(3),
		capturedAt: now,
		source: {
			type,
			kind: type === "recording" ? "recording" : "iq",
			format: "U8_IQ",
		},
		caps: { sampleRate: 1_000_000, centerFreq: 100_000_000 },
		connection: "connected",
		delivery: {
			state: "streaming",
			lastSampleAt: now - 10,
			sampleAgeMs: 10,
			timeoutMs: 10000,
		},
		header: rtl
			? { capture: "complete", bytes, capturedAt: now - 100 }
			: { capture: "not-applicable", bytes: null, capturedAt: null },
	} as SourceReceiverEvidence
}

function item(type: "rtl_tcp" | "sdrpp-network" | "recording") {
	const ev = evidence(type)
	const provider = createReceiverCapabilitiesProvider(
		{
			read: () => ({ kind: "present", evidence: ev }),
			readPage: () => ({
				kind: "candidates",
				candidates: [ev],
				capturedAt: now,
				snapshotId: token(3),
			}),
		},
		policy(),
	)
	const r = provider.get("s")
	if (!r.ok) throw new Error(`provider failed: ${r.code}`)
	return r.value
}

describe("receiver sample-rate presets", () => {
	it("rtl_tcp is suggested with the 11 frozen rates", () => {
		const p = item("rtl_tcp").sampleRatePresets
		expect(p).toEqual({
			state: "suggested",
			provenance: "wavekit-rtl-rate-presets",
			valuesHz: [...RECEIVER_SAMPLE_RATE_PRESETS_HZ],
		})
		expect(RECEIVER_SAMPLE_RATE_PRESETS_HZ).toHaveLength(11)
	})

	it("every rate lies inside the item's sampleRate validation ranges", () => {
		const control = item("rtl_tcp").controls.find(c => c.id === "sampleRate")
		const rule = control?.command.validation.rule
		if (rule?.kind !== "integer-ranges") throw new Error("expected ranges")
		for (const hz of RECEIVER_SAMPLE_RATE_PRESETS_HZ)
			expect(
				rule.ranges.some(r => hz >= r.min && hz <= r.max),
				String(hz),
			).toBe(true)
	})

	it.each(["sdrpp-network", "recording"] as const)(
		"%s is not-applicable",
		type => {
			expect(item(type).sampleRatePresets).toEqual({
				state: "not-applicable",
				reason: "non-rtl-transport",
			})
		},
	)

	it("the field is always present", () => {
		for (const t of ["rtl_tcp", "sdrpp-network", "recording"] as const)
			expect(item(t)).toHaveProperty("sampleRatePresets")
	})

	it("schema rejects hostile values", () => {
		const good = item("rtl_tcp")
		const bad = (v: unknown) =>
			receiverCapabilitiesSchema.safeParse({ ...good, sampleRatePresets: v })
				.success
		const ok = {
			state: "suggested",
			provenance: "wavekit-rtl-rate-presets",
			valuesHz: [250_000],
		}
		expect(bad(ok)).toBe(true)
		expect(bad({ ...ok, provenance: "other" })).toBe(false)
		expect(bad({ ...ok, extra: 1 })).toBe(false)
		expect(bad({ ...ok, valuesHz: Array.from({ length: 12 }, () => 1) })).toBe(
			false,
		)
		expect(bad({ ...ok, valuesHz: [1.5] })).toBe(false)
		expect(bad({ state: "not-applicable", reason: "x" })).toBe(false)
		expect(
			receiverCapabilitiesSchema.safeParse({
				...good,
				sampleRatePresets: undefined,
			}).success,
		).toBe(false)
	})

	it("worst-case item and page stay within the byte bounds", () => {
		const worst = {
			...item("rtl_tcp"),
			sampleRatePresets: {
				state: "suggested" as const,
				provenance: "wavekit-rtl-rate-presets" as const,
				valuesHz: Array.from({ length: 11 }, () => Number.MAX_SAFE_INTEGER),
			},
		}
		const itemBytes = Buffer.byteLength(JSON.stringify(worst), "utf8")
		expect(itemBytes).toBeLessThanOrEqual(
			RECEIVER_CAPABILITIES_LIMITS.itemBytes,
		)
		const page = {
			schemaVersion: 1 as const,
			items: Array.from(
				{ length: RECEIVER_CAPABILITIES_LIMITS.pageLimit },
				() => worst,
			),
			nextAfter: null,
		}
		expect(receiverCapabilitiesPageSchema.safeParse(page).success).toBe(true)
		expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
			RECEIVER_CAPABILITIES_LIMITS.pageBytes,
		)
		console.info
	})
})

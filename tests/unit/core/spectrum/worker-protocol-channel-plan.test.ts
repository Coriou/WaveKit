import { describe, expect, it } from "vitest"
import {
	CHANNEL_GATE_MAX_SLOTS,
	CHANNEL_GATE_MAX_WIDTH_HZ,
	CHANNEL_GATE_MIN_WIDTH_HZ,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import {
	MainToWorkerSchema,
	PipelineInputSchema,
} from "../../../../src/core/spectrum/worker-protocol.js"

function entry(
	over: Partial<{
		startHz: number
		endHz: number
		widthHz: number
		rasterHz: number | null
		firstChannelHz: number | null
	}> = {},
) {
	return {
		startHz: 0,
		endHz: 1,
		widthHz: 12_500,
		rasterHz: null,
		firstChannelHz: null,
		burst: false,
		rangeKey: "k",
		...over,
	}
}

function plan(n: number, over: Partial<{ defaultWidthHz: number }> = {}) {
	return {
		sourceId: "s1",
		defaultWidthHz: 12_500,
		entries: Array.from({ length: n }, (_, i) =>
			entry({ startHz: i, endHz: i + 1 }),
		),
		...over,
	}
}

function input(body: unknown) {
	return { kind: "channel-plan", plan: body }
}

describe("channel-plan worker input", () => {
	it("accepts 4096 entries and rejects 4097", () => {
		expect(
			PipelineInputSchema.safeParse(input(plan(CHANNEL_GATE_MAX_SLOTS)))
				.success,
		).toBe(true)
		expect(
			PipelineInputSchema.safeParse(input(plan(CHANNEL_GATE_MAX_SLOTS + 1)))
				.success,
		).toBe(false)
	})

	it("accepts a null plan that clears the gate", () => {
		expect(PipelineInputSchema.safeParse(input(null)).success).toBe(true)
		expect(
			MainToWorkerSchema.safeParse({ type: "input", input: input(null) })
				.success,
		).toBe(true)
	})

	it("rejects non-finite numbers", () => {
		expect(PipelineInputSchema.safeParse(input(plan(1, {}))).success).toBe(true)
		for (const bad of [
			input(plan(1, { defaultWidthHz: Number.NaN })),
			input(plan(1, { defaultWidthHz: Number.POSITIVE_INFINITY })),
			input({ ...plan(1), entries: [entry({ startHz: Number.NaN })] }),
			input({
				...plan(1),
				entries: [entry({ widthHz: Number.POSITIVE_INFINITY })],
			}),
			input({
				...plan(1),
				entries: [entry({ rasterHz: Number.POSITIVE_INFINITY })],
			}),
			input({
				...plan(1),
				entries: [entry({ firstChannelHz: Number.NEGATIVE_INFINITY })],
			}),
		])
			expect(PipelineInputSchema.safeParse(bad).success).toBe(false)
	})

	it("rejects startHz that is not below endHz", () => {
		expect(
			PipelineInputSchema.safeParse(
				input({ ...plan(0), entries: [entry({ startHz: 10, endHz: 10 })] }),
			).success,
		).toBe(false)
		expect(
			PipelineInputSchema.safeParse(
				input({ ...plan(0), entries: [entry({ startHz: 11, endHz: 10 })] }),
			).success,
		).toBe(false)
		expect(
			MainToWorkerSchema.safeParse({
				type: "input",
				input: input({
					...plan(0),
					entries: [entry({ startHz: 4, endHz: 4 })],
				}),
			}).success,
		).toBe(false)
	})

	it("rejects widths outside [6250, 200000] and accepts the endpoints", () => {
		expect(
			PipelineInputSchema.safeParse(
				input({
					...plan(0),
					entries: [entry({ widthHz: CHANNEL_GATE_MIN_WIDTH_HZ - 0.1 })],
				}),
			).success,
		).toBe(false)
		expect(
			PipelineInputSchema.safeParse(
				input({
					...plan(0),
					entries: [entry({ widthHz: CHANNEL_GATE_MAX_WIDTH_HZ + 0.1 })],
				}),
			).success,
		).toBe(false)
		expect(
			PipelineInputSchema.safeParse(
				input(plan(1, { defaultWidthHz: CHANNEL_GATE_MIN_WIDTH_HZ - 0.1 })),
			).success,
		).toBe(false)
		expect(
			PipelineInputSchema.safeParse(
				input({
					...plan(0),
					entries: [entry({ widthHz: CHANNEL_GATE_MIN_WIDTH_HZ })],
				}),
			).success,
		).toBe(true)
		expect(
			PipelineInputSchema.safeParse(
				input({
					...plan(0),
					entries: [entry({ widthHz: CHANNEL_GATE_MAX_WIDTH_HZ })],
				}),
			).success,
		).toBe(true)
		expect(
			MainToWorkerSchema.safeParse({
				type: "input",
				input: input(plan(CHANNEL_GATE_MAX_SLOTS)),
			}).success,
		).toBe(true)
	})
})

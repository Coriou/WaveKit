import Fastify from "fastify"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { receiverCapabilitiesRoutes } from "../../../src/api/routes/receiver-capabilities.js"
import { createReceiverCapabilitiesProvider } from "../../../src/core/tuner-capabilities/provider.js"
import { TUNER_REST_COMMAND_POLICY } from "../../../src/core/tuner-controller.js"
import { receiverCapabilitiesSchema } from "../../../src/core/tuner-capabilities/types.js"
import type { SourceReceiverEvidence } from "../../../src/core/tuner-capabilities/types.js"
import type { ReceiverIqDelivery } from "@wavekit/api-types"

function fixture(id = "test+source"): SourceReceiverEvidence {
	return {
		sourceId: id,
		sourceStateToken: {},
		sourceIncarnation: "1".padStart(32, "0"),
		sessionId: null,
		snapshotId: "2".padStart(32, "0"),
		capturedAt: Date.UTC(2026, 0, 1),
		source: { type: "rtl_tcp", kind: "iq", format: "U8_IQ" },
		caps: { sampleRate: 1000000, centerFreq: null },
		connection: "disconnected",
		delivery: {
			state: "disconnected",
			lastSampleAt: null,
			sampleAgeMs: null,
			timeoutMs: 10000,
		},
		header: { capture: "missing", bytes: null, capturedAt: null },
	}
}

function provider(
	hook?: (sourceId: string) => Omit<ReceiverIqDelivery, "resolved"> | null,
) {
	const value = fixture("test-source")
	return createReceiverCapabilitiesProvider(
		{
			read: () => ({ kind: "present", evidence: value }),
			readPage: () => ({
				kind: "candidates",
				candidates: [value],
				capturedAt: value.capturedAt,
				snapshotId: value.snapshotId,
			}),
		},
		TUNER_REST_COMMAND_POLICY,
		hook,
	)
}

describe("receiver IQ delivery", () => {
	// Feature: link-burst-resilience, Property 14: Delivery hook (resolution half)
	// Validates: Requirements 7.1, 7.2, 7.3
	it("echoes delivery evidence and always resolves raw", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("raw" as const, "auto" as const),
				fc.option(
					fc.array(fc.constantFrom("raw" as const, "channels" as const)),
					{ nil: null },
				),
				(configured, advertised) => {
					const instance = provider(sourceId => {
						expect(sourceId).toBe("test-source")
						return { configured, advertised }
					})
					const expected = { configured, advertised, resolved: "raw" }
					const item = instance.get("test-source")
					expect(item.ok).toBe(true)
					if (!item.ok) return
					expect(item.value.iqDelivery).toEqual(expected)
					expect(receiverCapabilitiesSchema.safeParse(item.value).success).toBe(
						true,
					)
					const page = instance.list({ after: null, limit: 8 })
					expect(page.ok).toBe(true)
					if (page.ok) expect(page.value.items[0]?.iqDelivery).toEqual(expected)
				},
			),
			{ numRuns: 100 },
		)
	})

	it.each([
		undefined,
		() => null,
		() => {
			throw new TypeError("unavailable")
		},
	])("omits unavailable delivery evidence", hook => {
		const instance = provider(hook)
		const item = instance.get("test-source")
		expect(item.ok).toBe(true)
		if (item.ok) expect(item.value).not.toHaveProperty("iqDelivery")
		const page = instance.list({ after: null, limit: 8 })
		expect(page.ok).toBe(true)
		if (page.ok) expect(page.value.items[0]).not.toHaveProperty("iqDelivery")
	})

	it("retains delivery evidence in HTTP responses", async () => {
		const app = Fastify()
		const iqDelivery = {
			advertised: ["raw"] as const,
			configured: "auto" as const,
		}
		try {
			await app.register(receiverCapabilitiesRoutes, {
				provider: provider(() => iqDelivery),
			})
			for (const path of [
				"/api/receiver-capabilities/test-source",
				"/api/receiver-capabilities",
			]) {
				const response = await app.inject({ method: "GET", url: path })
				expect(response.statusCode).toBe(200)
				const body: unknown = response.json()
				expect(JSON.stringify(body)).toContain(
					'"iqDelivery":{"advertised":["raw"],"configured":"auto","resolved":"raw"}',
				)
			}
		} finally {
			await app.close()
		}
	})
})

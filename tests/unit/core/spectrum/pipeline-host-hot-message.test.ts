import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { hotWorkerMessage } from "../../../../src/core/spectrum/pipeline-host.js"
import { WorkerToMainSchema } from "../../../../src/core/spectrum/worker-protocol.js"

const event = (over: Record<string, unknown> = {}): unknown => ({
	kind: "stale-discard",
	epoch: 1,
	blocks: 1,
	...over,
})
const wireBins = (bins: unknown, length: number): unknown => ({
	kind: "block-summary",
	summary: { binsWire: true, bins, binsLength: length },
})

describe("hotWorkerMessage against WorkerToMainSchema", () => {
	// Feature: spectrum-main-thread, Property 4: the guard accepts only what the schema accepts
	// Validates: docs/PERFORMANCE.md rule on structural guards
	it("accepted ⇒ the schema accepts", () => {
		const member = fc.oneof(
			fc.constant(event()),
			fc.constant(wireBins(new Int16Array(4), 4)),
			fc.constant(wireBins([1, 2], 4)),
			fc.constant(wireBins(new Int16Array(4), 1e9)),
			fc.constant(null),
			fc.constant({}),
			fc.integer(),
			fc.constant(undefined),
		)
		const message = fc.oneof(
			fc.record({
				type: fc.constantFrom("events", "buffer", "error", "nope"),
				events: fc.oneof(fc.array(member, { maxLength: 4 }), fc.constant("x")),
				buffer: fc.constantFrom(new ArrayBuffer(4), "x", null),
			}),
			fc.constantFrom(null, 1, "events", undefined, []),
		)
		fc.assert(
			fc.property(message, raw => {
				const hot = hotWorkerMessage(raw)
				const schema = WorkerToMainSchema.safeParse(raw)
				if (hot !== null) expect(schema.success).toBe(true)
			}),
			{ numRuns: 1000 },
		)
	})

	it("takes both hot messages and returns the object itself", () => {
		const events = { type: "events", events: [event()] }
		expect(hotWorkerMessage(events)).toBe(events)
		const buffer = { type: "buffer", buffer: new ArrayBuffer(8) }
		expect(hotWorkerMessage(buffer)).toBe(buffer)
		const empty = { type: "events", events: [] }
		expect(hotWorkerMessage(empty)).toBe(empty)
	})

	it("leaves everything else to the schema, which still reports it", () => {
		for (const raw of [
			null,
			{ type: "events" },
			{ type: "events", events: [null] },
			{ type: "events", events: [{}] },
			{ type: "buffer", buffer: new Uint8Array(4) },
			{ type: "error", message: "boom" },
			{ type: "engine-state", requestId: 1, state: {} },
			{ type: "artefact-masks", requestId: 1, masks: { epoch: 1 } },
		])
			expect(hotWorkerMessage(raw)).toBeNull()
	})
})

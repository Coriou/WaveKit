/** WG12 ID.1 property: a waiting identify ends no-signal only when nothing gated in time. */
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import type { ScannerIdentifyEventData } from "@wavekit/api-types"
import {
	IdentifyRunner,
	normaliseIdentify,
} from "../../../../src/core/scanner/identify.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	TARGET_HZ,
	fakeInner,
	identifyRecord,
	summaryOf,
} from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync, poolHarness } from "../../../mocks/scanner/probe-fakes.js"

type Gate =
	| { kind: "none" }
	| { kind: "late" }
	| { kind: "on-time"; offset: number }

function harness(waitMs: number, timeoutMs: number, gate: Gate) {
	const settings = testSettings()
	const pool = poolHarness({ settings, cpuPercent: null })
	const record = identifyRecord()
	const events: ScannerIdentifyEventData[] = []
	const runner = new IdentifyRunner({
		record,
		identify: normaliseIdentify({
			target: { frequencyHz: TARGET_HZ },
			record: false,
			timeoutMs,
			waitUntilSignal: true,
			waitMs,
		}),
		inner: fakeInner(record, () => pool.clock.now),
		probes: pool.pool,
		engine: () => pool.engine,
		artefactAt: () => Promise.resolve(null),
		liveTracks: () => [],
		lastSummary: () => summaryOf(),
		discoveryOf: () => undefined,
		priorsAt: () => ({}),
		format: () => "U8_IQ",
		channelizer: () => false,
		settings: () => settings,
		emit: d => events.push(structuredClone(d)),
		logger: pino({ level: "silent" }),
		now: () => pool.clock.now,
		gatedAt: () => {
			const started = record.startedAt ?? pool.clock.now
			if (gate.kind === "none") return null
			const atMs =
				gate.kind === "late" ? started + waitMs + 1 : started + gate.offset
			if (pool.clock.now < atMs) return null
			return { startSample: 10, atMs }
		},
	})
	const advanceTo = async (at: number): Promise<void> => {
		pool.clock.now = at
		runner.tick(pool.clock.now)
		pool.pool.pump()
		await flushAsync()
		await flushAsync()
	}
	return {
		pool: pool.pool,
		decoders: pool.decoders,
		clock: pool.clock,
		record,
		runner,
		advanceTo,
		last: () => events.at(-1),
	}
}

describe("waiting identify ends honestly", () => {
	// Feature: scanner-redesign, Property 14: Waiting identify ends honestly
	// Validates: Requirements 6.1
	// random gated timings, waitMs, timeoutMs → no-signal iff no gated start within waitMs; else
	// trial timeout measured from the gated start. numRuns: 100
	it("property: no-signal iff no gated start within waitMs", async () => {
		const input = fc.integer({ min: 1000, max: 4000 }).chain(waitMs =>
			fc.integer({ min: 1000, max: 4000 }).chain(timeoutMs =>
				fc
					.oneof(
						fc.constant<Gate>({ kind: "none" }),
						fc.constant<Gate>({ kind: "late" }),
						fc
							.integer({ min: 0, max: waitMs })
							.map((offset): Gate => ({ kind: "on-time", offset })),
					)
					.map(gate => ({ waitMs, timeoutMs, gate })),
			),
		)
		await fc.assert(
			fc.asyncProperty(input, async ({ waitMs, timeoutMs, gate }) => {
				const h = harness(waitMs, timeoutMs, gate)
				try {
					await h.runner.start()
					const started = h.record.startedAt ?? 0
					await h.advanceTo(started + 10)
					await h.advanceTo(started + 20)
					if (gate.kind !== "on-time") {
						await h.advanceTo(started + waitMs - 1)
						expect(h.last()?.state).toBe("waiting-for-signal")
						expect(h.last()?.result?.ended).not.toBe("no-signal")
						await h.advanceTo(started + waitMs)
						expect(h.last()?.state).toBe("unidentified")
						expect(h.last()?.result?.ended).toBe("no-signal")
						expect(h.last()?.result?.protocol).toBeUndefined()
						expect(h.last()?.trials.every(t => t.outcome === "cancelled")).toBe(
							true,
						)
						expect(h.clock.now).toBe(started + waitMs)
						expect(h.decoders.created.size).toBe(0)
						return
					}
					const atMs = started + gate.offset
					if (gate.offset > 20) {
						await h.advanceTo(atMs - 1)
						expect(h.last()?.state).toBe("waiting-for-signal")
						expect(h.last()?.result?.ended).not.toBe("no-signal")
					}
					const seenAt = Math.max(atMs, started + 20)
					if (h.clock.now < seenAt) await h.advanceTo(seenAt)
					expect(h.last()?.state).toBe("waiting-for-signal")
					expect(h.last()?.result?.ended).not.toBe("no-signal")
					const trialEnd = atMs + timeoutMs
					if (h.clock.now < trialEnd - 1) {
						await h.advanceTo(trialEnd - 1)
						expect(h.last()?.state).toBe("waiting-for-signal")
						expect(h.last()?.result?.ended).not.toBe("no-signal")
					}
					await h.advanceTo(trialEnd)
					expect(h.last()?.state).toBe("unidentified")
					expect(h.last()?.result?.ended).toBeUndefined()
					expect(h.last()?.result?.protocol).toBeUndefined()
					expect(h.clock.now).toBe(trialEnd)
					expect(h.decoders.created.size).toBe(0)
				} finally {
					await h.runner.dispose()
					await h.pool.destroy()
				}
			}),
			{ numRuns: 100, seed: 14 },
		)
	}, 20_000)
})

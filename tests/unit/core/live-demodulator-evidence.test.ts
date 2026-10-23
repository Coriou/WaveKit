/**
 * Evidence squelch wiring against fake ports (docs/specs/evidence-squelch, plan W.2). Every
 * config sets `squelchMode` explicitly; the runtime default is not relied on.
 */
import { afterEach, describe, expect, it } from "vitest"
import {
	EVIDENCE_NOTE_DISCARD,
	EVIDENCE_NOTE_RESET,
} from "../../../src/core/evidence-squelch/contract.js"
import {
	capturingLogger,
	waitFor,
} from "./live-demodulator-continuity-fakes.js"
import {
	mergedCalls,
	sampleTags,
	startEvidenceHarness,
	type FakeFactoryOptions,
} from "./live-demodulator-evidence-fakes.js"

type EvidenceHarness = Awaited<ReturnType<typeof startEvidenceHarness>>

const CTCSS = { kind: "ctcss", frequencyTenthsHz: 670 }

function ramp(bytes: number, seed = 1): Buffer {
	const out = Buffer.alloc(bytes)
	for (let i = 0; i < bytes; i++) out[i] = (i * 31 + seed * 7 + 1) & 0xff
	return out
}

describe("live demodulator evidence path (fake ports)", () => {
	let e: EvidenceHarness | null = null
	afterEach(async () => {
		await e?.h.dispose()
		e = null
	})

	async function start(
		config: Record<string, unknown>,
		factory: FakeFactoryOptions = {},
		logger?: ReturnType<typeof capturingLogger>["logger"],
	): Promise<EvidenceHarness> {
		e = await startEvidenceHarness(
			config,
			factory,
			logger !== undefined ? { logger } : {},
		)
		return e
	}

	for (const squelchMode of ["manual", "auto", "noise"] as const) {
		it(`pcm event bytes unchanged and emitted before rewrite (${squelchMode})`, async () => {
			const t = await start(
				{ modulation: "nfm", squelchMode },
				{ rewrite: true },
			)
			const { transport } = t.h.addClient()
			t.stage.open = true
			const chunks = [ramp(4_001, 1), ramp(333, 2), ramp(10_000, 3)]
			for (const chunk of chunks) t.feed(Buffer.from(chunk))
			await waitFor(() => transport.chunks.length >= chunks.length)
			expect(Buffer.concat(t.pcm)).toEqual(Buffer.concat(chunks))
			const received = transport.received()
			expect(received.length).toBe(14_334)
			if (squelchMode === "auto")
				expect(received.every(b => b === 0)).toBe(true)
			else expect(received).toEqual(Buffer.concat(chunks))
		})
	}

	it("slices and tags", async () => {
		const latchAtByte = 12_345 * 2
		const t = await start(
			{ modulation: "nfm", squelchMode: "auto" },
			{ latchAtByte },
		)
		const rate = t.internals.run?.stream.rate ?? 0
		t.stage.open = true
		t.feed(Buffer.alloc(40_000))
		const preRoll = t.factory.preRolls[0]
		expect(preRoll).toBeDefined()
		expect(mergedCalls(preRoll?.calls ?? [])).toEqual([
			{ start: 0, end: latchAtByte, tag: "pending" },
			{ start: -1, end: -1, tag: "pass" },
			{ start: latchAtByte, end: 40_000, tag: "pass" },
		])
		const slice = Math.max(1, Math.round(rate / 100)) * 2
		for (const call of preRoll?.calls ?? []) {
			if (call.start < 0) continue
			expect(call.end % 2).toBe(0)
			expect(call.end - call.start).toBeLessThanOrEqual(slice)
		}
	})

	it("close guard and drop", async () => {
		const t = await start(
			{ modulation: "nfm", squelchMode: "auto" },
			{ latchAtByte: 0, guardBytes: 100 },
		)
		t.stage.open = true
		t.feed(Buffer.alloc(1_000))
		t.stage.open = false
		t.feed(Buffer.alloc(1_000))
		const calls = mergedCalls(t.factory.preRolls[0]?.calls ?? [])
		expect(calls.slice(-2)).toEqual([
			{ start: 1_000, end: 1_100, tag: "guard" },
			{ start: 1_100, end: 2_000, tag: "drop" },
		])
	})

	it("close before latch abandons and resets", async () => {
		const t = await start({ modulation: "nfm", squelchMode: "auto" })
		t.stage.open = true
		t.internals.publishSquelchChange()
		t.feed(Buffer.alloc(1_000))
		const gate = t.factory.gates[0]
		const preRoll = t.factory.preRolls[0]
		expect(gate?.ops).toEqual([])
		t.stage.open = false
		t.internals.publishSquelchChange()
		expect(gate?.ops).toEqual(["reset"])
		expect(preRoll?.ops).toEqual(["abandon"])
		t.feed(Buffer.alloc(100))
		expect(preRoll?.ops).toEqual(["abandon", "abandon"])
		expect(mergedCalls(preRoll?.calls ?? []).at(-1)).toEqual({
			start: 1_000,
			end: 1_100,
			tag: "drop",
		})
	})

	describe("noteBlock sources", () => {
		it("csdr NFM uses blockQuieted()", async () => {
			const t = await start({ modulation: "nfm", squelchMode: "auto" })
			const run = t.internals.run
			if (run === null) throw new Error("no run")
			let quieted = true
			Object.defineProperty(run.squelch, "blockQuieted", {
				configurable: true,
				value: () => quieted,
			})
			t.stage.open = true
			t.internals.measureRun(run)
			quieted = false
			t.internals.measureRun(run)
			t.stage.open = false
			t.internals.measureRun(run)
			expect(t.factory.gates[0]?.notes).toEqual([true, false])
		})

		it("Rust NFM uses sample.quieted", async () => {
			const t = await start({ modulation: "nfm", squelchMode: "auto" })
			const run = t.internals.run
			if (run === null) throw new Error("no run")
			t.stage.open = true
			t.internals.measureRun(run, { powerDbfs: -50, quieted: true })
			t.internals.measureRun(run, { powerDbfs: -50, quieted: false })
			t.stage.open = false
			t.internals.measureRun(run, { powerDbfs: -50, quieted: true })
			expect(t.factory.gates[0]?.notes).toEqual([true, false])
		})

		// Window-reset amendment (2026-10-23): the gate is the only onset tracker; the wiring
		// abandons the pre-roll exactly when noteBlock reports DISCARD (RESET alone keeps the audio).
		it("abandons the pre-roll exactly when noteBlock reports DISCARD", async () => {
			const t = await start({ modulation: "nfm", squelchMode: "auto" })
			const run = t.internals.run
			if (run === null) throw new Error("no run")
			const gate = t.factory.gates[0]
			if (gate === undefined) throw new Error("no gate")
			// Note 2: analysis reset only (short fade) -> no abandon; note 4: reset + discard.
			gate.noteFlags.set(2, EVIDENCE_NOTE_RESET)
			gate.noteFlags.set(4, EVIDENCE_NOTE_RESET | EVIDENCE_NOTE_DISCARD)
			t.stage.open = true
			for (const quieted of [false, false, true, false, true, true]) {
				Object.defineProperty(run.squelch, "blockQuieted", {
					configurable: true,
					value: () => quieted,
				})
				t.internals.measureRun(run)
			}
			expect(gate.notes).toEqual([false, false, true, false, true, true])
			expect(t.factory.preRolls[0]?.ops).toEqual(["abandon"])
		})

		// Amendment A8: AM is outside the evidence path, so no gate is fed.
		it("AM auto feeds no gate (amendment A8)", async () => {
			const t = await start({ modulation: "am", squelchMode: "auto" })
			const run = t.internals.run
			if (run === null) throw new Error("no run")
			t.stage.open = true
			run.noiseFloorDbfs = -60
			t.internals.measureRun(run, { powerDbfs: -40, quieted: true })
			expect(t.factory.gates[0]?.notes ?? []).toEqual([])
			expect(t.h.demod.getStatus().autoSquelch?.state).toBe("off")
		})
	})

	for (const format of ["s16le", "f32le"] as const) {
		it(`odd chunk sizes across edges (${format})`, async () => {
			const width = format === "s16le" ? 2 : 4
			const sizes = format === "s16le" ? [1, 3, 5] : [1, 2, 3]
			// Open → latch at sample 1 000 → stage-1 close inside a sample → guard → drop.
			const openBytes = 3_000 * width + 1
			const closedBytes = 2_000 * width - 1
			const options: FakeFactoryOptions = {
				latchAtByte: 1_000 * width,
				guardBytes: 101,
			}
			const script = ramp(openBytes + closedBytes)
			const runOnce = async (split: boolean) => {
				const t = await start(
					{ modulation: "nfm", squelchMode: "auto", audioFormat: format },
					options,
				)
				const deliver = (from: number, to: number) => {
					if (!split) {
						t.feed(Buffer.from(script.subarray(from, to)))
						return
					}
					for (let at = from, i = 0; at < to; i++) {
						const end = Math.min(to, at + (sizes[i % sizes.length] ?? 1))
						t.feed(Buffer.from(script.subarray(at, end)))
						at = end
					}
				}
				t.stage.open = true
				deliver(0, openBytes)
				t.stage.open = false
				deliver(openBytes, script.length)
				const calls = t.factory.preRolls[0]?.calls ?? []
				await t.h.dispose()
				e = null
				return sampleTags(calls, width, script.length)
			}
			const whole = await runOnce(false)
			const split = await runOnce(true)
			expect(whole.includes(null)).toBe(false)
			expect(whole.slice(0, 1_000).every(tag => tag === "pending")).toBe(true)
			expect(whole[1_000]).toBe("pass")
			expect(whole[3_000]).toBe("pass")
			expect(whole.at(-1)).toBe("drop")
			expect(whole.includes("guard")).toBe(true)
			expect(split).toEqual(whole)
		})
	}

	for (const format of ["s16le", "f32le"] as const) {
		const width = format === "s16le" ? 2 : 4
		for (let phase = 1; phase < width; phase++) {
			it(`reset mid-sample then one-byte chunks keep framing (${format}, phase ${phase})`, async () => {
				const t = await start({
					modulation: "nfm",
					squelchMode: "auto",
					audioFormat: format,
				})
				t.stage.open = true
				t.feed(Buffer.alloc(width * 10 + phase, 1))
				const preRoll = t.factory.preRolls[0]
				const before = preRoll?.calls.length ?? 0
				t.h.sourceManager.emitCaps({ centerFreq: 446_100_000 })
				expect(preRoll?.ops).toContain("clear")
				const boundary = width * 11
				for (let i = 0; i < width - phase; i++) t.feed(Buffer.alloc(1, 1))
				expect(preRoll?.calls.length).toBe(before)
				t.feed(Buffer.alloc(width * 3, 1))
				const after = (preRoll?.calls ?? []).slice(before)
				expect(after[0]?.start).toBe(boundary)
				for (const call of after) expect(call.start % width).toBe(0)
			})
		}
	}

	describe("mode change mid-over clears the queue", () => {
		async function expectClearedOnce(t: EvidenceHarness): Promise<void> {
			await waitFor(() => (t.factory.preRolls[0]?.ops ?? []).includes("clear"))
			const gate = t.factory.gates[0]
			const preRoll = t.factory.preRolls[0]
			expect(gate?.ops.filter(op => op === "reset")).toHaveLength(1)
			expect(preRoll?.ops.filter(op => op === "clear")).toHaveLength(1)
		}

		async function latched(): Promise<EvidenceHarness> {
			const t = await start(
				{ modulation: "nfm", squelchMode: "auto" },
				{ latchAtByte: 0 },
			)
			t.stage.open = true
			t.feed(Buffer.alloc(2_000))
			expect(t.factory.gates[0]?.state).toBe("open")
			return t
		}

		it("auto to manual", async () => {
			const t = await latched()
			await t.h.demod.reconfigure({ squelchMode: "manual" })
			await expectClearedOnce(t)
		})

		it("auto with a tone squelch set", async () => {
			const t = await latched()
			await t.h.demod.reconfigure({ toneSquelch: CTCSS as never })
			await expectClearedOnce(t)
		})

		it("offset swap start", async () => {
			const t = await latched()
			void t.h.demod.reconfigure({ offsetHz: 5_000 }).catch(() => undefined)
			await expectClearedOnce(t)
		})

		it("retune", async () => {
			const t = await latched()
			t.h.sourceManager.emitCaps({ centerFreq: 446_100_000 })
			await expectClearedOnce(t)
		})

		it("stop", async () => {
			const t = await latched()
			await t.h.demod.stop()
			await expectClearedOnce(t)
		})

		it("manual to auto starts idle", async () => {
			const t = await start(
				{ modulation: "nfm", squelchMode: "manual" },
				{ latchAtByte: 0 },
			)
			t.stage.open = true
			t.feed(Buffer.alloc(2_000))
			expect(t.factory.preRolls[0]?.calls).toEqual([])
			await t.h.demod.reconfigure({ squelchMode: "auto" })
			await expectClearedOnce(t)
			expect(t.factory.gates[0]?.state).toBe("waiting")
		})

		it("tone squelch removed", async () => {
			const t = await start(
				{ modulation: "nfm", squelchMode: "auto", toneSquelch: CTCSS },
				{ latchAtByte: 0 },
			)
			await t.h.demod.reconfigure({ toneSquelch: { kind: "none" } })
			await expectClearedOnce(t)
			expect(t.factory.gates[0]?.state).toBe("waiting")
		})
	})

	describe("pre-roll per NFM or AM run only", () => {
		it("a WFM run calls neither factory method", async () => {
			const t = await start({ modulation: "wfm", squelchMode: "auto" })
			t.stage.open = true
			t.feed(Buffer.alloc(1_000))
			expect(t.factory.gates[0]?.notes ?? []).toEqual([])
			expect(t.factory.preRolls).toHaveLength(0)
		})

		it("a modulation change NFM to AM builds new instances", async () => {
			const t = await start({ modulation: "nfm", squelchMode: "auto" })
			expect(t.factory.gates[0]?.options.modulation).toBe("nfm")
			await t.h.demod.reconfigure({ modulation: "am" })
			await waitFor(() => t.factory.gates.length === 2)
			expect(t.factory.gates[1]?.options.modulation).toBe("am")
			expect(t.factory.preRolls).toHaveLength(2)
			const run = t.internals.run
			expect(t.factory.preRolls[1]?.options).toEqual({
				rate: run?.stream.rate,
				format: run?.stream.format,
			})
		})
	})

	it("factory failure falls back", async () => {
		const { logger, lines } = capturingLogger()
		const t = await start(
			{ modulation: "nfm", squelchMode: "auto" },
			{ failGate: true },
			logger,
		)
		const { transport } = t.h.addClient()
		t.stage.open = true
		const chunk = ramp(5_001)
		t.feed(Buffer.from(chunk))
		t.stage.open = false
		t.feed(Buffer.from(chunk))
		await waitFor(() => transport.chunks.length >= 2)
		expect(transport.received()).toEqual(Buffer.concat([chunk, chunk]))
		expect(
			lines.some(
				line =>
					line.level === 40 &&
					line.msg.includes("Evidence squelch unavailable"),
			),
		).toBe(true)
		expect(t.h.demod.getStatus().autoSquelch).toEqual({ state: "off" })
	})

	describe("status and level", () => {
		it("off for manual NFM", async () => {
			const t = await start({ modulation: "nfm", squelchMode: "manual" })
			expect(t.h.demod.getStatus().autoSquelch).toEqual({ state: "off" })
		})

		it("waiting then open/voice for auto NFM; squelchOpen stays stage 1", async () => {
			const t = await start(
				{ modulation: "nfm", squelchMode: "auto" },
				{ latchAtByte: 1_000 },
			)
			t.stage.open = true
			t.feed(Buffer.alloc(500))
			const waiting = t.h.demod.getStatus()
			expect(waiting.autoSquelch).toEqual({ state: "waiting" })
			expect(waiting.squelchOpen).toBe(true)
			t.feed(Buffer.alloc(1_000))
			const open = t.h.demod.getStatus()
			expect(open.autoSquelch).toEqual({ state: "open", evidence: "voice" })
			expect(open.autoSquelch).not.toBe(t.h.demod.getStatus().autoSquelch)
			t.stage.open = false
			expect(t.h.demod.getStatus().squelchOpen).toBe(false)
			const level = await new Promise<{ autoSquelch?: unknown }>(resolve =>
				t.h.demod.once("level", resolve),
			)
			expect(level.autoSquelch).toEqual({ state: "open", evidence: "voice" })
		})

		it("absent when no run", async () => {
			const t = await start({ modulation: "nfm", squelchMode: "auto" })
			await t.h.demod.stop()
			expect(t.h.demod.getStatus().autoSquelch).toBeUndefined()
		})
	})
})

import { describe, expect, it } from "vitest"
import { IDENTIFY_PAIR_WAIT_MS } from "../../../../src/core/scanner/identify.js"
import { ConfirmMemory } from "../../../../src/core/scanner/probes/confirm/confirm-memory.js"
import {
	identifyHarness,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync } from "../../../mocks/scanner/probe-fakes.js"
import { verifiedLinkLine } from "./verified-link-fake.js"

const ENDED = ["completed", "cancelled", "failed"]
/** One DMR superframe: 6 bursts of 60 ms, the cadence of a checked voice LC. */
const SUPERFRAME_MS = 360
const TICK_MS = 20

/** The composed core's acceptance: one shared memory, scoped by observation. */
function pairingHarness(request: Record<string, unknown> = {}) {
	return identifyHarness({
		request: { protocols: ["dmr"], ...request },
		confirm: clock => ({
			memory: new ConfirmMemory(() => clock.now),
			scopeOf: req => `o:${req.observationId}`,
		}),
	})
}

type Harness = ReturnType<typeof pairingHarness>

/** Real identify and pool code; only the decoder process is a fake that prints on the clock. */
async function runWithDecoder(
	h: Harness,
	linesAtMs: (msSinceProbe: number) => boolean,
): Promise<number> {
	await h.runner.start()
	h.tracks.push(
		viewOf(
			trackOf({
				acf30: -0.94,
				acf60: 0.99,
				trackId: "t1",
			}),
		),
	)
	await h.advance(100)
	await h.advance(100)
	await flushAsync()
	const probe = [...h.decoders.created.values()][0]!
	const started = h.clock.now
	for (let ms = TICK_MS; ms <= 30_000; ms += TICK_MS) {
		await h.advance(TICK_MS)
		if (ENDED.includes(h.record.state)) break
		if (linesAtMs(ms))
			h.decoders.emitLink(probe.id, verifiedLinkLine(1, h.clock.now))
	}
	return h.clock.now - started
}

describe("Identify confirms within one job (two decodes at least 2 s apart)", () => {
	it("a continuous DMR transmission is decoded by the first request", async () => {
		const h = pairingHarness()
		const firstLine = 300
		const elapsed = await runWithDecoder(
			h,
			ms => ms >= firstLine && (ms - firstLine) % SUPERFRAME_MS === 0,
		)
		expect(h.last()).toMatchObject({
			state: "identified",
			result: { protocol: "dmr", identity: { kind: "dmr-cc", value: "1" } },
		})
		expect(h.last()?.trials[0]).toMatchObject({
			protocol: "dmr",
			outcome: "decoded",
		})
		expect(h.last()?.verdict).toEqual({ code: "decoded", protocol: "dmr" })
		// The first line whose distance from 300 ms reaches 2 000 ms is the sixth superframe: 300 + 6 × 360 = 2 460.
		expect(elapsed).toBeLessThan(2460 + 200)
	})

	it("a transmission first decoded at the very end of the hold still confirms", async () => {
		const h = pairingHarness()
		// Hold 1 800 + start latency 400: the first checked line lands just inside 2 200 ms.
		const firstLine = 2160
		await runWithDecoder(
			h,
			ms => ms >= firstLine && (ms - firstLine) % SUPERFRAME_MS === 0,
		)
		expect(h.last()).toMatchObject({
			state: "identified",
			result: { protocol: "dmr" },
		})
	})

	it("a second decode inside the 2 s separation does not confirm, and does not extend the run again", async () => {
		const h = pairingHarness()
		const elapsed = await runWithDecoder(h, ms => ms === 300 || ms === 1300)
		expect(h.last()?.verdict?.code).toBe("heard-digital-unconfirmed")
		expect(elapsed).toBeLessThanOrEqual(300 + IDENTIFY_PAIR_WAIT_MS + 200)
	})

	it("a gated deadline still cuts a run that waits for its pair", async () => {
		const h = identifyHarness({
			request: { protocols: ["dmr"], timeoutMs: 1000, waitUntilSignal: true },
			gatedAt: () => ({ startSample: 1_000_000, atMs: 0 }),
			confirm: clock => ({
				memory: new ConfirmMemory(() => clock.now),
				scopeOf: req => `o:${req.observationId}`,
			}),
		})
		const elapsed = await runWithDecoder(h, ms => ms === 300)
		// timeoutMs counts from the gate: 1 000 ms, well under the 3 080 ms the decode asked for.
		expect(elapsed).toBeLessThanOrEqual(1000)
		expect(h.last()?.trials[0]).toMatchObject({ outcome: "cancelled" })
		expect(h.last()?.verdict).toEqual({
			code: "heard-digital-unconfirmed",
			protocol: "dmr",
		})
	})

	it("a lone pager decode is heard: never no-sync, never decoded", async () => {
		const h = pairingHarness({ protocols: ["pocsag"] })
		await h.runner.start()
		h.tracks.push(viewOf(trackOf({ obwHz: 12_000 })))
		await h.advance(100)
		await h.advance(100)
		await flushAsync()
		const probe = [...h.decoders.created.values()][0]!
		expect(probe.config.type).toBe("multimon-ng")
		// No plausible payload, so one decode does not accept the capcode.
		h.decoders.emitOutput(probe.id, {
			type: "message",
			timestamp: new Date(h.clock.now),
			data: { protocol: "POCSAG1200", address: 1234567 },
		})
		for (let i = 0; i < 400 && !ENDED.includes(h.record.state); i++)
			await h.advance(TICK_MS)
		expect(h.last()?.result?.protocol).toBeUndefined()
		expect(h.last()?.verdict).toEqual({
			code: "heard-digital-unconfirmed",
			protocol: "pocsag",
		})
	})

	it.each([
		[{ type: "cancel" } as const, "cancelled"],
		[{ type: "source-down" } as const, "source-lost"],
	])("%j mid-run answers could-not-test (%s)", async (event, why) => {
		const h = pairingHarness()
		await h.runner.start()
		h.tracks.push(viewOf(trackOf({ acf30: -0.94, acf60: 0.99 })))
		await h.advance(100)
		await h.advance(100)
		await flushAsync()
		await h.runner.dispatch(event)
		expect(h.runner.view().targets[0]?.verdict).toEqual({
			code: "could-not-test",
			why,
			protocol: "dmr",
		})
	})

	it("a window that moves mid-run answers could-not-test (window-moved)", async () => {
		const h = pairingHarness()
		await h.runner.start()
		h.tracks.push(viewOf(trackOf({ acf30: -0.94, acf60: 0.99 })))
		await h.advance(100)
		await h.advance(100)
		await flushAsync()
		h.engine.setEpoch(2, 900_000_000)
		await h.advance(TICK_MS)
		expect(h.last()?.result?.ended).toBe("window-moved")
		expect(h.last()?.verdict).toEqual({
			code: "could-not-test",
			why: "window-moved",
			protocol: "dmr",
		})
	})

	it("a single short burst is one decode: never decoded, and the run ends on its bound", async () => {
		const h = pairingHarness()
		const elapsed = await runWithDecoder(h, ms => ms === 300)
		expect(h.last()?.state).toBe("unidentified")
		expect(h.last()?.result?.protocol).toBeUndefined()
		expect(h.last()?.trials[0]).toMatchObject({
			protocol: "dmr",
			outcome: "timeout",
		})
		expect(h.last()?.verdict).toEqual({
			code: "heard-digital-unconfirmed",
			protocol: "dmr",
		})
		// First decode at 300 ms, then IDENTIFY_PAIR_WAIT_MS (3 080): past the 2 200 ms plain hold, not by more.
		expect(elapsed).toBeGreaterThanOrEqual(300 + IDENTIFY_PAIR_WAIT_MS)
		expect(elapsed).toBeLessThanOrEqual(300 + IDENTIFY_PAIR_WAIT_MS + 200)
	})

	it("no decode at all keeps the plain hold (no extension for silence)", async () => {
		const h = pairingHarness()
		const elapsed = await runWithDecoder(h, () => false)
		expect(h.last()?.trials[0]).toMatchObject({
			protocol: "dmr",
			outcome: "no-sync",
		})
		expect(h.last()?.verdict).toEqual({ code: "undecodable", protocol: "dmr" })
		// Hold 1 800 + start latency 400.
		expect(elapsed).toBeLessThanOrEqual(2200 + 200)
	})
})

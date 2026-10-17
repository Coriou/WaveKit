/**
 * WG10 req 3.1: the analog evidence log (ring of 32 by transmission id, defensive copy of the
 * tracker's events, never throws) and the pure live-audio monitoring check.
 */
import { describe, expect, it, vi } from "vitest"
import type { AnalogTransmissionEventData } from "@wavekit/api-types"
import { IDENTIFY_ANALOG_MAX_TRANSMISSIONS } from "@wavekit/api-types"
import {
	ANALOG_EVIDENCE_WARN_INTERVAL_MS,
	createAnalogEvidenceLog,
	liveAudioMonitoring,
} from "../../../../src/core/scanner/analog-evidence.js"
import type { LiveDemodStatus } from "../../../../src/core/live-demodulator.js"
import type { Logger } from "../../../../src/utils/logger.js"

const HZ = 446_006_250
const T0 = Date.parse("2026-10-17T10:00:00.000Z")

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

function event(
	over: Partial<AnalogTransmissionEventData> & { at?: number } = {},
): AnalogTransmissionEventData {
	const at = over.at ?? T0
	const closed = (over.state ?? "closed") === "closed"
	const { at: _at, ...rest } = over
	return {
		transmissionId: "tx1",
		sourceId: "rtl",
		state: "closed",
		startedAt: iso(at),
		endedAt: closed ? iso(at + 2000) : null,
		durationMs: closed ? 2000 : null,
		frequency: { hz: HZ, tuningTrust: "commanded" },
		modulation: "nfm",
		bandwidthHz: 12_500,
		squelchMode: "manual",
		thresholdDbfs: -40,
		peakChannelPowerDbfs: -30,
		meanChannelPowerDbfs: -32,
		closeReason: closed ? "squelch" : null,
		...(closed ? { tone: { ctcssHz: 88.5, dtmf: null, dcs: null } } : {}),
		...rest,
	}
}

function log(monitoring: () => boolean = () => true, now = () => T0) {
	const warn = vi.fn()
	const logger = { warn } as unknown as Logger
	return {
		warn,
		log: createAnalogEvidenceLog({ now, monitoring, logger }),
	}
}

describe("analog evidence log (WG10 3.1)", () => {
	it("copies only the contract fields; tone and DCS from closed events", () => {
		const { log: l } = log()
		l.record(
			event({
				tone: {
					ctcssHz: 88.5,
					dtmf: "123",
					dcs: { code: "023", polarity: "normal" },
				},
			}),
		)
		expect(l.transmissionsNear("rtl", HZ, 1000, 0)).toEqual([
			{
				transmissionId: "tx1",
				sourceId: "rtl",
				startedAtMs: T0,
				endedAtMs: T0 + 2000,
				hz: HZ,
				tuningTrust: "commanded",
				modulation: "nfm",
				ctcssHz: 88.5,
				dcs: { code: "023", polarity: "normal" },
			},
		])
	})

	it("an open event has no tone even if one is attached", () => {
		const { log: l } = log()
		l.record(
			event({
				state: "open",
				tone: { ctcssHz: 88.5, dtmf: null, dcs: null },
			}),
		)
		const [t] = l.transmissionsNear("rtl", HZ, 1000, 0)
		expect(t).toMatchObject({ endedAtMs: null, ctcssHz: null, dcs: null })
	})

	it("a closed event replaces its open one; a closed event without tone has none", () => {
		const { log: l } = log()
		l.record(event({ state: "open" }))
		const closed = event()
		delete closed.tone
		l.record(closed)
		const got = l.transmissionsNear("rtl", HZ, 1000, 0)
		expect(got).toHaveLength(1)
		expect(got[0]).toMatchObject({
			endedAtMs: T0 + 2000,
			ctcssHz: null,
			dcs: null,
		})
		// A late open event for the same id never reopens it.
		l.record(event({ state: "open" }))
		expect(l.transmissionsNear("rtl", HZ, 1000, 0)[0]?.endedAtMs).toBe(
			T0 + 2000,
		)
	})

	it("filters by source, tolerance (inclusive) and since; open always counts; newest first", () => {
		const { log: l } = log()
		l.record(event({ transmissionId: "a", at: T0 }))
		l.record(event({ transmissionId: "b", at: T0 + 10_000 }))
		l.record(event({ transmissionId: "other-src", sourceId: "sdrpp" }))
		l.record(
			event({
				transmissionId: "far",
				frequency: { hz: HZ + 1001, tuningTrust: "commanded" },
			}),
		)
		l.record(
			event({
				transmissionId: "edge",
				at: T0 + 5000,
				frequency: { hz: HZ + 1000, tuningTrust: "commanded" },
			}),
		)
		l.record(event({ transmissionId: "open", state: "open", at: T0 - 99_000 }))
		const ids = (since: number) =>
			l.transmissionsNear("rtl", HZ, 1000, since).map(t => t.transmissionId)
		expect(ids(0)).toEqual(["b", "edge", "a", "open"])
		// a ended at T0+2000: exactly at since counts, one ms later does not.
		expect(ids(T0 + 2000)).toEqual(["b", "edge", "a", "open"])
		expect(ids(T0 + 2001)).toEqual(["b", "edge", "open"])
		expect(l.transmissionsNear("nope", HZ, 1000, 0)).toEqual([])
	})

	it("drops malformed and hostile events without throwing", () => {
		const { log: l } = log()
		const bad: unknown[] = [
			null,
			42,
			event({ frequency: null }),
			event({ frequency: { hz: Number.NaN, tuningTrust: "commanded" } }),
			event({
				frequency: { hz: Number.POSITIVE_INFINITY, tuningTrust: "commanded" },
			}),
			event({ frequency: { hz: -5, tuningTrust: "commanded" } }),
			event({ frequency: { hz: HZ, tuningTrust: "trusted" as never } }),
			event({ modulation: "fm" as never }),
			event({ transmissionId: "" }),
			event({ transmissionId: "x".repeat(129) }),
			event({ sourceId: 7 as never }),
			event({ startedAt: "yesterday" }),
			event({ endedAt: null }),
			event({ endedAt: iso(T0 - 1) }),
			event({ state: "half" as never }),
			event({ tone: { ctcssHz: 88.4, dtmf: null, dcs: null } }),
			event({ tone: { ctcssHz: "88.5" as never, dtmf: null, dcs: null } }),
			event({
				tone: {
					ctcssHz: null,
					dtmf: null,
					dcs: { code: "999", polarity: "normal" },
				},
			}),
			event({
				tone: {
					ctcssHz: null,
					dtmf: null,
					dcs: { code: "023", polarity: "sideways" as never },
				},
			}),
			Object.defineProperty({}, "transmissionId", {
				get() {
					throw new Error("hostile")
				},
			}),
		]
		for (const b of bad)
			expect(() => l.record(b as AnalogTransmissionEventData)).not.toThrow()
		expect(l.transmissionsNear("rtl", HZ, 1e12, 0)).toEqual([])
	})

	it("keeps 32 transmissions, drops the oldest at 33", () => {
		const { log: l } = log()
		const fill = (n: number) => {
			for (let i = 0; i < n; i++)
				l.record(event({ transmissionId: `tx${i}`, at: T0 + i * 1000 }))
		}
		fill(IDENTIFY_ANALOG_MAX_TRANSMISSIONS)
		let got = l.transmissionsNear("rtl", HZ, 1000, 0)
		expect(got).toHaveLength(32)
		expect(got.at(-1)?.transmissionId).toBe("tx0")
		l.record(event({ transmissionId: "tx32", at: T0 + 32_000 }))
		got = l.transmissionsNear("rtl", HZ, 1000, 0)
		expect(got).toHaveLength(32)
		expect(got[0]?.transmissionId).toBe("tx32")
		expect(got.some(t => t.transmissionId === "tx0")).toBe(false)
	})

	it("returns copies: callers cannot mutate the ring", () => {
		const { log: l } = log()
		l.record(
			event({
				tone: {
					ctcssHz: null,
					dtmf: null,
					dcs: { code: "023", polarity: "normal" },
				},
			}),
		)
		const [t] = l.transmissionsNear("rtl", HZ, 1000, 0)
		t!.hz = 1
		t!.dcs!.code = "047"
		expect(l.transmissionsNear("rtl", HZ, 1000, 0)[0]).toMatchObject({
			hz: HZ,
			dcs: { code: "023" },
		})
	})

	it("bad query arguments return no evidence", () => {
		const { log: l } = log()
		l.record(event())
		expect(l.transmissionsNear("rtl", Number.NaN, 1000, 0)).toEqual([])
		expect(l.transmissionsNear("rtl", HZ, -1, 0)).toEqual([])
		expect(l.transmissionsNear("rtl", HZ, 1000, Number.NaN)).toEqual([])
	})

	it("monitoring delegates; a throwing callback is false with one fixed warn per minute", () => {
		let now = T0
		let mode: "true" | "false" | "throw" = "true"
		const { log: l, warn } = log(
			() => {
				if (mode === "throw") throw new Error("secret host 10.0.0.1")
				return mode === "true"
			},
			() => now,
		)
		expect(l.monitoring("rtl", HZ, 1000)).toBe(true)
		mode = "false"
		expect(l.monitoring("rtl", HZ, 1000)).toBe(false)
		mode = "throw"
		expect(l.monitoring("rtl", HZ, 1000)).toBe(false)
		expect(l.monitoring("rtl", HZ, 1000)).toBe(false)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]).toEqual([
			"Live audio monitoring state unavailable; identify treats it as not monitoring",
		])
		now += ANALOG_EVIDENCE_WARN_INTERVAL_MS - 1
		l.monitoring("rtl", HZ, 1000)
		expect(warn).toHaveBeenCalledTimes(1)
		now += 1
		l.monitoring("rtl", HZ, 1000)
		expect(warn).toHaveBeenCalledTimes(2)
	})

	it("a non-boolean truthy callback answer is not monitoring", () => {
		const { log: l } = log(() => "yes" as unknown as boolean)
		expect(l.monitoring("rtl", HZ, 1000)).toBe(false)
	})
})

function status(over: Partial<LiveDemodStatus> = {}): LiveDemodStatus {
	return {
		enabled: true,
		running: true,
		sourceId: "rtl",
		sourceConnected: true,
		sourceIqSampleRate: 2_048_000,
		config: { offsetHz: 6250 } as LiveDemodStatus["config"],
		effectiveSampleRate: 48_000,
		decimationFactor: 1,
		httpUrl: "",
		wavUrl: "",
		clientCount: 0,
		bytesStreamed: 0,
		pipelineHealth: "running",
		pipelineRestarts: 0,
		...over,
	}
}

describe("liveAudioMonitoring (WG10 3.2)", () => {
	const TUNER = HZ - 6250
	it("true only when running on the source with the channel within the tolerance", () => {
		expect(liveAudioMonitoring(status(), TUNER, HZ, 1000, "rtl")).toBe(true)
		expect(liveAudioMonitoring(status(), TUNER, HZ + 1000, 1000, "rtl")).toBe(
			true,
		)
		expect(liveAudioMonitoring(status(), TUNER, HZ + 1001, 1000, "rtl")).toBe(
			false,
		)
		expect(liveAudioMonitoring(status(), TUNER, HZ, 1000)).toBe(true)
	})
	it("anything unknown is false", () => {
		expect(
			liveAudioMonitoring(status({ running: false }), TUNER, HZ, 1000),
		).toBe(false)
		expect(
			liveAudioMonitoring(status({ sourceConnected: false }), TUNER, HZ, 1000),
		).toBe(false)
		expect(liveAudioMonitoring(status(), TUNER, HZ, 1000, "sdrpp")).toBe(false)
		expect(liveAudioMonitoring(status(), null, HZ, 1000)).toBe(false)
		expect(liveAudioMonitoring(status(), Number.NaN, HZ, 1000)).toBe(false)
		expect(liveAudioMonitoring(status(), TUNER, Number.NaN, 1000)).toBe(false)
		expect(liveAudioMonitoring(status(), TUNER, HZ, Number.NaN)).toBe(false)
		expect(
			liveAudioMonitoring(
				status({
					config: { offsetHz: Number.NaN } as LiveDemodStatus["config"],
				}),
				TUNER,
				HZ,
				1000,
			),
		).toBe(false)
		const hostile = Object.defineProperty(status(), "config", {
			get() {
				throw new Error("x")
			},
		})
		expect(liveAudioMonitoring(hostile, TUNER, HZ, 1000)).toBe(false)
	})
	it("no offset means the tuner centre", () => {
		expect(
			liveAudioMonitoring(
				status({ config: {} as LiveDemodStatus["config"] }),
				HZ,
				HZ,
				1000,
			),
		).toBe(true)
	})
})

describe("pending opening (WG10 R2 m3)", () => {
	it("pendingNear copies the tracker's held opening when it lies near the target", () => {
		const { log: l } = log()
		expect(l.pendingNear("rtl", HZ, 1000)).toEqual([])
		let held: AnalogTransmissionEventData | null = event({ state: "open" })
		l.setPending(() => held)
		expect(l.pendingNear("rtl", HZ + 900, 1000)).toEqual([
			expect.objectContaining({ transmissionId: "tx1", endedAtMs: null }),
		])
		expect(l.pendingNear("rtl", HZ + 1100, 1000)).toEqual([])
		expect(l.pendingNear("sdrpp", HZ, 1000)).toEqual([])
		// Never in the ring: transmissionsNear does not see it.
		expect(l.transmissionsNear("rtl", HZ, 1000, 0)).toEqual([])
		held = event()
		expect(l.pendingNear("rtl", HZ, 1000)).toEqual([])
		held = null
		expect(l.pendingNear("rtl", HZ, 1000)).toEqual([])
	})

	it("a throwing or malformed pending source is no evidence", () => {
		const { log: l } = log()
		l.setPending(() => {
			throw new Error("boom")
		})
		expect(l.pendingNear("rtl", HZ, 1000)).toEqual([])
		l.setPending(
			() => ({ nope: true }) as unknown as AnalogTransmissionEventData,
		)
		expect(l.pendingNear("rtl", HZ, 1000)).toEqual([])
		expect(l.pendingNear("rtl", Number.NaN, 1000)).toEqual([])
	})
})

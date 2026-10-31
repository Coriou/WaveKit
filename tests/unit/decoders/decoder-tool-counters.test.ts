/**
 * Frame counters from tool output the adapters already read: rtl_433's
 * `-M stats` report (deltas per interval) and dsd-fme's sync / CRC / FEC lines.
 * All samples are synthetic.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import {
	RTL433_STATS_ARG,
	Rtl433Decoder,
	parseRtl433Stats,
	rtl433StatsConfigured,
} from "../../../src/decoders/builtin/rtl433.js"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import {
	COUNTER_FLUSH_MS,
	DecoderCounterStore,
	receptionHint,
	type DecoderCounterEvent,
} from "../../../src/decoders/decoder-counters.js"
import type { DsdFmeLinkLine } from "../../../src/decoders/builtin/dsd-fme-link.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })

type Internals = {
	handleOutputLine(line: string): void
	getDecoderArgs(): string[]
}

function collect(decoder: Rtl433Decoder | DsdFmeDecoder) {
	const store = new DecoderCounterStore()
	const outputs: DecoderOutput[] = []
	decoder.on("counters", (event: DecoderCounterEvent) =>
		store.record(decoder.id, event),
	)
	decoder.on("output", (output: DecoderOutput) => outputs.push(output))
	return { store, outputs, internals: decoder as unknown as Internals }
}

const rtl433 = (options: Record<string, unknown> = {}) =>
	new Rtl433Decoder(
		{
			id: "ism",
			type: "rtl_433",
			enabled: true,
			options: { outputFormat: "json", ...options },
		} satisfies DecoderConfig,
		logger,
	)

/** The shape rtl_433 25.12 prints for `-M stats:1:<s>` (values synthetic). */
const report = (count: number, events: number) =>
	JSON.stringify({
		time: "@10.000000s",
		enabled: 200,
		since: "2026-01-01T00:00:00",
		frames: { count, fsk: 0, events },
		stats: [],
	})

afterEach(() => {
	vi.useRealTimers()
})

describe("rtl_433 stats report", () => {
	it("requests a 10 s level-1 report unless the operator sets one", () => {
		expect(RTL433_STATS_ARG).toBe("stats:1:10")
		const args = collect(rtl433()).internals.getDecoderArgs()
		expect(args.join(" ")).toContain("-M stats:1:10")
		for (const extra of [["-M", "stats:2:60"], ["-Mstats"]]) {
			expect(rtl433StatsConfigured(extra)).toBe(true)
			const own = collect(rtl433({ extraArgs: extra })).internals
			expect(own.getDecoderArgs().filter(a => a === RTL433_STATS_ARG)).toEqual(
				[],
			)
		}
		expect(rtl433StatsConfigured(["-M", "level"])).toBe(false)
		expect(rtl433StatsConfigured(undefined)).toBe(false)
		const csv = collect(rtl433({ outputFormat: "csv" })).internals
		expect(csv.getDecoderArgs()).not.toContain(RTL433_STATS_ARG)
	})

	it("reads a report as heard (frames) and decoded (events) deltas", () => {
		expect(parseRtl433Stats(JSON.parse(report(6, 1)))).toEqual({
			detections: 6,
			framesOk: 1,
		})
		expect(parseRtl433Stats({ model: "x", frames: {} })).toBeNull()
		expect(parseRtl433Stats({ frames: { count: "6" } })).toBeNull()
		expect(parseRtl433Stats(null)).toBeNull()
	})

	it("adds each report to the totals and never emits it as a signal", () => {
		const { store, outputs, internals } = collect(rtl433())
		internals.handleOutputLine(report(6, 0))
		internals.handleOutputLine(report(0, 0))
		internals.handleOutputLine(report(4, 0))
		internals.handleOutputLine('{"frames":{"count":-1e999}}')
		internals.handleOutputLine('{"model":"Test-Sensor","id":1,"frames":3}')
		expect(store.view("ism")).toEqual({
			detections: { total: 10, perMin: 10, latest: 4 },
			framesOk: { total: 0, perMin: 0, latest: 0 },
		})
		// Only the sensor event (it has a model) is an output.
		expect(outputs.map(o => (o.data as { model?: string }).model)).toEqual([
			"Test-Sensor",
		])
	})
})

describe("dsd-fme line counters", () => {
	const dsd = () =>
		new DsdFmeDecoder(
			{
				id: "dv",
				type: "dsd-fme",
				enabled: true,
				options: { mode: "auto" },
			},
			logger,
		)

	it("counts syncs, CRC and FEC errors from lines it parses, sent within the flush interval", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const { store, internals } = collect(dsd())
		internals.handleOutputLine(
			"00:00:00 Sync: +DMR MS/DM MODE/MONO | Color Code=XX | MBCC (FEC ERR) (FEC ERR)",
		)
		internals.handleOutputLine("Sync: +P25p1 ")
		internals.handleOutputLine(" SLOT 1 TGT=1 SRC=2 Group Call   (CRC ERR) ")
		internals.handleOutputLine(" no sync here ")
		expect(store.view("dv")).toBeUndefined()
		vi.advanceTimersByTime(COUNTER_FLUSH_MS)
		expect(store.view("dv")).toEqual({
			detections: { total: 2, perMin: 2, latest: 2 },
			framesOk: { total: 0, perMin: 0, latest: 0 },
			crcBad: { total: 1, perMin: 1, latest: 1 },
			fecBad: { total: 2, perMin: 2, latest: 2 },
		})
	})

	it("reports syncs with only CRC failures as heard but undecoded", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const { store, internals } = collect(dsd())
		for (let i = 0; i < 3; i++) {
			internals.handleOutputLine(
				"Sync: +DMR  [slot1]  slot2  | Color Code=05 | VLC (CRC ERR) ",
			)
			internals.handleOutputLine(" SLCO CRC ERR")
		}
		vi.advanceTimersByTime(COUNTER_FLUSH_MS)
		const view = store.view("dv")
		expect(view?.framesOk).toEqual({ total: 0, perMin: 0, latest: 0 })
		expect(view?.detections?.total).toBe(3)
		expect(receptionHint(view)).toBe("heard-undecoded")
	})

	it("counts a DMR link as decoded only once the next sync attests it", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const decoder = dsd()
		const { store, internals } = collect(decoder)
		const links: DsdFmeLinkLine[] = []
		decoder.on("link", (link: DsdFmeLinkLine) => links.push(link))
		const sync = (burst: string) =>
			internals.handleOutputLine(
				`Sync: +DMR  [slot1]  slot2  | Color Code=05 | ${burst}`,
			)

		// A later CRC failure rejects the pending link: nothing decoded.
		sync("VLC")
		internals.handleOutputLine(" SLCO CRC ERR")
		sync("IDLE")
		vi.advanceTimersByTime(COUNTER_FLUSH_MS)
		expect(links.some(l => l.verified)).toBe(false)
		expect(store.view("dv")?.framesOk?.total).toBe(0)
		expect(receptionHint(store.view("dv"))).toBe("heard-undecoded")

		// A clean burst closed by the next DMR sync counts once.
		sync("VLC")
		sync("IDLE")
		vi.advanceTimersByTime(COUNTER_FLUSH_MS)
		expect(links.filter(l => l.verified)).toHaveLength(1)
		expect(store.view("dv")?.framesOk?.total).toBe(1)
	})
})

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Discovery } from "@wavekit/api-types"
import { DiscoveryHistory } from "../../src/features/scanner/drawer/History.tsx"
import { describe, expect, it } from "vitest"
import type { HistoryObservation } from "../../src/features/scanner/drawer/history.ts"
import {
	barHeights,
	countText,
	dayHistory,
	historyAria,
	lastTransmissions,
} from "../../src/features/scanner/drawer/history.ts"

const HOUR = 3_600_000
const now = Date.parse("2026-10-17T14:30:00Z")
const obs = (
	startMs: number,
	lenMs: number | null,
	id = String(startMs),
): HistoryObservation => ({
	id,
	startedAt: new Date(startMs).toISOString(),
	...(lenMs === null
		? {}
		: { endedAt: new Date(startMs + lenMs).toISOString() }),
	snrDb: 9.4,
})

describe("a discovery's last 24 h", () => {
	it("counts transmissions per clock hour, the current hour last", () => {
		const h = dayHistory(
			[
				obs(now - 60_000, 5_000),
				obs(now - 2 * 60_000, 5_000),
				obs(now - 3 * HOUR, 5_000),
			],
			now,
		)
		expect(h.bars).toHaveLength(24)
		expect(h.bars[23]?.count).toBe(2)
		expect(h.bars[20]?.count).toBe(1)
		expect(h.count).toBe(3)
		expect(h.steady).toBe(false)
		expect(countText(h)).toBe("3 transmissions")
		expect(historyAria(h)).toMatch(
			/^3 transmissions in the last 24 hours, busiest /,
		)
		const px = barHeights(h)
		expect(px[23]).toBe(26)
		expect(px[20]).toBe(13)
		expect(px[0]).toBe(0)
	})

	it("ignores what started more than a day ago and marks a cut page as a floor", () => {
		const old = obs(now - 30 * HOUR, 5_000)
		expect(dayHistory([old], now).count).toBe(0)
		expect(countText(dayHistory([old], now))).toBe("Not heard")
		const page = dayHistory([obs(now - HOUR, 1000)], now, "500")
		expect(page.more).toBe(true)
		expect(countText(page)).toBe("1+ transmissions")
	})

	it("calls a carrier on all day steady, and spreads its airtime over the hours", () => {
		const h = dayHistory([obs(now - 30 * HOUR, null)], now)
		expect(h.steady).toBe(true)
		expect(countText(h)).toBe("On all day")
		expect(h.bars.every(b => b.airtime > 0)).toBe(true)
		expect(
			lastTransmissions([obs(now - 30 * HOUR, null)], now)[0],
		).toMatchObject({
			live: true,
			length: "On air",
		})
	})

	it("lists the newest transmissions with their length and SNR", () => {
		const t = lastTransmissions(
			[obs(now - HOUR, 12_000, "a"), obs(now - 60_000, 95_000, "b")],
			now,
		)
		expect(t.map(x => x.id)).toEqual(["b", "a"])
		expect(t[0]).toMatchObject({
			length: "1 min 35 s",
			snr: "SNR 9 dB",
			live: false,
		})
		expect(t[1]?.length).toBe("12 s")
	})
})

it("hides synthetic transmission history for a decode anchor", () => {
	const anchor = { anchor: "decode" } as Discovery
	expect(
		renderToStaticMarkup(createElement(DiscoveryHistory, { d: anchor })),
	).toBe("")
})

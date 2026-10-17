/**
 * WG10 req 4.2: a subscriber's engine start before the source has caps (the boot state, about a
 * second before `connected`) is an expected state: debug, not warn. A connected source that is not
 * an IQ source keeps the warn (golden recorded from the frozen code).
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import type { SourceConfig } from "../../../../src/config.js"
import {
	SpectrumService,
	type SpectrumPersistence,
} from "../../../../src/core/spectrum/spectrum-service.js"
import { DEFAULT_TUNING } from "../../../../src/core/spectrum/spectrum-engine.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"
import { CENTRE, FS } from "../../../mocks/scanner/service-fakes.js"

interface Line {
	level: number
	msg: string
}
const WARN = 40
const DEBUG = 20

function make(mode: "no-caps" | "non-iq") {
	const sources = new FakeSources("rtl", { sampleRate: FS, centerFreq: CENTRE })
	const configCaps = sources.getCaps("rtl")!
	if (mode === "no-caps") sources.caps.delete("rtl")
	else sources.caps.set("rtl", { ...configCaps, kind: "audio" } as never)
	const lines: Line[] = []
	const logger = pino(
		{ level: "debug" },
		{
			write(chunk: string) {
				lines.push(JSON.parse(chunk) as Line)
			},
		},
	)
	const persistence: SpectrumPersistence = {
		writeEngine: () => Promise.resolve(),
		loadEngine: () => Promise.resolve(null),
		writeOccupancy: () => Promise.resolve(),
		loadOccupancy: () => Promise.resolve(null),
	}
	const fanout = new FakeFanout()
	const service = new SpectrumService({
		sources: sources as never,
		routing: {
			getFanout: () => fanout,
			releaseUnused: () => undefined,
		} as never,
		tuner: new FakeTuner() as never,
		sourceConfigs: [
			{
				id: "rtl",
				type: "rtl_tcp",
				host: "127.0.0.1",
				port: 1234,
				loop: false,
				playbackSpeed: 1,
				caps: configCaps,
			} as SourceConfig,
		],
		settings: () => testSettings(),
		tuning: () => DEFAULT_TUNING,
		persistence,
		logger,
		now: () => 1_700_000_000_000,
		engineHost: "inline",
	})
	return { service, sources, lines, configCaps }
}

const startFailures = (lines: Line[]) =>
	lines
		.filter(l => /failed to start/.test(l.msg))
		.map(l => [l.level, l.msg] as const)

/** A connected source whose live caps are non-IQ, past the eligibility check (a caps change in between). */
function forceEligible(h: ReturnType<typeof make>): void {
	;(h.service as unknown as { isEligible(id: string): boolean }).isEligible =
		() => true
}

describe("SpectrumService pre-connect engine start (WG10 req 4.2)", () => {
	it("a connected non-IQ source keeps the start-failure warning (golden from the frozen code)", async () => {
		const h = make("non-iq")
		forceEligible(h)
		await h.service.start()
		await h.service.subscribe("c1", undefined)
		expect(startFailures(h.lines)).toEqual([
			[WARN, "Spectrum engine failed to start"],
		])
		await h.service.stop()
	})

	it("a source without caps logs the start failure at debug, never warn", async () => {
		const h = make("no-caps")
		await h.service.start()
		await h.service.subscribe("c1", undefined)
		const failures = startFailures(h.lines)
		expect(failures.length).toBeGreaterThan(0)
		expect(failures.every(([level]) => level === DEBUG)).toBe(true)
		expect(h.lines.filter(l => l.level >= WARN)).toEqual([])
		await h.service.stop()
	})

	it("a later subscribe after the source connected starts the engine", async () => {
		const h = make("no-caps")
		await h.service.start()
		await h.service.subscribe("c1", undefined)
		h.sources.caps.set("rtl", h.configCaps)
		h.sources.emit("connected", "rtl")
		await h.service.subscribe("c2", undefined)
		expect(h.service.engine("rtl")).toBeDefined()
		await h.service.stop()
	})
})

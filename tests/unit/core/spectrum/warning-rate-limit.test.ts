import { describe, expect, it } from "vitest"
import pino from "pino"
import { SPECTRUM_WARNING_LOG_INTERVAL_MS } from "@wavekit/api-types"
import { SpectrumEngine } from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import type {
	EngineState,
	PipelineEvent,
	PipelineInput,
} from "../../../../src/core/spectrum/types.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"

class Host implements PipelineHost {
	readonly inputs: PipelineInput[] = []
	constructor(readonly handlers: PipelineHostHandlers) {}
	send(input: PipelineInput, transfer?: ArrayBuffer): void {
		this.inputs.push(input)
		if (transfer) this.handlers.buffer(transfer)
	}
	exportState(): Promise<EngineState> {
		return Promise.resolve({
			version: 1,
			absoluteFloors: [],
			spurs: [],
			kByRange: [],
		})
	}
	utilization(): number | null {
		return null
	}
	close(): Promise<void> {
		return Promise.resolve()
	}
}

function setup() {
	const lines: Record<string, unknown>[] = []
	const logger = pino(
		{ level: "warn" },
		{
			write: (s: string) =>
				lines.push(JSON.parse(s) as Record<string, unknown>),
		},
	)
	let now = 1_000_000
	const tuner = new FakeTuner()
	const hosts: Host[] = []
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources: new FakeSources(),
		routing: {
			getFanout: () => new FakeFanout() as never,
			releaseUnused: () => undefined,
		},
		tuner,
		settings: () => testSettings(),
		logger,
		createHost: (_cfg, handlers) => {
			const h = new Host(handlers)
			hosts.push(h)
			return h
		},
		now: () => now,
	})
	const alarm = (epoch: number, over: Partial<PipelineEvent> = {}): void => {
		hosts[0]!.handlers.events([
			{
				kind: "untracked-retune",
				epoch,
				startSample: epoch * 1000,
				deltaHz: -273_000,
				...over,
			} as PipelineEvent,
		])
	}
	const warnLines = () =>
		lines.filter(l => l["msg"] === "Spectrum engine trust warning")
	return {
		engine,
		tuner,
		alarm,
		warnLines,
		lines,
		advance: (ms: number) => {
			now += ms
		},
	}
}

describe("spectrum warning log rate limit (WG10 req 2.9)", () => {
	it("logs the first warning, suppresses and counts the next within 60 s, logs the next after with the count", async () => {
		const t = setup()
		await t.engine.start()
		t.alarm(5, { suspected: "external-control" })
		expect(t.warnLines()).toHaveLength(1)
		expect(t.warnLines()[0]).toMatchObject({
			code: "untracked-retune",
			deltaHz: -273_000,
			suspected: "external-control",
			lastCommandAgeMs: null,
		})
		expect(t.warnLines()[0]).not.toHaveProperty("suppressed")

		t.advance(SPECTRUM_WARNING_LOG_INTERVAL_MS - 1)
		t.alarm(6)
		expect(t.warnLines()).toHaveLength(1)

		t.advance(1)
		t.alarm(7, { suspected: "iq-byte-slip" })
		expect(t.warnLines()).toHaveLength(2)
		expect(t.warnLines()[1]).toMatchObject({
			suspected: "iq-byte-slip",
			suppressed: 1,
		})
		// The warning list keeps all three.
		expect(t.engine.warnings().map(w => w.suspected)).toEqual([
			"external-control",
			"external-control",
			"iq-byte-slip",
		])
		// Counts, codes and numbers only.
		for (const l of t.warnLines()) {
			const keys = Object.keys(l).filter(
				k =>
					!["level", "time", "pid", "hostname", "msg", "component"].includes(k),
			)
			for (const k of keys)
				expect([
					"code",
					"deltaHz",
					"suspected",
					"lastCommandAgeMs",
					"suppressed",
				]).toContain(k)
		}
		await t.engine.stop()
	})

	it("lastCommandAgeMs counts from the engine's last command-sent on its source (injected clock)", async () => {
		const t = setup()
		await t.engine.start()
		t.tuner.emit("command-sent", "other", "set-frequency", 1, "rest")
		t.alarm(5)
		expect(t.engine.warnings().at(-1)?.lastCommandAgeMs).toBeNull()
		t.tuner.emit("command-sent", "rtl", "set-gain", 296, "rest")
		t.advance(4_000)
		t.alarm(6)
		expect(t.engine.warnings().at(-1)).toMatchObject({
			code: "untracked-retune",
			suspected: "external-control",
			lastCommandAgeMs: 4_000,
		})
		await t.engine.stop()
	})

	it("a signal-change warning starts no epoch and is not forwarded", async () => {
		const t = setup()
		await t.engine.start()
		const before = t.engine.currentEpoch()
		const forwarded: PipelineEvent[] = []
		t.engine.on("pipeline", (ev: PipelineEvent) => forwarded.push(ev))
		t.alarm(before.epoch, {
			deltaHz: null,
			suspected: "signal-change",
			newEpoch: false,
		})
		expect(forwarded).toEqual([])
		expect(t.engine.currentEpoch()).toEqual(before)
		expect(t.engine.warnings()).toEqual([
			{
				code: "untracked-retune",
				deltaHz: null,
				at: 1_000_000,
				suspected: "signal-change",
				lastCommandAgeMs: null,
			},
		])
		await t.engine.stop()
	})
})

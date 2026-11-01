/**
 * LoRa wrapper stats lines: parsed with Zod, reported as counters, malformed
 * lines ignored and never logged verbatim; a fake child process stands in for
 * the wrapper, including a restart whose counters start again at 0.
 */

import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import {
	spawn,
	spawnSync as realSpawnSync,
	type ChildProcess,
} from "node:child_process"
import type * as ChildProcessModule from "node:child_process"
import { fileURLToPath } from "node:url"
import pino from "pino"
import {
	LORA_STATS_MAX_LENGTH,
	LORA_STATS_PREFIX,
	LoraMeshtasticDecoder,
	parseLoraStatsLine,
} from "../../../src/decoders/builtin/lora-meshtastic.js"
import {
	DecoderCounterStore,
	parseCounterSample,
	receptionHint,
	type DecoderCounterEvent,
} from "../../../src/decoders/decoder-counters.js"

vi.mock("node:child_process", async importOriginal => ({
	...(await importOriginal<typeof ChildProcessModule>()),
	spawn: vi.fn(),
}))

const SCRIPT = fileURLToPath(
	new URL("../../../docker/scripts/lora_meshtastic_decode.py", import.meta.url),
)
const hasPython =
	realSpawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0

const stats = (body: Record<string, unknown>) =>
	`${LORA_STATS_PREFIX}${JSON.stringify({ v: 1, ...body })}`

describe("parseLoraStatsLine", () => {
	it("reads the counters of a wrapper stats line", () => {
		expect(
			parseLoraStatsLine(
				stats({
					inputSamples: 5_000_000,
					preambles: 12,
					headersOk: 2,
					framesOk: 0,
					crcBad: 2,
					parseDrops: 0,
				}),
			),
		).toEqual({
			inputSamples: 5_000_000,
			preambles: 12,
			headersOk: 2,
			framesOk: 0,
			crcBad: 2,
			parseDrops: 0,
		})
	})

	it("refuses anything that is not a version 1 stats line", () => {
		for (const line of [
			'{"from":1}',
			`${LORA_STATS_PREFIX}not json`,
			`${LORA_STATS_PREFIX}[1,2]`,
			`${LORA_STATS_PREFIX}{"v":2,"framesOk":1}`,
			`${LORA_STATS_PREFIX}{"framesOk":1}`,
			`${LORA_STATS_PREFIX}null`,
		])
			expect(parseLoraStatsLine(line)).toBeNull()
	})

	it("parses a line at the length bound and refuses one past it", () => {
		const base = stats({ framesOk: 1 })
		const pad = (length: number) =>
			`${base.slice(0, -1)},"x":"${"y".repeat(length - base.length - 7)}"}`
		expect(pad(LORA_STATS_MAX_LENGTH)).toHaveLength(LORA_STATS_MAX_LENGTH)
		expect(parseLoraStatsLine(pad(LORA_STATS_MAX_LENGTH))).not.toBeNull()
		expect(parseLoraStatsLine(pad(LORA_STATS_MAX_LENGTH + 1))).toBeNull()
	})
})

function fakeChild(pid: number) {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: new PassThrough(),
		pid,
		exitCode: null,
		signalCode: null,
		killed: false,
		kill: vi.fn(() => true),
	})
}

const flushLines = () => new Promise(resolve => setImmediate(resolve))

describe("LoRa counters from a fake wrapper process", () => {
	it("reports stats lines as counters, keeps totals across a restart and never logs a bad line", async () => {
		const logged: string[] = []
		const logger = pino(
			{ level: "debug" },
			new Writable({
				write(chunk: Buffer, _enc, done) {
					logged.push(chunk.toString())
					done()
				},
			}),
		)
		const decoder = new LoraMeshtasticDecoder(
			{
				id: "lora",
				type: "lora-meshtastic",
				enabled: true,
				options: {
					region: "EU_868",
					preset: "LongFast",
					frequency: 869_525_000,
					channelKey: "AQ==",
				},
			},
			logger,
		)
		const store = new DecoderCounterStore()
		const events: DecoderCounterEvent[] = []
		decoder.on("counters", (event: DecoderCounterEvent) => {
			events.push(event)
			store.record("lora", event)
		})
		const outputs: unknown[] = []
		decoder.on("output", output => outputs.push(output))

		const first = fakeChild(101)
		vi.mocked(spawn).mockReturnValueOnce(first as unknown as ChildProcess)
		const started = decoder.start()
		first.emit("spawn")
		await started
		first.stderr.write(
			`${stats({ inputSamples: 1000, preambles: 4, headersOk: 1, framesOk: 0, crcBad: 1, parseDrops: 0 })}\n`,
		)
		first.stderr.write(`${LORA_STATS_PREFIX}{"v":1,"secretName":"leak-me"}\n`)
		first.stderr.write(`${LORA_STATS_PREFIX}{"v":1,"framesOk":"leak-me"}\n`)
		first.stderr.write(
			`${stats({ inputSamples: 3000, preambles: 9, headersOk: 1, framesOk: 0, crcBad: 1, parseDrops: 0 })}\n`,
		)
		await flushLines()
		expect(outputs).toEqual([])
		expect(store.view("lora")?.preambles?.total).toBe(9)
		expect(receptionHint(store.view("lora"))).toBe("heard-undecoded")

		first.emit("exit", 0, null)
		const second = fakeChild(102)
		vi.mocked(spawn).mockReturnValueOnce(second as unknown as ChildProcess)
		const restarted = decoder.start()
		second.emit("spawn")
		await restarted
		// A late line of the old child after the new start counts nothing.
		first.stderr.write(`${stats({ preambles: 50 })}\n`)
		second.stderr.write(`${stats({ preambles: 2, framesOk: 1 })}\n`)
		await flushLines()
		const view = store.view("lora")
		expect(view?.preambles?.total).toBe(11)
		expect(view?.preambles?.latest).toBe(2)
		expect(view?.framesOk?.total).toBe(1)
		expect(events).toHaveLength(3)
		expect(logged.join("")).not.toContain("leak-me")
		expect(logged.join("")).toContain("Ignored malformed wrapper stats line")
	})
})

describe.skipIf(!hasPython)("wrapper stats line contract", () => {
	it("the wrapper's own line parses with every counter on the allowlist", () => {
		const result = realSpawnSync(
			"python3",
			[
				"-I",
				"-c",
				[
					"import importlib.util, sys",
					`spec = importlib.util.spec_from_file_location("w", ${JSON.stringify(SCRIPT)})`,
					"w = importlib.util.module_from_spec(spec); sys.modules['w'] = w; spec.loader.exec_module(w)",
					"stats = w.WrapperStats(['direct'])",
					"stats.input_samples = 7; stats.locks['direct'] = 2; stats.frame_ok()",
					"drops = {'direct': w.DropCounter(log=lambda *a, **k: None)}",
					"drops['direct'].drop('crc_bad')",
					"print(w.format_stats_line(stats.snapshot(drops)))",
				].join("\n"),
			],
			{ encoding: "utf8", timeout: 30_000 },
		)
		expect(result.status, result.stderr).toBe(0)
		const counters = parseLoraStatsLine(result.stdout.trim())
		expect(counters).not.toBeNull()
		expect(parseCounterSample(counters)).toEqual({
			inputSamples: 7,
			preambles: 2,
			headersOk: 0,
			framesOk: 1,
			crcBad: 1,
			parseDrops: 0,
		})
	}, 35_000)
})

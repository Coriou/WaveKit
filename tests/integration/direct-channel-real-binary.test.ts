/**
 * Direct channel input with the real wavekit-chan under the real ChannelizerManager, FanoutManager and
 * DecoderManager: a decoder stand-in (a BaseDecoder running `cat` into a file) takes its channel socket as stdin.
 * Nothing connects anywhere: the IQ comes from this file and every socket lives in a fresh temp directory.
 *
 * Skipped when WAVEKIT_CHAN_BIN is unset; a set path that does not exist fails:
 *
 *   CARGO_TARGET_DIR=/tmp/chan cargo build --release --locked --manifest-path native/wavekit-chan/Cargo.toml
 *   WAVEKIT_CHAN_BIN=/tmp/chan/release/wavekit-chan \
 *     pnpm exec vitest run --maxWorkers=1 tests/integration/direct-channel-real-binary.test.ts
 *
 * Times here are waits for something to happen, each with a long limit; every verdict is on events, counters and
 * bytes. The processes killed here are the ones this file started, by their recorded pid.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChannelizerConfigSchema } from "../../src/config.js"
import {
	ChannelizerManager,
	type ChannelizerManagerDeps,
} from "../../src/core/channelizer/channelizer-manager.js"
import { ChannelizerProcess } from "../../src/core/channelizer/channelizer-process.js"
import type { ChannelizerEvent } from "../../src/core/channelizer/protocol.js"
import type { DecoderChannelRequest } from "../../src/core/channelizer/types.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import type { SourceManager } from "../../src/core/source-manager.js"
import { BaseDecoder } from "../../src/decoders/base-decoder.js"
import { DecoderManager } from "../../src/decoders/manager.js"
import { DecoderRegistry } from "../../src/decoders/registry.js"
import type {
	DecoderCaps,
	DecoderConfig,
	DecoderOutput,
	DecoderRateRequirements,
} from "../../src/decoders/types.js"
import { FakeSources, iqCaps } from "../mocks/rate-fakes.js"

const bin = process.env["WAVEKIT_CHAN_BIN"]
if (bin && !existsSync(bin))
	throw new Error(`Configured wavekit-chan binary is missing: ${bin}`)
const RATE = 2_048_000
const CENTER = 162e6
const ARRIVAL = { timeout: 30_000, interval: 20 }
const CAPS: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}
const requirements: DecoderRateRequirements = {
	version: 1,
	sourceKind: "iq",
	// As tests/mocks/rate-fakes.ts RateDecoder, which the channel wiring tests use.
	capture: {
		accepted: [{ kind: "range", minHz: 48_000 }],
		preferredHz: [2_400_000],
		minimum: { hz: 48_000, basis: "implementation", evidence: "test" },
	},
	decoderInput: {
		kind: "audio_pcm",
		format: "s16le",
		preferredHz: 48_000,
		accepted: [{ kind: "discrete", valuesHz: [48_000] }],
	},
}

/** `cat` appending its stdin (the channel socket) to a file: the bytes the decoder received, nothing else. */
class StandIn extends BaseDecoder {
	constructor(
		config: DecoderConfig,
		private readonly file: string,
	) {
		super(config, pino({ level: "silent" }))
	}
	protected getCommand(): string {
		return "/bin/sh"
	}
	protected getArgs(): string[] {
		return ["-c", 'exec cat >> "$0"', this.file]
	}
	protected parseOutput(): DecoderOutput | null {
		return null
	}
	protected getCaps(): DecoderCaps {
		return CAPS
	}
	getRateRequirements(): DecoderRateRequirements {
		return requirements
	}
	getChannelRequest(input: { centerHz?: number }): DecoderChannelRequest {
		return {
			centerHz: (input.centerHz ?? CENTER) - 200_000,
			bandwidthHz: 45_600,
			transitionHz: 1200,
			outputRateHz: 48_000,
			format: "cf32",
		}
	}
}

const sleep = (ms: number) =>
	new Promise<void>(resolve => {
		setTimeout(resolve, ms)
	})

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function rig(binaryPath: string) {
	const logged: string[] = []
	const logger = pino(
		{ level: "info" },
		{
			write: (line: string) => {
				logged.push((JSON.parse(line) as { msg: string }).msg)
			},
		},
	)
	const dir = mkdtempSync("/tmp/wkd-rb-")
	const out = join(dir, "decoder.bin")
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(RATE), centerFreq: CENTER })
	const fanout = new FanoutManager(pino({ level: "silent" }))
	let chanPid: number | undefined
	const chan = new ChannelizerManager({
		sourceManager:
			sources as unknown as ChannelizerManagerDeps["sourceManager"],
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		logger,
		config: ChannelizerConfigSchema.parse({
			enabled: true,
			socketDir: join(dir, "s"),
			binaryPath,
		}),
		createProcess: (options, log) => {
			const proc = new ChannelizerProcess(options, log)
			proc.on("event", (event: ChannelizerEvent) => {
				if (event.type === "ready") chanPid = event.pid
			})
			return proc
		},
	})
	const registry = new DecoderRegistry()
	registry.register("stand-in", config => new StandIn(config, out), CAPS)
	const manager = new DecoderManager(registry, fanout, logger, {
		restartDelay: 50,
		maxRestartDelay: 200,
		validateVersions: false,
		channelInput: "direct",
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	manager.setChannelizer(chan)
	const restarting: string[] = []
	manager.on("decoder:restarting", (id: string) => restarting.push(id))
	/** Every channel-invalidated of the channelizer: its channel ids and cause. */
	const invalidations: Array<{ ids: string[]; cause: string | undefined }> = []
	chan.on(
		"channel-invalidated",
		(_sourceId: string, _generation: number, ids: string[], cause?: string) =>
			invalidations.push({ ids, cause }),
	)
	manager.createDecoder({
		id: "dec",
		type: "stand-in",
		enabled: true,
		options: {},
		useChannelizer: true,
	})
	let pumping = true
	const feeding = (async () => {
		const chunk = Buffer.alloc(8192)
		let phase = 0
		while (pumping) {
			for (let i = 0; i < chunk.length; i += 2) {
				chunk[i] = Math.round(127.5 + 90 * Math.cos(phase))
				chunk[i + 1] = Math.round(127.5 + 90 * Math.sin(phase))
				phase += 0.37
			}
			fanout.distribute(Buffer.from(chunk))
			await sleep(2)
		}
	})()
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
	cleanup.push(() => fanout.destroy())
	cleanup.push(() => chan.destroy())
	cleanup.push(() => manager.destroy())
	cleanup.push(async () => {
		pumping = false
		await feeding
	})
	const size = () => (existsSync(out) ? statSync(out).size : 0)
	const internal = manager as unknown as {
		decoders: Map<string, { consecutiveFailures: number }>
	}
	return {
		manager,
		chan,
		sources,
		logged,
		restarting,
		invalidations,
		/** The crash path's failure count (not in the status DTO). */
		failures: () => internal.decoders.get("dec")!.consecutiveFailures,
		/** The decoder's open channel id (one decoder, so at most one row). */
		channelId: () => chan.openChannelRows()[0]?.id,
		size,
		chanPid: () => chanPid,
		status: () => manager.getStatus("dec")!,
		channelEnds: () =>
			logged.filter(
				msg => msg === "Decoder input ended with its channel; restarting it",
			).length,
	}
}

describe.skipIf(!bin || !existsSync(bin))(
	"direct channel input, real wavekit-chan",
	() => {
		const path = bin ?? ""

		it("the decoder receives its channel's bytes directly and bytesIn follows the stats lines", async () => {
			const r = rig(path)
			await r.manager.startDecoder("dec")
			expect(r.status().running).toBe(true)
			await vi.waitFor(() => expect(r.size()).toBeGreaterThan(64_000), ARRIVAL)
			// One `stats` line per 5 s; it counts whole cf32 samples (the file itself may end mid-sample).
			await vi.waitFor(
				() => expect(r.status().stats.bytesIn).toBeGreaterThan(0),
				ARRIVAL,
			)
			expect(r.status().stats.bytesIn % 8).toBe(0)
			expect(r.chan.openChannelRows()).toHaveLength(1)
			expect(r.logged).not.toContain("Channel died; invalidating it")
		}, 60_000)

		it("a centre move ends the channel: one restart, no crash accounting", async () => {
			const r = rig(path)
			await r.manager.startDecoder("dec")
			await vi.waitFor(() => expect(r.size()).toBeGreaterThan(0), ARRIVAL)
			const firstPid = r.status().pid
			const firstChannel = r.channelId()
			expect(firstPid).toBeDefined()
			expect(firstChannel).toBeDefined()
			r.sources.setCenter("rtl", CENTER + 100_000)
			await vi.waitFor(() => {
				expect(r.status().running).toBe(true)
				expect(r.status().pid).not.toBe(firstPid)
			}, ARRIVAL)
			const grown = r.size()
			await vi.waitFor(() => expect(r.size()).toBeGreaterThan(grown), ARRIVAL)
			await sleep(1000)
			// The channel ended exactly once, by the move (never as a vanished reader).
			const ended = r.invalidations.filter(item =>
				item.ids.includes(firstChannel ?? ""),
			)
			expect(ended).toHaveLength(1)
			expect(ended[0]?.cause).not.toBe("client-gone")
			expect(r.channelId()).not.toBe(firstChannel)
			// Which path ran: 1 when the child saw EOF and exited before the caps worker, 0 when the worker came first.
			expect([0, 1]).toContain(r.channelEnds())
			expect(r.restarting).toEqual([])
			expect(r.status()).toMatchObject({ running: true, restartCount: 0 })
			expect(r.status().lastError ?? null).toBeNull()
			expect(r.failures()).toBe(0)
			expect(r.logged).not.toContain("Channel died; invalidating it")
		}, 60_000)

		it("killing wavekit-chan gives the channel cause, not a crash back-off", async () => {
			const r = rig(path)
			await r.manager.startDecoder("dec")
			await vi.waitFor(() => expect(r.size()).toBeGreaterThan(0), ARRIVAL)
			const chanPid = r.chanPid()
			if (chanPid === undefined) throw new Error("no wavekit-chan pid")
			const firstPid = r.status().pid
			const firstChannel = r.channelId()
			expect(firstPid).toBeDefined()
			expect(firstChannel).toBeDefined()
			process.kill(chanPid, "SIGKILL")
			await vi.waitFor(() => {
				expect(r.status().running).toBe(true)
				expect(r.status().pid).not.toBe(firstPid)
			}, ARRIVAL)
			// The process exit invalidated the channel (not a client-gone), once.
			const ended = r.invalidations.filter(item =>
				item.ids.includes(firstChannel ?? ""),
			)
			expect(ended).toHaveLength(1)
			expect(ended[0]?.cause).not.toBe("client-gone")
			expect(r.restarting).toEqual([])
			expect(r.status()).toMatchObject({ restartCount: 0 })
			expect(r.status().lastError ?? null).toBeNull()
			expect(r.failures()).toBe(0)
			expect(r.chanPid()).not.toBe(chanPid)
		}, 60_000)

		it("killing the decoder gives the crash path", async () => {
			const r = rig(path)
			await r.manager.startDecoder("dec")
			await vi.waitFor(() => expect(r.size()).toBeGreaterThan(0), ARRIVAL)
			const pid = r.status().pid
			if (pid === undefined) throw new Error("no decoder pid")
			const channel = r.channelId()
			expect(channel).toBeDefined()
			process.kill(pid, "SIGKILL")
			await vi.waitFor(() => expect(r.restarting).toEqual(["dec"]), ARRIVAL)
			expect(r.status().lastError).toMatchObject({ kind: "exit" })
			// Classified by the channel's client-gone, not by the CHANNEL_FATE_MS fallback: the channelizer reported the
			// vanished reader (its warning is logged before the event) before the crash path scheduled the restart.
			expect(
				r.invalidations.filter(item => item.ids.includes(channel ?? "")),
			).toEqual([{ ids: [channel ?? ""], cause: "client-gone" }])
			const died = r.logged.indexOf("Channel died; invalidating it")
			const scheduled = r.logged.indexOf(
				"Decoder exited unexpectedly, scheduling restart - other decoders continue operating",
			)
			expect(died).toBeGreaterThanOrEqual(0)
			expect(scheduled).toBeGreaterThan(died)
			await vi.waitFor(() => expect(r.status().running).toBe(true), ARRIVAL)
			expect(r.status().restartCount).toBe(1)
		}, 60_000)

		it("a requested stop releases first: no client-gone, no invalidation", async () => {
			const r = rig(path)
			await r.manager.startDecoder("dec")
			await vi.waitFor(() => expect(r.size()).toBeGreaterThan(0), ARRIVAL)
			const invalidated: unknown[] = []
			r.chan.on("channel-invalidated", (...args: unknown[]) =>
				invalidated.push(args),
			)
			expect(r.channelId()).toBeDefined()
			await r.manager.stopDecoder("dec")
			await sleep(1000)
			expect(r.status().running).toBe(false)
			expect(r.chan.openChannelRows()).toEqual([])
			expect(invalidated).toEqual([])
			expect(r.logged).not.toContain("Channel died; invalidating it")
			expect(r.restarting).toEqual([])
			expect(r.channelEnds()).toBe(0)
		}, 60_000)
	},
)

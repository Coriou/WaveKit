/**
 * Direct channel input through the production guard: a real BaseDecoder subclass that awaits before its spawn (as the
 * packet adapter awaits its config file) under the real DecoderManager. When the granted channel ends or its socket
 * closes during that await, BaseDecoder refuses to spawn and the manager holds the decoder for its channel: no
 * process, no spawn error, no failure accounting. Only the child process is fake (spawn and the process-group signal
 * are replaced in this file); nothing is executed and nothing connects anywhere.
 */
import type * as ChildProcessModule from "node:child_process"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { BaseDecoder } from "../../../src/decoders/base-decoder.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import type * as ProcessToolsModule from "../../../src/decoders/process-tools.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import type {
	DecoderCaps,
	DecoderChannelRequestResult,
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"
import { FakeSources, deferred, iqCaps } from "../../mocks/rate-fakes.js"
import { CENTER, DirectProvider } from "./direct-channel-fakes.js"

/** A child that never runs: it reports `spawn` on the next microtask and exits when signalled. */
class FakeChild extends EventEmitter {
	readonly pid = 1
	readonly stdin = null
	readonly stdout = new PassThrough()
	readonly stderr = new PassThrough()
	exitCode: number | null = null
	signalCode: string | null = null
	killed = false
	private ended = false
	end(code: number | null, signal: string | null = null) {
		if (this.ended) return
		this.ended = true
		this.exitCode = code
		this.signalCode = signal
		this.stdout.end()
		this.stderr.end()
		this.emit("exit", code, signal)
		this.emit("close", code, signal)
	}
	kill(signal?: NodeJS.Signals) {
		this.signal(signal ?? "SIGTERM")
		return true
	}
	signal(signal: string) {
		if (this.ended || signal === "SIGKILL") return
		queueMicrotask(() => this.end(null, signal))
	}
}

vi.mock("node:child_process", async importOriginal => {
	const actual = await importOriginal<typeof ChildProcessModule>()
	return {
		...actual,
		spawn: vi.fn(() => {
			const child = new FakeChild()
			queueMicrotask(() => child.emit("spawn"))
			return child
		}),
	}
})

// The process-group signal goes to the fake child, never to a real process.
vi.mock("../../../src/decoders/process-tools.js", async importOriginal => {
	const actual = await importOriginal<typeof ProcessToolsModule>()
	return {
		...actual,
		signalDecoder: vi.fn((proc: unknown, signal: string) => {
			if (proc instanceof FakeChild) proc.signal(signal)
		}),
	}
})

/** A process decoder that awaits a gate between the manager's start and BaseDecoder's spawn. */
class AwaitingDecoder extends BaseDecoder {
	gate: ReturnType<typeof deferred> | null = null
	protected getCommand(): string {
		return "awaiting-decoder"
	}
	protected getArgs(): string[] {
		return []
	}
	protected parseOutput(): DecoderOutput | null {
		return null
	}
	protected getCaps(): DecoderCaps {
		return { input: "iq", output: "text", integrationPattern: "pure_consumer" }
	}
	getChannelRequest(): DecoderChannelRequestResult {
		return {
			centerHz: CENTER,
			bandwidthHz: 45_600,
			transitionHz: 1200,
			outputRateHz: 48_000,
			format: "cf32",
		}
	}
	override async start(): Promise<void> {
		const gate = this.gate
		this.gate = null
		if (gate) await gate.promise
		await super.start()
	}
}

const logger = pino({ level: "silent" })
const CONFIG: DecoderConfig = {
	id: "packet",
	type: "awaiting",
	enabled: true,
	options: {},
	useChannelizer: true,
}

let manager: DecoderManager
let provider: DirectProvider
let sources: FakeSources
let decoder: AwaitingDecoder
let restarting: string[]

beforeEach(() => {
	vi.useFakeTimers()
	vi.mocked(spawn).mockClear()
	sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_048_000), centerFreq: CENTER })
	const registry = new DecoderRegistry()
	registry.register(
		"awaiting",
		cfg => {
			decoder = new AwaitingDecoder(cfg, logger)
			return decoder
		},
		{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
	)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
		channelInput: "direct",
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	provider = new DirectProvider()
	manager.setChannelizer(provider)
	restarting = []
	manager.on("decoder:restarting", (id: string) => restarting.push(id))
	manager.createDecoder(CONFIG)
})

afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
	vi.restoreAllMocks()
})

function internalState() {
	return (
		manager as unknown as {
			decoders: Map<
				string,
				{
					consecutiveFailures: number
					suspension: { reasonCode: string } | null
				}
			>
		}
	).decoders.get("packet")!
}

describe.each([
	["the channel ends", () => provider.endGeneration("rtl", ["packet-g1"])],
	["its socket closes", () => provider.sockets.get("packet-g1")!.destroy()],
] as const)(
	"the real BaseDecoder guard: %s during an await before the spawn",
	(_name, lose) => {
		it("spawns no process; the decoder waits as a channel-loss hold with its accounting untouched", async () => {
			const gate = deferred()
			decoder.gate = gate
			const starting = manager.startDecoder("packet")
			await vi.waitFor(() => expect(provider.sockets.size).toBe(1))
			await vi.advanceTimersByTimeAsync(0)
			lose()
			gate.resolve()
			await starting
			expect(spawn).not.toHaveBeenCalled()
			const status = manager.getStatus("packet")
			expect(status).toMatchObject({
				running: false,
				suspended: true,
				restartCount: 0,
			})
			expect(internalState().suspension?.reasonCode).toBe(
				"channelizer-unavailable",
			)
			expect(status?.lastError ?? null).toBeNull()
			expect(internalState().consecutiveFailures).toBe(0)
			expect(restarting).toEqual([])
			expect(provider.sockets.get("packet-g1")?.destroyed).toBe(true)
		})
	},
)

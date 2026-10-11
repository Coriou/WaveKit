// tests/unit/decoders/manager-scanner.test.ts
/**
 * Signal discovery spec § 6.5 and § 10.4: scanner probes are runtime-only
 * decoders with their own input, and a sweep holds configured decoders on
 * its source once instead of suspending and resuming them on every hop.
 */
import { PassThrough, type Readable } from "node:stream"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	DecoderManager,
	type ScannerDecoderChannelBinding,
} from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type {
	DecoderCaps,
	DecoderChannelRequestResult,
} from "../../../src/decoders/types.js"
import { WaveKitError } from "../../../src/utils/errors.js"
import {
	FakeSources,
	RateDecoder,
	deferred,
	iqCaps,
} from "../../mocks/rate-fakes.js"
import { FakeChannelProvider } from "../../mocks/channel-fakes.js"
import type {
	ChannelRequestResult,
	DecoderChannelRequest,
} from "../../../src/core/channelizer/types.js"
import type { SourceCaps } from "../../../src/config.js"

const logger = pino({ level: "silent" })

type GrantedChannel = Extract<ChannelRequestResult, { ok: true }>
/** File-local scripted provider: synchronous events before resolution need no native process. */
class BindingProvider extends FakeChannelProvider {
	scripts: Array<() => Promise<ChannelRequestResult>> = []
	grant(
		channelId = "opaque:/grant α",
		generation = this.generation,
	): GrantedChannel {
		const stream = new PassThrough()
		this.streams.set(channelId, stream)
		return {
			ok: true,
			stream,
			channelId,
			generation,
			realised: { outputRateHz: 48_000, format: "cf32", groupDelaySamples: 17 },
		}
	}
	override requestChannel(
		sourceId: string,
		decoderId: string,
		req: DecoderChannelRequest,
		inputCaps: SourceCaps | undefined,
	): Promise<ChannelRequestResult> {
		this.calls.push({ sourceId, decoderId, req, inputCaps })
		return this.scripts.shift()?.() ?? Promise.resolve(this.grant())
	}
}

function pendingBindings() {
	return (
		manager as unknown as {
			pendingScannerChannels: Map<
				unknown,
				{ terminal: boolean; invalidated: Set<string> }
			>
		}
	).pendingScannerChannels
}

function bindingConfig(id = "scan-binding") {
	return { ...probeConfig(id), type: "binding-probe", useChannelizer: true }
}
const startBinding = (id = "scan-binding") =>
	manager.createEphemeralDecoder(bindingConfig(id), {
		owner: "scanner",
		jobId: "j1",
	})
const observed = (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(err: unknown) => err,
	)
const DEBOUNCE = 350
const iqDecoderCaps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}
let sources: FakeSources
let fanout: FanoutManager
let manager: DecoderManager
let decoders: Map<string, RateDecoder>
let created: string[]
let removed: string[]
let restarting: string[]

/**
 * Mirrors BaseDecoder's input handling (base-decoder.ts attachInput/start):
 * attachInput adds a `data` listener, so the stream starts flowing on the
 * next tick, and pipes to stdin only once a process exists; the process is
 * spawned after an await inside start().
 */
class StdinDecoder extends RateDecoder {
	readonly stdinBytes: Buffer[] = []
	trackedBytes = 0
	private stdin: PassThrough | null = null
	private readonly track = (chunk: Buffer): void => {
		this.trackedBytes += chunk.length
	}
	override async start(): Promise<void> {
		await new Promise<void>(resolve => process.nextTick(resolve)) // spawn
		await super.start()
		this.stdin = new PassThrough()
		this.stdin.on("data", (chunk: Buffer) => this.stdinBytes.push(chunk))
		this.input?.pipe(this.stdin)
	}
	override attachInput(input: Readable): void {
		super.attachInput(input)
		input.on("data", this.track)
		if (this.stdin) input.pipe(this.stdin)
	}
	override detachInput(): void {
		if (this.input && this.stdin) this.input.unpipe(this.stdin)
		this.input?.off("data", this.track)
		super.detachInput()
	}
}

/** Requests a channelizer channel (no scanner input), so wiring can fail. */
class ChannelProbe extends RateDecoder {
	getChannelRequest(): DecoderChannelRequestResult {
		return {
			centerHz: 446_000_000,
			bandwidthHz: 364_800,
			transitionHz: 9_600,
			outputRateHz: 384_000,
			format: "cu8",
		}
	}
}

class BindingProbe extends ChannelProbe {
	attached: Readable[] = []
	updates: Record<string, unknown> = {}
	override attachInput(stream: Readable): void {
		this.attached.push(stream)
		super.attachInput(stream)
	}
	override updateOptions(updates: Record<string, unknown>): void {
		Object.assign(this.updates, updates)
	}
}

function managerRegistry(): DecoderRegistry {
	return (manager as unknown as { registry: DecoderRegistry }).registry
}

const settle = () => vi.advanceTimersByTimeAsync(DEBOUNCE)
const ticks = async (n = 10) => {
	for (let i = 0; i < n; i++)
		await new Promise<void>(resolve => process.nextTick(resolve))
}
function createConfigured(id = "dmr") {
	manager.createDecoder({
		id,
		type: "rate-test",
		enabled: true,
		sourceId: "rtl",
		options: { input: "iq" },
	})
	return decoders.get(id)!
}
function probeConfig(id = "scan-j1-dmr-1") {
	return {
		id,
		type: "rate-test",
		enabled: true,
		sourceId: "rtl",
		options: { input: "iq" },
	}
}

describe("scanner opaque channel binding lifecycle", () => {
	let provider: BindingProvider
	let grants: ScannerDecoderChannelBinding[]
	let ends: Array<{ binding: ScannerDecoderChannelBinding; reason: string }>
	beforeEach(() => {
		provider = new BindingProvider()
		manager.setChannelizer(provider)
		managerRegistry().register(
			"binding-probe",
			config => {
				const decoder = new BindingProbe(config.id, iqDecoderCaps)
				decoders.set(config.id, decoder)
				return decoder
			},
			iqDecoderCaps,
		)
		grants = []
		ends = []
		manager.on("decoder:scanner-channel-granted", binding =>
			grants.push(binding),
		)
		manager.on("decoder:scanner-channel-ended", (binding, reason) =>
			ends.push({ binding, reason }),
		)
	})

	it("publishes frozen actual metadata before create resolves and reuses that detached snapshot", async () => {
		const result = provider.grant()
		provider.scripts.push(() => Promise.resolve(result))
		const order: string[] = []
		manager.on("decoder:scanner-channel-granted", () => {
			order.push("granted")
			result.realised.outputRateHz = 1
			result.realised.groupDelaySamples = 999
		})
		await startBinding()
		order.push("resolved")
		expect(order).toEqual(["granted", "resolved"])
		expect(grants[0]).toEqual({
			decoderId: "scan-binding",
			sourceId: "rtl",
			channelId: "opaque:/grant α",
			generation: 1,
			realised: { outputRateHz: 48_000, format: "cf32", groupDelaySamples: 17 },
		})
		expect(Object.isFrozen(grants[0])).toBe(true)
		expect(Object.isFrozen(grants[0]!.realised)).toBe(true)
		expect(
			(decoders.get("scan-binding") as BindingProbe).updates,
		).toMatchObject({ inputSampleRate: 48_000, inputIqFormat: "cf32" })
		await manager.removeEphemeralDecoder("scan-binding")
		expect(ends).toEqual([{ binding: grants[0], reason: "released" }])
		expect(ends[0]!.binding).toBe(grants[0])
		expect(provider.released).toEqual([result.channelId])
		expect(pendingBindings().size).toBe(0)
	})

	it.each([false, true])(
		"rejects exact pre-resolution invalidation, including unchanged generation=%s, without retry",
		async sameGeneration => {
			const result = provider.grant()
			provider.scripts.push(() => {
				provider.emit("channel-invalidated", "rtl", 1, [result.channelId])
				if (!sameGeneration) provider.generation++
				return Promise.resolve(result)
			})
			expect(await observed(startBinding())).toMatchObject({
				code: "PROBE_NOT_WIRED",
			})
			const decoder = decoders.get("scan-binding") as BindingProbe
			expect(decoder.starts).toBe(0)
			expect(decoder.attached).toEqual([])
			expect(provider.calls).toHaveLength(1)
			expect(provider.released).toEqual([result.channelId])
			expect(result.stream.destroyed).toBe(true)
			expect(grants).toEqual([])
			expect(ends).toEqual([])
			expect(pendingBindings().size).toBe(0)
		},
	)

	it.each(["destroyed", "ended"])(
		"rejects a successful %s stream even without an invalidation",
		async dead => {
			const result = provider.grant()
			if (dead === "destroyed") result.stream.destroy()
			else {
				const endedStream = new PassThrough({ autoDestroy: false })
				result.stream = endedStream
				provider.streams.set(result.channelId, endedStream)
				result.stream.resume()
				result.stream.push(null)
				await ticks()
				expect(result.stream.readableEnded).toBe(true)
				expect(result.stream.destroyed).toBe(false)
			}
			provider.scripts.push(() => Promise.resolve(result))
			expect(await observed(startBinding())).toMatchObject({
				code: "PROBE_NOT_WIRED",
			})
			expect(provider.calls).toHaveLength(1)
			expect(provider.released).toEqual([result.channelId])
			expect(grants).toEqual([])
			expect((decoders.get("scan-binding") as BindingProbe).attached).toEqual(
				[],
			)
		},
	)

	it.each([false, true])(
		"ends during deferred start and stops the late process, consumer removal=%s",
		async remove => {
			const creating = observed(startBinding())
			const decoder = decoders.get("scan-binding") as BindingProbe
			const gate = deferred()
			decoder.startGate = gate
			await ticks()
			expect(decoder.starts).toBe(1)
			let removal: Promise<void> | undefined
			if (remove)
				manager.on("decoder:scanner-channel-ended", binding => {
					removal = manager.removeEphemeralDecoder(binding.decoderId)
				})
			provider.emit("channel-invalidated", "rtl", 1, [grants[0]!.channelId])
			expect(ends).toEqual([{ binding: grants[0], reason: "invalidated" }])
			expect(decoder.input).toBeNull()
			gate.resolve()
			expect(await creating).toMatchObject({ code: "PROBE_REMOVED" })
			await removal
			expect(decoder.running).toBe(false)
			expect(decoder.attached).toHaveLength(1)
			expect(provider.released).toEqual([])
			expect(manager.getDecoder("scan-binding")).toBeUndefined()
		},
	)

	it("grant callback removal and repeated ended removal cannot resurrect or double release", async () => {
		const removals: Promise<void>[] = []
		manager.on("decoder:scanner-channel-granted", binding => {
			removals.push(manager.removeEphemeralDecoder(binding.decoderId))
		})
		manager.on("decoder:scanner-channel-ended", binding => {
			expect(
				(
					manager as unknown as { decoders: Map<string, { channel: unknown }> }
				).decoders.get(binding.decoderId)!.channel,
			).toBeNull()
			removals.push(manager.removeEphemeralDecoder(binding.decoderId))
		})
		expect(await observed(startBinding())).toMatchObject({
			code: "PROBE_REMOVED",
		})
		await Promise.all(removals)
		expect(grants).toHaveLength(1)
		expect(ends).toHaveLength(1)
		expect(provider.released).toEqual([grants[0]!.channelId])
		expect((decoders.get("scan-binding") as BindingProbe).starts).toBe(0)
		expect((decoders.get("scan-binding") as BindingProbe).attached).toEqual([])
		expect(removed.filter(id => id === "scan-binding")).toHaveLength(1)
	})

	it.each(["stop", "swap", "destroy"])(
		"grant callback %s ends the installed binding before attachment",
		async action => {
			let cleanup: Promise<void> | undefined
			manager.once("decoder:scanner-channel-granted", binding => {
				if (action === "stop") cleanup = manager.stopDecoder(binding.decoderId)
				else if (action === "destroy") cleanup = manager.destroy()
				else manager.setChannelizer(new BindingProvider())
			})
			expect(await observed(startBinding())).toBeInstanceOf(WaveKitError)
			await cleanup
			expect(grants).toHaveLength(1)
			expect(ends).toEqual([{ binding: grants[0], reason: "released" }])
			expect(provider.released).toEqual([grants[0]!.channelId])
			expect((decoders.get("scan-binding") as BindingProbe).attached).toEqual(
				[],
			)
			expect((decoders.get("scan-binding") as BindingProbe).starts).toBe(0)
		},
	)

	it("records pending exact invalidation before notifying an already adopted binding", async () => {
		provider.scripts.push(() => Promise.resolve(provider.grant("adopted")))
		await startBinding("scan-adopted")
		const gate = deferred()
		const result = provider.grant("pending")
		provider.scripts.push(async () => {
			await gate.promise
			return result
		})
		const creating = observed(startBinding("scan-pending"))
		const token = [...pendingBindings().values()][0]!
		manager.once("decoder:scanner-channel-ended", () => {
			expect(token.invalidated.has(JSON.stringify([1, "pending"]))).toBe(true)
		})
		provider.emit("channel-invalidated", "rtl", 1, ["adopted", "pending"])
		gate.resolve()
		expect(await creating).toMatchObject({ code: "PROBE_NOT_WIRED" })
		expect(provider.released).toEqual(["pending"])
		expect(grants.map(binding => binding.decoderId)).toEqual(["scan-adopted"])
	})

	it.each(["grant", "end", "detach", "update", "attach", "release"])(
		"keeps resource cleanup after a throwing %s callback",
		async phase => {
			const result = provider.grant()
			provider.scripts.push(() => Promise.resolve(result))
			if (phase === "grant")
				manager.on("decoder:scanner-channel-granted", () => {
					throw new WaveKitError("listener", "TEST")
				})
			if (phase === "end")
				manager.on("decoder:scanner-channel-ended", () => {
					throw new WaveKitError("listener", "TEST")
				})
			if (phase === "release")
				provider.releaseChannel = id => {
					provider.released.push(id)
					throw new WaveKitError("release", "TEST")
				}
			const creating = observed(startBinding())
			const decoder = decoders.get("scan-binding") as BindingProbe
			if (phase === "detach")
				decoder.detachInput = () => {
					throw new WaveKitError("detach", "TEST")
				}
			if (phase === "update")
				decoder.updateOptions = () => {
					throw new WaveKitError("update", "TEST")
				}
			if (phase === "attach")
				decoder.attachInput = () => {
					throw new WaveKitError("attach", "TEST")
				}
			const outcome = await creating
			if (["grant", "update", "attach"].includes(phase))
				expect(outcome).toBeInstanceOf(WaveKitError)
			else {
				expect(outcome).toBeNull()
				await manager.removeEphemeralDecoder("scan-binding")
			}
			expect(provider.released).toEqual([result.channelId])
			expect(result.stream.destroyed).toBe(true)
			expect(ends).toHaveLength(1)
			expect(pendingBindings().size).toBe(0)
		},
	)

	it("exact source, generation and opaque ID filter both pending and adopted notifications", async () => {
		const gate = deferred()
		const result = provider.grant()
		provider.scripts.push(async () => {
			await gate.promise
			return result
		})
		const creating = observed(startBinding())
		provider.emit("channel-invalidated", "another-source", 1, [
			result.channelId,
		])
		provider.emit("channel-invalidated", "rtl", 2, [result.channelId])
		provider.emit("channel-invalidated", "rtl", 1, ["unrelated"])
		gate.resolve()
		expect(await creating).toBeNull()
		provider.emit("channel-invalidated", "another-source", 1, [
			result.channelId,
		])
		provider.emit("channel-invalidated", "rtl", 2, [result.channelId])
		provider.emit("channel-invalidated", "rtl", 1, ["unrelated"])
		expect(ends).toEqual([])
		expect(decoders.get("scan-binding")!.input).toBe(result.stream)
		provider.emit("channel-invalidated", "rtl", 1, [result.channelId])
		provider.emit("channel-invalidated", "rtl", 1, [result.channelId])
		await manager.removeEphemeralDecoder("scan-binding")
		expect(ends).toEqual([{ binding: grants[0], reason: "invalidated" }])
		expect(provider.released).toEqual([])
	})

	it("provider collision and captured old listener cannot poison a new pending or adopted grant", async () => {
		const old = provider
		const oldListener = old.listeners("channel-invalidated")[0] as (
			source: string,
			generation: number,
			ids: string[],
		) => void
		const gate = deferred()
		const oldResult = old.grant()
		old.scripts.push(async () => {
			await gate.promise
			return oldResult
		})
		const first = observed(startBinding("scan-old"))
		const next = new BindingProvider()
		manager.setChannelizer(next)
		const newGate = deferred()
		const nextResult = next.grant()
		next.scripts.push(async () => {
			await newGate.promise
			return nextResult
		})
		const successor = observed(startBinding("scan-new"))
		oldListener("rtl", 1, [oldResult.channelId])
		old.emit("channel-invalidated", "rtl", 1, [oldResult.channelId])
		newGate.resolve()
		expect(await successor).toBeNull()
		gate.resolve()
		expect(await first).toMatchObject({ code: "PROBE_NOT_WIRED" })
		expect(old.released).toEqual([oldResult.channelId])
		expect(next.released).toEqual([])
		expect(nextResult.stream.destroyed).toBe(false)
		expect(grants.map(binding => binding.decoderId)).toEqual(["scan-new"])
		expect(old.listenerCount("channel-invalidated")).toBe(0)
		expect(next.listenerCount("channel-invalidated")).toBe(1)
	})

	it("A→B→A terminally fences pending A and leaves one subscription on the new A installation", async () => {
		const listener = provider.listeners("channel-invalidated")[0] as (
			source: string,
			generation: number,
			ids: string[],
		) => void
		const gate = deferred()
		const result = provider.grant()
		provider.scripts.push(async () => {
			await gate.promise
			return result
		})
		const creating = observed(startBinding())
		const other = new BindingProvider()
		manager.setChannelizer(other)
		manager.setChannelizer(provider)
		manager.setChannelizer(provider)
		expect(pendingBindings().size).toBe(0)
		gate.resolve()
		expect(await creating).toMatchObject({ code: "PROBE_NOT_WIRED" })
		expect(provider.released).toEqual([result.channelId])
		const nextGate = deferred()
		const nextResult = provider.grant("next-opaque")
		provider.scripts.push(async () => {
			await nextGate.promise
			return nextResult
		})
		const next = observed(startBinding("scan-next"))
		listener("rtl", 1, [nextResult.channelId])
		nextGate.resolve()
		expect(await next).toBeNull()
		expect(provider.listenerCount("channel-invalidated")).toBe(1)
		expect(other.listenerCount("channel-invalidated")).toBe(0)
		await manager.destroy()
		expect(provider.listenerCount("channel-invalidated")).toBe(0)
	})

	it("claims both adopted A refs before a reentrant A→B→A swap and preserves a new A grant", async () => {
		const x = provider.grant("old-X")
		provider.scripts.push(() => Promise.resolve(x))
		await startBinding("scan-X")
		const y = provider.grant("old-Y")
		provider.scripts.push(() => Promise.resolve(y))
		const creatingY = observed(startBinding("scan-Y"))
		const decoderY = decoders.get("scan-Y") as BindingProbe
		const startGate = deferred()
		decoderY.startGate = startGate
		await ticks()
		expect(decoderY.starts).toBe(1)
		expect(grants.map(binding => binding.decoderId)).toEqual([
			"scan-X",
			"scan-Y",
		])
		const next = new BindingProvider()
		const fresh = provider.grant("new-A")
		let successor: Promise<unknown> | undefined
		manager.once("decoder:scanner-channel-ended", binding => {
			expect(binding.decoderId).toBe("scan-X")
			const states = (
				manager as unknown as {
					decoders: Map<
						string,
						{ channel: unknown; scannerChannelAttempt: unknown }
					>
				}
			).decoders
			expect(states.get("scan-X")!.channel).toBeNull()
			expect(states.get("scan-Y")!.channel).toBeNull()
			expect(states.get("scan-Y")!.scannerChannelAttempt).toBeNull()
			manager.setChannelizer(provider)
			provider.scripts.push(() => Promise.resolve(fresh))
			successor = startBinding("scan-new-A")
		})
		manager.setChannelizer(next)
		expect(
			ends.map(({ binding, reason }) => [binding.decoderId, reason]),
		).toEqual([
			["scan-X", "released"],
			["scan-Y", "released"],
		])
		expect(provider.released).toEqual(["old-X", "old-Y"])
		expect(next.released).toEqual([])
		expect(decoders.get("scan-X")!.input).toBeNull()
		expect(decoderY.input).toBeNull()
		expect(x.stream.destroyed).toBe(true)
		expect(y.stream.destroyed).toBe(true)
		await successor
		startGate.resolve()
		expect(await creatingY).toMatchObject({ code: "PROBE_REMOVED" })
		expect(decoderY.running).toBe(false)
		expect(decoderY.stops).toBeGreaterThanOrEqual(1)
		expect(manager.getDecoder("scan-Y")).toBeUndefined()
		expect(manager.getStatus("scan-new-A")!.running).toBe(true)
		expect(decoders.get("scan-new-A")!.input).toBe(fresh.stream)
		expect(fresh.stream.destroyed).toBe(false)
		provider.emit("channel-invalidated", "rtl", 1, ["old-X", "old-Y"])
		expect(ends).toHaveLength(2)
		expect(provider.released).toEqual(["old-X", "old-Y"])
		expect(provider.listenerCount("channel-invalidated")).toBe(1)
		expect(next.listenerCount("channel-invalidated")).toBe(0)
	})

	it("reentrant removal of another claimed ref ends it before stop and cleans it once", async () => {
		provider.scripts.push(() => Promise.resolve(provider.grant("claimed-X")))
		await startBinding("scan-X")
		provider.scripts.push(() => Promise.resolve(provider.grant("claimed-Y")))
		await startBinding("scan-Y")
		const decoderY = decoders.get("scan-Y")!
		const order: string[] = []
		const stop = decoderY.stop.bind(decoderY)
		decoderY.stop = async () => {
			order.push("stop-Y")
			await stop()
		}
		manager.on("decoder:scanner-channel-ended", binding => {
			order.push(`ended-${binding.decoderId}`)
		})
		let removingY: Promise<void> | undefined
		manager.once("decoder:scanner-channel-ended", () => {
			removingY = manager.removeEphemeralDecoder("scan-Y")
		})
		manager.setChannelizer(new BindingProvider())
		await removingY
		expect(order.indexOf("ended-scan-Y")).toBeGreaterThanOrEqual(0)
		expect(order.indexOf("ended-scan-Y")).toBeLessThan(order.indexOf("stop-Y"))
		expect(ends.map(({ binding }) => binding.decoderId)).toEqual([
			"scan-X",
			"scan-Y",
		])
		expect(ends.every(({ reason }) => reason === "released")).toBe(true)
		expect(provider.released).toHaveLength(2)
		expect(new Set(provider.released).size).toBe(2)
		expect(decoderY.input).toBeNull()
		expect(manager.getDecoder("scan-Y")).toBeUndefined()
	})

	it("ended callback removal installs a same-ID successor without stale outer cleanup", async () => {
		await startBinding()
		const oldDecoder = decoders.get("scan-binding")!
		let successor: Promise<unknown> | undefined
		let replacement: Promise<void> | undefined
		manager.once("decoder:scanner-channel-ended", binding => {
			replacement = manager
				.removeEphemeralDecoder(binding.decoderId)
				.then(() => {
					provider.scripts.push(() =>
						Promise.resolve(provider.grant("replacement-opaque")),
					)
					successor = startBinding(binding.decoderId)
				})
		})
		await manager.removeEphemeralDecoder("scan-binding")
		await replacement
		await successor
		expect(manager.getDecoder("scan-binding")).toBe(
			decoders.get("scan-binding"),
		)
		expect(manager.getDecoder("scan-binding")).not.toBe(oldDecoder)
		expect(manager.getStatus("scan-binding")!.running).toBe(true)
		expect(sources.assignments.get("scan-binding")).toBe("rtl")
		expect(ends).toHaveLength(1)
		expect(provider.released).toEqual(["opaque:/grant α"])
		provider.emit("channel-invalidated", "rtl", 1, ["opaque:/grant α"])
		expect(ends).toHaveLength(1)
	})

	it("throwing ended listener does not skip subsequent listeners or other affected bindings", async () => {
		provider.scripts.push(() => Promise.resolve(provider.grant("first-opaque")))
		await startBinding("scan-first")
		provider.scripts.push(() =>
			Promise.resolve(provider.grant("second-opaque")),
		)
		await startBinding("scan-second")
		manager.on("decoder:scanner-channel-ended", () => {
			throw new WaveKitError("listener", "TEST")
		})
		const fenced: string[] = []
		manager.on("decoder:scanner-channel-ended", binding =>
			fenced.push(binding.decoderId),
		)
		provider.emit("channel-invalidated", "rtl", 1, [
			"first-opaque",
			"second-opaque",
		])
		expect(fenced).toEqual(["scan-first", "scan-second"])
		expect(ends).toHaveLength(2)
		expect(decoders.get("scan-first")!.input).toBeNull()
		expect(decoders.get("scan-second")!.input).toBeNull()
		expect(provider.released).toEqual([])
	})

	it.each(["grant", "update", "attach", "started", "status"])(
		"reentrant invalidation at %s cannot publish successful startup",
		async phase => {
			const invalidate = () =>
				provider.emit("channel-invalidated", "rtl", 1, ["opaque:/grant α"])
			if (phase === "grant")
				manager.once("decoder:scanner-channel-granted", invalidate)
			const creating = observed(startBinding())
			const decoder = decoders.get("scan-binding") as BindingProbe
			if (phase === "update") {
				const update = decoder.updateOptions.bind(decoder)
				decoder.updateOptions = values => {
					update(values)
					if (values["inputIqFormat"]) invalidate()
				}
			}
			if (phase === "attach") {
				const attach = decoder.attachInput.bind(decoder)
				decoder.attachInput = stream => {
					attach(stream)
					invalidate()
				}
			}
			if (phase === "started") decoder.once("started", invalidate)
			if (phase === "status") manager.once("decoder:status-changed", invalidate)
			expect(await creating).toBeInstanceOf(WaveKitError)
			expect(ends).toHaveLength(1)
			expect(provider.released).toEqual([])
			expect(decoder.running).toBe(false)
			expect(decoder.input).toBeNull()
			expect(manager.getDecoder("scan-binding")).toBeUndefined()
		},
	)

	it("source selection changes before resolution reject the old acquisition", async () => {
		const gate = deferred()
		const result = provider.grant()
		provider.scripts.push(async () => {
			await gate.promise
			return result
		})
		const config = bindingConfig()
		const creating = observed(
			manager.createEphemeralDecoder(config, { owner: "scanner", jobId: "j1" }),
		)
		config.sourceId = "another-source"
		gate.resolve()
		expect(await creating).toMatchObject({ code: "PROBE_NOT_WIRED" })
		expect(provider.released).toEqual([result.channelId])
		expect(grants).toEqual([])
	})

	it("a synchronous owner cancellation during registration is not overwritten by startup intent", async () => {
		let removal: Promise<void> | undefined
		manager.once("decoder:created", id => {
			removal = manager.removeEphemeralDecoder(id)
		})
		expect(await observed(startBinding())).toMatchObject({
			code: "PROBE_REMOVED",
		})
		await removal
		expect(provider.calls).toEqual([])
		expect(provider.released).toEqual([])
		expect(pendingBindings().size).toBe(0)
		expect(manager.getDecoder("scan-binding")).toBeUndefined()
	})

	it("stop-only registration cancellation removes the original probe and permits the same ID again", async () => {
		let stopping: Promise<void> | undefined
		manager.once("decoder:created", id => {
			stopping = manager.stopDecoder(id)
		})
		const creating = observed(startBinding())
		const original = decoders.get("scan-binding")!
		expect(await creating).toMatchObject({ code: "PROBE_REMOVED" })
		await stopping
		expect(manager.getDecoder("scan-binding")).toBeUndefined()
		expect(original.eventNames()).toEqual([])
		expect(original.starts).toBe(0)
		expect(original.input).toBeNull()
		expect(sources.assignments.has("scan-binding")).toBe(false)
		expect(provider.calls).toEqual([])
		expect(provider.released).toEqual([])
		expect(grants).toEqual([])
		expect(ends).toEqual([])
		expect(pendingBindings().size).toBe(0)
		expect(removed.filter(id => id === "scan-binding")).toHaveLength(1)
		await startBinding()
		expect(manager.getDecoder("scan-binding")).not.toBe(original)
		expect(manager.getStatus("scan-binding")!.running).toBe(true)
	})

	it("removal and ended events initiate cleanup without claiming the provider close barrier settled", async () => {
		await startBinding()
		const gate = deferred()
		let settled = false
		provider.releaseChannel = id => {
			provider.released.push(id)
			return gate.promise.then(() => {
				settled = true
			})
		}
		await manager.removeEphemeralDecoder("scan-binding")
		expect(ends).toHaveLength(1)
		expect(settled).toBe(false)
		expect(provider.released).toHaveLength(1)
		gate.resolve()
		await gate.promise
	})

	it("handles a rejected release promise once and still destroys the owned stream", async () => {
		const result = provider.grant()
		provider.scripts.push(() => Promise.resolve(result))
		await startBinding()
		provider.releaseChannel = id => {
			provider.released.push(id)
			return Promise.reject(new WaveKitError("release rejection", "TEST"))
		}
		await manager.removeEphemeralDecoder("scan-binding")
		await ticks()
		await manager.removeEphemeralDecoder("scan-binding")
		expect(provider.released).toEqual([result.channelId])
		expect(result.stream.destroyed).toBe(true)
		expect(ends).toEqual([{ binding: grants[0], reason: "released" }])
	})

	it("offset and configured channel paths emit no scanner binding notifications", async () => {
		await manager.createEphemeralDecoder(probeConfig("scan-offset"), {
			owner: "scanner",
			jobId: "j1",
			input: new PassThrough(),
		})
		await manager.removeEphemeralDecoder("scan-offset")
		manager.createDecoder(bindingConfig("configured"))
		await manager.startDecoder("configured")
		await manager.stopDecoder("configured")
		expect(grants).toEqual([])
		expect(ends).toEqual([])
	})

	it.each(["stop", "remove", "destroy"])(
		"%s unregisters pending work before its late actual result and releases nothing pregrant",
		async action => {
			const gate = deferred()
			const result = provider.grant()
			provider.scripts.push(async () => {
				await gate.promise
				return result
			})
			const creating = observed(startBinding())
			const token = [...pendingBindings().values()][0]!
			if (action === "stop") await manager.stopDecoder("scan-binding")
			else if (action === "remove")
				await manager.removeEphemeralDecoder("scan-binding")
			else await manager.destroy()
			expect(provider.released).toEqual([])
			expect(pendingBindings().size).toBe(0)
			provider.emit(
				"channel-invalidated",
				"rtl",
				1,
				Array.from({ length: 1000 }, (_, i) => `late-${i}`),
			)
			expect(token.invalidated.size).toBe(0)
			gate.resolve()
			expect(await creating).toMatchObject({ code: "PROBE_REMOVED" })
			expect(provider.released).toEqual([result.channelId])
			expect(grants).toEqual([])
			expect(ends).toEqual([])
		},
	)

	it.each(["denied", "throw", "reject"])(
		"%s clears registration with no invented grant/release or retry",
		async action => {
			provider.scripts.push(() => {
				if (action === "throw") throw new WaveKitError("fake request", "TEST")
				if (action === "reject")
					return Promise.reject(new WaveKitError("fake request", "TEST"))
				return Promise.resolve({
					ok: false,
					reasonCode: "channelizer-unavailable",
					detail: "arbitrary denial text",
				})
			})
			expect(await observed(startBinding())).toMatchObject({
				code: "PROBE_NOT_WIRED",
			})
			expect(provider.released).toEqual([])
			expect(provider.calls).toHaveLength(1)
			expect(pendingBindings().size).toBe(0)
			expect(grants).toEqual([])
			await startBinding("scan-next")
			expect(grants).toHaveLength(1)
		},
	)

	it.each([64, 65, 10000])(
		"bounds %s pending identities, deduplicates exact tuples and isolates overflow",
		async count => {
			const gate = deferred()
			const result = provider.grant()
			provider.scripts.push(async () => {
				await gate.promise
				return result
			})
			const creating = observed(startBinding())
			const token = [...pendingBindings().values()][0]!
			provider.emit(
				"channel-invalidated",
				"wrong-source",
				1,
				Array.from({ length: 100 }, (_, i) => `wrong-${i}`),
			)
			expect(token.invalidated.size).toBe(0)
			provider.emit(
				"channel-invalidated",
				"rtl",
				1,
				Array.from({ length: 64 }, (_, i) => `id:${i}`),
			)
			expect(token.invalidated.size).toBe(64)
			provider.emit("channel-invalidated", "rtl", 1, Array(100).fill("id:0"))
			expect(token.invalidated.size).toBe(64)
			if (count > 64)
				provider.emit(
					"channel-invalidated",
					"rtl",
					1,
					Array.from({ length: count - 64 }, (_, i) => `overflow-${i}`),
				)
			expect(token.invalidated.size).toBeLessThanOrEqual(64)
			expect(token.terminal).toBe(count > 64)
			provider.scripts.push(() =>
				Promise.resolve(provider.grant("unrelated-opaque")),
			)
			await startBinding("scan-unrelated")
			gate.resolve()
			const outcome = await creating
			if (count === 64) expect(outcome).toBeNull()
			else expect(outcome).toMatchObject({ code: "PROBE_NOT_WIRED" })
			expect(manager.getDecoder("scan-unrelated")!.getStatus().running).toBe(
				true,
			)
			expect(pendingBindings().size).toBe(0)
			expect(token.invalidated.size).toBe(0)
		},
	)

	it("overflow on one source leaves a concurrently pending unrelated source usable", async () => {
		sources.caps.set("other", { ...iqCaps(2_400_000), centerFreq: 446_000_000 })
		const rtlGate = deferred()
		const otherGate = deferred()
		const rtl = provider.grant("rtl-late")
		const other = provider.grant("other-live")
		provider.scripts.push(async () => {
			await rtlGate.promise
			return rtl
		})
		provider.scripts.push(async () => {
			await otherGate.promise
			return other
		})
		const rtlCreating = observed(startBinding("scan-rtl"))
		const otherCreating = observed(
			manager.createEphemeralDecoder(
				{ ...bindingConfig("scan-other"), sourceId: "other" },
				{ owner: "scanner", jobId: "j1" },
			),
		)
		const tokens = [...pendingBindings().values()]
		expect(tokens).toHaveLength(2)
		provider.emit(
			"channel-invalidated",
			"rtl",
			1,
			Array.from({ length: 65 }, (_, i) => `rtl-${i}`),
		)
		expect(tokens[0]!.terminal).toBe(true)
		expect(tokens[1]!.terminal).toBe(false)
		expect(tokens[1]!.invalidated.size).toBe(0)
		expect(pendingBindings().size).toBe(1)
		otherGate.resolve()
		expect(await otherCreating).toBeNull()
		rtlGate.resolve()
		expect(await rtlCreating).toMatchObject({ code: "PROBE_NOT_WIRED" })
		expect(grants.map(binding => binding.sourceId)).toEqual(["other"])
		expect(manager.getStatus("scan-other")!.running).toBe(true)
		expect(other.stream.destroyed).toBe(false)
		expect(provider.released).toEqual(["rtl-late"])
		expect(pendingBindings().size).toBe(0)
	})

	it.each(["release-first", "invalidate-first", "swap-first"])(
		"%s emits one terminal event and fences evidence before cleanup callbacks",
		async action => {
			await startBinding()
			const decoder = decoders.get("scan-binding") as BindingProbe
			let fenced = false
			const order: string[] = []
			manager.on("decoder:scanner-channel-ended", () => {
				fenced = true
				order.push("ended")
			})
			const detach = decoder.detachInput.bind(decoder)
			decoder.detachInput = () => {
				expect(fenced).toBe(true)
				order.push("detach")
				detach()
			}
			const release = provider.releaseChannel.bind(provider)
			provider.releaseChannel = id => {
				expect(fenced).toBe(true)
				order.push("release")
				return release(id)
			}
			if (action === "invalidate-first")
				provider.emit("channel-invalidated", "rtl", 1, [grants[0]!.channelId])
			else if (action === "swap-first")
				manager.setChannelizer(new BindingProvider())
			await manager.removeEphemeralDecoder("scan-binding")
			provider.emit("channel-invalidated", "rtl", 1, [grants[0]!.channelId])
			expect(ends).toHaveLength(1)
			expect(order[0]).toBe("ended")
			expect(provider.released).toHaveLength(
				action === "invalidate-first" ? 0 : 1,
			)
		},
	)
})

beforeEach(() => {
	vi.useFakeTimers()
	sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 446_000_000 })
	decoders = new Map()
	const registry = new DecoderRegistry()
	registry.register(
		"rate-test",
		config => {
			const decoder = new RateDecoder(config.id, {
				input: config.options["input"] as DecoderCaps["input"],
				output: "text",
				integrationPattern: "pure_consumer",
			})
			decoders.set(config.id, decoder)
			return decoder
		},
		iqDecoderCaps,
	)
	registry.register(
		"stdin-test",
		config => {
			const decoder = new StdinDecoder(config.id, iqDecoderCaps)
			decoders.set(config.id, decoder)
			return decoder
		},
		iqDecoderCaps,
	)
	fanout = new FanoutManager(logger)
	manager = new DecoderManager(registry, fanout, logger, {
		restartDelay: 10,
		maxRestartDelay: 40,
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
	created = []
	removed = []
	restarting = []
	manager.on("decoder:created", (id: string) => created.push(id))
	manager.on("decoder:removed", (id: string) => removed.push(id))
	manager.on("decoder:restarting", (id: string) => restarting.push(id))
})
afterEach(async () => {
	await manager.destroy()
	vi.useRealTimers()
})

describe("ephemeral scanner probes", () => {
	it("starts on the scanner's input, reports owner/job/ephemeral, and emits created", async () => {
		const input = new PassThrough()
		await manager.createEphemeralDecoder(probeConfig(), {
			owner: "scanner",
			jobId: "j1",
			input,
		})
		const probe = decoders.get("scan-j1-dmr-1")!
		expect(probe.running).toBe(true)
		expect(probe.input).toBe(input)
		expect(manager.getStatus("scan-j1-dmr-1")).toMatchObject({
			owner: "scanner",
			scannerJobId: "j1",
			ephemeral: true,
			sourceId: "rtl",
			desiredRunning: true,
		})
		expect(created).toEqual(["scan-j1-dmr-1"])
	})

	it("pipes the pre-roll buffered before the spawn to the process (spec § 6.5)", async () => {
		const input = new PassThrough()
		const preRoll = Buffer.alloc(4096, 1)
		input.write(preRoll) // the probe pool writes the pre-roll before creating the probe
		await manager.createEphemeralDecoder(
			{ ...probeConfig("scan-pre"), type: "stdin-test" },
			{ owner: "scanner", jobId: "j1", input },
		)
		const live = Buffer.alloc(1024, 2)
		input.write(live)
		await ticks()
		const probe = decoders.get("scan-pre") as StdinDecoder
		expect(Buffer.concat(probe.stdinBytes)).toEqual(
			Buffer.concat([preRoll, live]),
		)
		expect(probe.trackedBytes).toBe(preRoll.length + live.length)
	})

	it("configured decoders report owner config and no probe fields", () => {
		createConfigured()
		const status = manager.getStatus("dmr")!
		expect(status.owner).toBe("config")
		expect(status.ephemeral).toBeUndefined()
		expect(status.scannerJobId).toBeUndefined()
		expect(created).toEqual(["dmr"])
	})

	it("rejects an id that already exists", async () => {
		createConfigured("scan-j1-dmr-1")
		await expect(
			manager.createEphemeralDecoder(probeConfig(), {
				owner: "scanner",
				jobId: "j1",
			}),
		).rejects.toMatchObject({ code: "DECODER_EXISTS" })
	})

	it("a failed start removes the probe and rethrows", async () => {
		managerRegistry().register(
			"failing",
			config => {
				const decoder = new RateDecoder(config.id, iqDecoderCaps)
				decoder.failStart = true
				return decoder
			},
			iqDecoderCaps,
		)
		await expect(
			manager.createEphemeralDecoder(
				{ ...probeConfig("scan-x"), type: "failing" },
				{ owner: "scanner", jobId: "j1" },
			),
		).rejects.toThrow("spawn failed")
		expect(manager.getStatus("scan-x")).toBeUndefined()
		expect(removed).toEqual(["scan-x"])
		expect(sources.assignments.has("scan-x")).toBe(false)
	})

	it("a failed start whose stop also fails is still removed and rethrows the start error", async () => {
		managerRegistry().register(
			"failing-both",
			config => {
				const decoder = new RateDecoder(config.id, iqDecoderCaps)
				decoder.failStart = true
				decoder.failStop = true
				return decoder
			},
			iqDecoderCaps,
		)
		await expect(
			manager.createEphemeralDecoder(
				{ ...probeConfig("scan-y"), type: "failing-both" },
				{ owner: "scanner", jobId: "j1" },
			),
		).rejects.toThrow("spawn failed")
		expect(manager.getStatus("scan-y")).toBeUndefined()
		expect(removed).toEqual(["scan-y"])
		expect(sources.assignments.has("scan-y")).toBe(false)
	})

	it("removeEphemeralDecoder removes the probe even when its stop fails", async () => {
		await manager.createEphemeralDecoder(probeConfig(), {
			owner: "scanner",
			jobId: "j1",
			input: new PassThrough(),
		})
		decoders.get("scan-j1-dmr-1")!.failStop = true
		await expect(
			manager.removeEphemeralDecoder("scan-j1-dmr-1"),
		).rejects.toThrow("stop failed")
		expect(manager.getStatus("scan-j1-dmr-1")).toBeUndefined()
		expect(removed).toEqual(["scan-j1-dmr-1"])
	})

	it("a probe that cannot be wired is not started and leaves no channel or branch (PROBE_NOT_WIRED)", async () => {
		const provider = new FakeChannelProvider()
		provider.results.push({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: "ENOENT",
		})
		manager.setChannelizer(provider)
		managerRegistry().register(
			"chan-probe",
			config => {
				const decoder = new ChannelProbe(config.id, iqDecoderCaps)
				decoders.set(config.id, decoder)
				return decoder
			},
			iqDecoderCaps,
		)
		await expect(
			manager.createEphemeralDecoder(
				{ ...probeConfig("scan-nw"), type: "chan-probe", useChannelizer: true },
				{ owner: "scanner", jobId: "j1" },
			),
		).rejects.toSatisfy(
			(err: unknown) =>
				err instanceof WaveKitError && err.code === "PROBE_NOT_WIRED",
		)
		const probe = decoders.get("scan-nw")!
		expect(provider.calls).toHaveLength(1)
		expect(probe.starts).toBe(0)
		expect(probe.input).toBeNull()
		expect(manager.getStatus("scan-nw")).toBeUndefined()
		expect(removed).toEqual(["scan-nw"])
		expect(sources.assignments.has("scan-nw")).toBe(false)
		expect(provider.streams.size).toBe(0)
		expect(provider.released).toEqual([])
		expect(fanout.getBranchIds()).toEqual([])
	})

	it("a removal while the probe is wired never starts it", async () => {
		const creating = manager.createEphemeralDecoder(probeConfig("scan-w"), {
			owner: "scanner",
			jobId: "j1",
			input: new PassThrough(),
		})
		await manager.removeEphemeralDecoder("scan-w")
		await expect(creating).rejects.toMatchObject({ code: "PROBE_REMOVED" })
		expect(decoders.get("scan-w")!.starts).toBe(0)
		expect(decoders.get("scan-w")!.input).toBeNull()
		expect(manager.getStatus("scan-w")).toBeUndefined()
		expect(removed).toEqual(["scan-w"])
	})

	it("a removal while the probe spawns stops it, attaches nothing and emits no status after removed", async () => {
		const events: string[] = []
		manager.on("decoder:status-changed", (id: string) =>
			events.push(`status:${id}`),
		)
		manager.on("decoder:removed", (id: string) => events.push(`removed:${id}`))
		const input = new PassThrough()
		input.write(Buffer.alloc(4096, 1)) // pre-roll
		const creating = manager.createEphemeralDecoder(
			{ ...probeConfig("scan-race"), type: "stdin-test" },
			{ owner: "scanner", jobId: "j1", input },
		)
		const outcome = creating.then(
			() => null,
			(err: unknown) => err,
		)
		const probe = decoders.get("scan-race") as StdinDecoder
		const gate = deferred()
		probe.startGate = gate
		await ticks() // wired; start() now waits on the gate (the spawn)
		expect(probe.starts).toBe(1)
		await manager.removeEphemeralDecoder("scan-race")
		gate.resolve()
		expect(await outcome).toMatchObject({ code: "PROBE_REMOVED" })
		await ticks()
		expect(probe.running).toBe(false)
		expect(probe.stops).toBe(2) // the removal's, then the one after the spawn
		expect(probe.input).toBeNull()
		expect(probe.trackedBytes).toBe(0)
		expect(manager.getStatus("scan-race")).toBeUndefined()
		expect(removed).toEqual(["scan-race"])
		expect(events.at(-1)).toBe("removed:scan-race")
		expect(sources.assignments.has("scan-race")).toBe(false)
	})

	it("is not suspended, resumed or restarted by caps changes", async () => {
		await manager.createEphemeralDecoder(probeConfig(), {
			owner: "scanner",
			jobId: "j1",
			input: new PassThrough(),
		})
		const probe = decoders.get("scan-j1-dmr-1")!
		sources.setRate("rtl", 20_000) // unusable for configured decoders
		await settle()
		sources.setCenter("rtl", 447_000_000)
		await settle()
		expect(probe.starts).toBe(1)
		expect(probe.stops).toBe(0)
		expect(manager.getStatus("scan-j1-dmr-1")?.suspended).toBe(false)
	})

	it("is never auto-restarted after it exits", async () => {
		await manager.createEphemeralDecoder(probeConfig(), {
			owner: "scanner",
			jobId: "j1",
			input: new PassThrough(),
		})
		const probe = decoders.get("scan-j1-dmr-1")!
		probe.crash()
		await vi.advanceTimersByTimeAsync(200)
		expect(restarting).toEqual([])
		expect(probe.starts).toBe(1)
		expect(probe.input).toBeNull()
		expect(manager.getStatus("scan-j1-dmr-1")).toMatchObject({
			health: "faulted",
			desiredRunning: false,
		})
		await manager.startAll() // the probe pool owns probes, not startAll
		expect(probe.starts).toBe(1)
		expect(manager.getStatus("scan-j1-dmr-1")?.desiredRunning).toBe(false)
	})

	it("removeEphemeralDecoder stops, detaches, releases the source and emits removed", async () => {
		await manager.createEphemeralDecoder(probeConfig(), {
			owner: "scanner",
			jobId: "j1",
			input: new PassThrough(),
		})
		const probe = decoders.get("scan-j1-dmr-1")!
		await manager.removeEphemeralDecoder("scan-j1-dmr-1")
		expect(probe.running).toBe(false)
		expect(probe.input).toBeNull()
		expect(manager.getStatus("scan-j1-dmr-1")).toBeUndefined()
		expect(sources.assignments.has("scan-j1-dmr-1")).toBe(false)
		expect(removed).toEqual(["scan-j1-dmr-1"])
		await manager.removeEphemeralDecoder("scan-j1-dmr-1") // unknown id: no-op
	})

	it("refuses to remove a configured decoder through the probe API", async () => {
		createConfigured()
		await expect(manager.removeEphemeralDecoder("dmr")).rejects.toMatchObject({
			code: "DECODER_NOT_EPHEMERAL",
		})
		expect(manager.getStatus("dmr")).toBeDefined()
	})
})

describe("source hold for a sweep (spec § 10.4)", () => {
	it("suspends running configured decoders by the time holdSource resolves and resumes them when releaseSource resolves", async () => {
		const decoder = createConfigured()
		await manager.startDecoder("dmr")
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		expect(manager.isSourceHeld("rtl")).toBe(true)
		expect(decoder.running).toBe(false)
		expect(manager.getStatus("dmr")).toMatchObject({
			suspended: true,
			suspension: { reasonCode: "tuner-scanning" },
			desiredRunning: true,
		})
		await manager.releaseSource("rtl", "j1")
		expect(manager.isSourceHeld("rtl")).toBe(false)
		expect(decoder.starts).toBe(2)
		expect(manager.getStatus("dmr")?.suspended).toBe(false)
	})

	it("stays suspended while the scanner hops every 100 ms, which keeps re-arming the caps debounce", async () => {
		const decoder = createConfigured()
		await manager.startDecoder("dmr")
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		for (let hop = 0; hop < 20; hop++) {
			sources.setCenter("rtl", 412_000_000 + hop * 1_600_000)
			await vi.advanceTimersByTimeAsync(100)
			expect(decoder.running).toBe(false)
			expect(manager.getStatus("dmr")?.suspension?.reasonCode).toBe(
				"tuner-scanning",
			)
		}
		expect(decoder.starts).toBe(1)
		expect(decoder.stops).toBe(1)
		await manager.releaseSource("rtl", "j1")
		expect(decoder.starts).toBe(2)
		await settle() // the debounced hop evaluation finds nothing left to do
		expect(decoder.starts).toBe(2)
		expect(decoder.stops).toBe(1)
	})

	it("releasing one holder keeps another holder's hold", async () => {
		const decoder = createConfigured()
		await manager.startDecoder("dmr")
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		await manager.holdSource("rtl", "tuner-scanning", "j2")
		await manager.releaseSource("rtl", "j1")
		expect(manager.isSourceHeld("rtl")).toBe(true)
		await settle()
		expect(decoder.running).toBe(false)
		expect(manager.getStatus("dmr")?.suspension?.reasonCode).toBe(
			"tuner-scanning",
		)
		await manager.releaseSource("rtl", "j1") // already released: no-op
		expect(manager.isSourceHeld("rtl")).toBe(true)
		await manager.releaseSource("rtl", "j2")
		expect(manager.isSourceHeld("rtl")).toBe(false)
		expect(decoder.running).toBe(true)
		expect(decoder.starts).toBe(2)
	})

	it("outranks an unusable rate as the reported reason, which returns after release", async () => {
		createConfigured()
		await manager.startDecoder("dmr")
		sources.setRate("rtl", 20_000)
		await settle()
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		expect(manager.getStatus("dmr")?.suspension?.reasonCode).toBe(
			"tuner-scanning",
		)
		await manager.releaseSource("rtl", "j1")
		expect(manager.getStatus("dmr")?.suspension?.reasonCode).toBe(
			"insufficient-sample-rate",
		)
	})

	it("holds pinned (operator) decoders too", async () => {
		const decoder = createConfigured()
		await manager.startDecoder("dmr", { startMode: "operator" })
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		expect(decoder.running).toBe(false)
		expect(manager.getStatus("dmr")).toMatchObject({
			startMode: "operator",
			suspended: true,
		})
	})

	it("refuses refuseIfHeld starts and restarts on a held source, leaving the intent untouched", async () => {
		const decoder = createConfigured()
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		await expect(
			manager.startDecoder("dmr", {
				startMode: "operator",
				refuseIfHeld: true,
			}),
		).rejects.toSatisfy(
			(err: unknown) =>
				err instanceof WaveKitError && err.code === "SOURCE_HELD_BY_SCANNER",
		)
		expect(decoder.starts).toBe(0)
		expect(manager.getStatus("dmr")?.desiredRunning).toBe(false)
		await manager.releaseSource("rtl", "j1")
		await manager.startDecoder("dmr")
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		await expect(
			manager.restartDecoder("dmr", { refuseIfHeld: true }),
		).rejects.toMatchObject({
			code: "SOURCE_HELD_BY_SCANNER",
		})
		expect(decoder.stops).toBe(1) // the hold's suspension only; the refused restart stopped nothing
		expect(manager.getStatus("dmr")).toMatchObject({
			desiredRunning: true,
			suspended: true,
		})
	})

	it("startAll during a hold records the decoders as wanted and suspended; they start on release", async () => {
		const decoder = createConfigured()
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		await manager.startAll()
		expect(decoder.starts).toBe(0)
		expect(manager.getStatus("dmr")).toMatchObject({
			desiredRunning: true,
			suspended: true,
			suspension: { reasonCode: "tuner-scanning" },
		})
		await manager.releaseSource("rtl", "j1")
		expect(decoder.running).toBe(true)
		expect(manager.getStatus("dmr")?.suspended).toBe(false)
	})

	it("does not affect probes or decoders on other sources", async () => {
		sources.caps.set("spare", { ...iqCaps(2_400_000), centerFreq: 144_800_000 })
		manager.createDecoder({
			id: "aprs",
			type: "rate-test",
			enabled: true,
			sourceId: "spare",
			options: { input: "iq" },
		})
		await manager.startDecoder("aprs")
		await manager.holdSource("rtl", "tuner-scanning", "j1")
		await manager.createEphemeralDecoder(probeConfig(), {
			owner: "scanner",
			jobId: "j1",
			input: new PassThrough(),
		})
		expect(decoders.get("aprs")!.running).toBe(true)
		expect(decoders.get("scan-j1-dmr-1")!.running).toBe(true)
	})
})

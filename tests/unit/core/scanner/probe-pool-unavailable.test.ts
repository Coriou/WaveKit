import { verifiedLinkLine } from "./verified-link-fake.js"
/**
 * WG12 R 4.5: a probe whose decoder program cannot run ends `unsupported` /
 * `decoder-unavailable` with no `undecodedReason`, and the type is memoised.
 * Any other exit keeps today's path.
 */
import { describe, expect, it, vi } from "vitest"
import { DecoderSpawnError } from "../../../../src/utils/errors.js"
import {
	isDecoderUnavailableExit,
	type ProbeUnavailableStop,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import type { ProbeRequest } from "../../../../src/core/scanner/probes/probe-pool.js"
import {
	flushAsync,
	poolHarness,
	probeRequest,
} from "../../../mocks/scanner/probe-fakes.js"

function spawnError(errno: string): DecoderSpawnError {
	const cause = new Error("spawn failed") as NodeJS.ErrnoException
	cause.code = errno
	return new DecoderSpawnError("probe", "/bin/sh", cause)
}

type Harness = ReturnType<typeof poolHarness>

interface StoppedProbe {
	probeId: string
	terminal: unknown
}

function watch(h: Harness): {
	order: string[]
	stopped: StoppedProbe[]
} {
	const order: string[] = []
	const stopped: StoppedProbe[] = []
	h.pool.on("decoder-unavailable", (probeId: string) => {
		order.push(`unavailable:${probeId}`)
	})
	h.pool.on(
		"probe-state",
		(
			probeId: string,
			state: string,
			_req: ProbeRequest,
			terminal?: unknown,
		) => {
			if (state !== "stopped") return
			order.push(`stopped:${probeId}`)
			stopped.push({ probeId, terminal })
		},
	)
	return { order, stopped }
}

async function started(h: Harness): Promise<string> {
	const res = h.pool.request(probeRequest())
	expect(res).toHaveProperty("started")
	if (!("started" in res)) throw new Error("not started")
	await flushAsync()
	await flushAsync()
	return res.started
}

const TERMINAL: ProbeUnavailableStop = {
	outcome: "unsupported",
	reason: "decoder-unavailable",
}

async function expectUnavailable(
	h: Harness,
	seen: ReturnType<typeof watch>,
	probeId: string,
): Promise<void> {
	await vi.waitFor(() => {
		expect(seen.stopped.map(s => s.probeId)).toContain(probeId)
	})
	const stop = seen.stopped.find(s => s.probeId === probeId)
	expect(stop?.terminal).toEqual(TERMINAL)
	expect(stop?.terminal).not.toHaveProperty("undecodedReason")
	expect(seen.order).toEqual([`unavailable:${probeId}`, `stopped:${probeId}`])
	expect([...h.pool.unavailableTypes(h.clock.now)]).toEqual(["dsd-fme"])
}

describe("probe pool unavailable exit", () => {
	it("spawn ENOENT ends unsupported, decoder-unavailable, memo set", async () => {
		const h = poolHarness()
		const seen = watch(h)
		h.decoders.failNext = spawnError("ENOENT")
		const id = await started(h)
		await expectUnavailable(h, seen, id)
	})

	it("exit 127 before output ends unsupported, decoder-unavailable, memo set", async () => {
		const h = poolHarness()
		const seen = watch(h)
		const id = await started(h)
		h.decoders.created.get(id)?.emit("exit", 127, null)
		await expectUnavailable(h, seen, id)
	})

	it("exit 126 before output is unavailable", async () => {
		const h = poolHarness()
		const seen = watch(h)
		const id = await started(h)
		h.decoders.created.get(id)?.emit("exit", 126, null)
		await expectUnavailable(h, seen, id)
	})

	it("exit 127 after output keeps today's path", async () => {
		const h = poolHarness()
		const seen = watch(h)
		const id = await started(h)
		h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
		h.decoders.created.get(id)?.emit("exit", 127, null)
		await flushAsync()
		await flushAsync()
		expect(seen.order).toEqual([])
		expect(seen.stopped).toEqual([])
		expect(h.pool.unavailableTypes(h.clock.now).size).toBe(0)
		expect(h.decoders.created.has(id)).toBe(true)
		expect(h.states.some(s => s.state === "stopped")).toBe(false)
	})

	it("an unavailable probe never yields undecodedReason no-sync", async () => {
		const h = poolHarness()
		const seen = watch(h)
		h.decoders.failNext = spawnError("ENOENT")
		const id = await started(h)
		await expectUnavailable(h, seen, id)
		expect(JSON.stringify(seen.stopped)).not.toContain("no-sync")
		expect(JSON.stringify(seen.stopped)).not.toContain("undecodedReason")
	})

	it("the memo clears after a successful spawn", async () => {
		const h = poolHarness()
		h.decoders.failNext = spawnError("ENOENT")
		await started(h)
		await vi.waitFor(() => {
			expect(h.states.some(s => s.state === "stopped")).toBe(true)
		})
		expect([...h.pool.unavailableTypes(h.clock.now)]).toEqual(["dsd-fme"])
		h.clock.now += 1000
		const again = h.pool.request(probeRequest())
		expect(again).toHaveProperty("started")
		await flushAsync()
		await flushAsync()
		expect(h.decoders.created.size).toBe(1)
		expect(h.pool.unavailableTypes(h.clock.now).size).toBe(0)
	})

	it.each([
		{
			label: "spawn ENOENT",
			exit: {
				code: null,
				signal: null,
				outputSeen: false,
				spawnError: spawnError("ENOENT"),
			},
			want: true,
		},
		{
			label: "spawn EACCES",
			exit: {
				code: null,
				signal: null,
				outputSeen: false,
				spawnError: spawnError("EACCES"),
			},
			want: true,
		},
		{
			label: "spawn EPERM",
			exit: {
				code: null,
				signal: null,
				outputSeen: false,
				spawnError: spawnError("EPERM"),
			},
			want: false,
		},
		{
			label: "exit 127, no signal, no output",
			exit: { code: 127, signal: null, outputSeen: false },
			want: true,
		},
		{
			label: "exit 126, no signal, no output",
			exit: { code: 126, signal: null, outputSeen: false },
			want: true,
		},
		{
			label: "exit 127 after output",
			exit: { code: 127, signal: null, outputSeen: true },
			want: false,
		},
		{
			label: "exit 127 with SIGKILL",
			exit: {
				code: 127,
				signal: "SIGKILL" as NodeJS.Signals,
				outputSeen: false,
			},
			want: false,
		},
		{
			label: "exit 1, no signal, no output",
			exit: { code: 1, signal: null, outputSeen: false },
			want: false,
		},
	])("isDecoderUnavailableExit: $label → $want", ({ exit, want }) => {
		expect(isDecoderUnavailableExit(exit)).toBe(want)
	})
})

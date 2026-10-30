/**
 * WG10 req 2.6 goldens, recorded from the frozen code (1e5b4c1f): floor,
 * threshold and gate traces for a fixed synthetic block sequence in the
 * modes the carrier observer must not touch (manual, noise, auto on am and
 * usb), including a near-full-scale overload in manual mode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { MockInstance } from "vitest"
import type { ChildProcess } from "node:child_process"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import type { LiveDemodulator as LiveDemodulatorType } from "../../../src/core/live-demodulator.js"
import {
	FakeProcess,
	createFakeFanout,
	createFakeSourceManager,
	findFreePort,
} from "./live-demodulator-continuity-fakes.js"
import { createLogger } from "../../../src/utils/logger.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

import { spawn } from "node:child_process"

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>
const BLOCK = 250 // complex samples per 10 ms block at 25 kHz

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

type Segment = { kind: "noise" | "carrier"; dbfs: number; blocks: number }

/** Noise (random phase and amplitude) or a steady carrier (quieted). */
function blocks(segments: Segment[], seed: number): Buffer[] {
	const random = prng(seed)
	const out: Buffer[] = []
	let phase = 0
	for (const segment of segments) {
		const amplitude = 10 ** (segment.dbfs / 20)
		for (let b = 0; b < segment.blocks; b++) {
			const block = Buffer.alloc(BLOCK * 8)
			for (let i = 0; i < BLOCK; i++) {
				let iv: number
				let qv: number
				if (segment.kind === "carrier") {
					phase += (2 * Math.PI * 1000) / 25_000
					iv = amplitude * Math.cos(phase)
					qv = amplitude * Math.sin(phase)
				} else {
					const angle = random() * 2 * Math.PI
					const r = amplitude * Math.sqrt(-Math.log(1 - random() * 0.999))
					iv = r * Math.cos(angle)
					qv = r * Math.sin(angle)
				}
				block.writeFloatLE(iv, i * 8)
				block.writeFloatLE(qv, i * 8 + 4)
			}
			out.push(block)
		}
	}
	return out
}

const SEQUENCE: Segment[] = [
	{ kind: "noise", dbfs: -70, blocks: 40 },
	{ kind: "carrier", dbfs: -20, blocks: 60 },
	{ kind: "noise", dbfs: -70, blocks: 40 },
	{ kind: "noise", dbfs: -55, blocks: 40 },
	{ kind: "carrier", dbfs: -1, blocks: 40 },
	{ kind: "noise", dbfs: -2, blocks: 20 },
	{ kind: "noise", dbfs: -75, blocks: 40 },
]

describe("LiveDemodulator squelch traces (frozen behaviour, WG10 req 2.6)", () => {
	let processes: FakeProcess[]
	let killSpy: MockInstance<(pid: number, signal?: string | number) => true>
	let liveDemod: LiveDemodulatorType | null = null

	beforeEach(() => {
		processes = []
		spawnMock.mockImplementation((_cmd: string, args: string[]) => {
			const proc = new FakeProcess(args[1] ?? "")
			processes.push(proc)
			return proc as unknown as ChildProcess
		})
		killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((pid: number, signal?: string | number) => {
				const proc = processes.find(p => p.pid === Math.abs(pid))
				if (!proc) {
					const err = new Error("ESRCH") as NodeJS.ErrnoException
					err.code = "ESRCH"
					throw err
				}
				proc.receive((signal ?? "SIGTERM") as NodeJS.Signals)
				return true
			})
	})

	afterEach(async () => {
		try {
			await liveDemod?.stop()
		} catch {
			// cleanup only
		}
		liveDemod = null
		killSpy.mockRestore()
		spawnMock.mockReset()
	})

	async function trace(config: Record<string, unknown>): Promise<string[]> {
		const module = await import("../../../src/core/live-demodulator.js")
		const LiveDemodulator = module.LiveDemodulator as unknown as new (
			...args: unknown[]
		) => LiveDemodulatorType
		const sourceManager = createFakeSourceManager()
		liveDemod = new LiveDemodulator(
			createLogger({ level: "fatal" }),
			sourceManager,
			createFakeFanout(),
			LiveDemodConfigSchema.parse({
				engine: "csdr",
				enabled: true,
				sourceId: "rtl-pi",
				httpPort: await findFreePort(),
				squelchMode: "manual",
				...config,
			}),
			{ httpHost: "127.0.0.1" },
		)
		await liveDemod.start()
		const demod = liveDemod
		const front = processes[0]!
		processes[1]!.stdout.resume()
		const rows: string[] = []
		const all = blocks(SEQUENCE, 7)
		for (let i = 0; i < all.length; i++) {
			// A retune halfway (the WG9 5.6 floor handling).
			if (i === 150) sourceManager.emitCaps({ centerFreq: 446_100_000 })
			await new Promise<void>(resolve =>
				front.stdout.write(all[i]!, () => resolve()),
			)
			await new Promise<void>(resolve => setImmediate(resolve))
			const status = demod.getStatus()
			rows.push(
				[
					i,
					status.channelPowerDbfs ?? "-",
					status.noiseFloorDbfs?.toFixed(4) ?? "-",
					status.thresholdDbfs?.toFixed(4) ?? "-",
					status.squelchOpen ? "open" : "closed",
				].join(" "),
			)
		}
		return rows
	}

	const modes: Array<[string, Record<string, unknown>]> = [
		["manual nfm (overload segment included)", { squelch: -40 }],
		["noise nfm", { squelchMode: "noise", modulation: "nfm" }],
		["auto am", { squelchMode: "auto", modulation: "am" }],
		["auto usb", { squelchMode: "auto", modulation: "usb" }],
		["manual wfm", { squelch: -30, modulation: "wfm" }],
	]
	for (const [name, config] of modes) {
		it(`trace: ${name}`, async () => {
			expect(await trace(config)).toMatchSnapshot()
		}, 30_000)
	}
})

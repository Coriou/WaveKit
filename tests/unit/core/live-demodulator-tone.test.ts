/**
 * WG12 req 6.4: LiveDemodulator.getStatus().tone is the current or last closed
 * transmission's tone while running, and is absent until one is reported.
 */
import { EventEmitter } from "node:events"
import { createServer } from "node:net"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChildProcess } from "node:child_process"
import type { MockInstance } from "vitest"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import { LiveDemodulator } from "../../../src/core/live-demodulator.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { FanoutManager } from "../../../src/core/fanout-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })

class Stage extends EventEmitter {
	stdin = new PassThrough()
	stdout = new PassThrough()
	stderr = new PassThrough()
	pid: number
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null

	constructor(pid: number) {
		super()
		this.pid = pid
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.finish(signal)
		return true
	}

	finish(signal: NodeJS.Signals): void {
		if (this.exitCode !== null || this.signalCode !== null) return
		this.signalCode = signal
		this.emit("exit", null, signal)
	}
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer()
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			if (address === null || typeof address === "string") {
				server.close()
				reject(new Error("no port"))
				return
			}
			const port = address.port
			server.close(err => (err ? reject(err) : resolve(port)))
		})
	})
}

describe("live demodulator tone", () => {
	const stages: Stage[] = []
	let nextPid = 7_000_000
	let killSpy: MockInstance<(pid: number, signal?: string | number) => true>
	let demod: LiveDemodulator

	beforeEach(async () => {
		stages.length = 0
		killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((pid: number, signal?: string | number) => {
				const stage = stages.find(s => s.pid === Math.abs(pid))
				if (!stage) {
					const err = new Error("ESRCH") as NodeJS.ErrnoException
					err.code = "ESRCH"
					throw err
				}
				stage.finish((signal ?? "SIGTERM") as NodeJS.Signals)
				return true
			})
		const port = await freePort()
		const caps = {
			kind: "iq" as const,
			sampleRate: 2_400_000,
			format: "U8_IQ" as const,
			centerFreq: 446_000_000,
		}
		const capsEmitter = new EventEmitter()
		const sourceManager = {
			getAllStatus: () => [{ id: "rtl-pi", connected: true }],
			getStatus: () => ({ id: "rtl-pi", connected: true }),
			getCaps: () => ({ ...caps }),
			on: (event: string, listener: (...args: unknown[]) => void) => {
				capsEmitter.on(event, listener)
				return sourceManager
			},
			off: (event: string, listener: (...args: unknown[]) => void) => {
				capsEmitter.off(event, listener)
				return sourceManager
			},
			emitCaps(update: { centerFreq?: number }) {
				Object.assign(caps, update)
				capsEmitter.emit("caps-changed", "rtl-pi", { ...caps })
			},
		}
		const branch = new PassThrough()
		const fanout = {
			addBranch: () => branch,
			removeBranch: () => undefined,
		}
		demod = new LiveDemodulator(
			logger,
			sourceManager as unknown as SourceManager,
			fanout as unknown as FanoutManager,
			LiveDemodConfigSchema.parse({
				enabled: true,
				sourceId: "rtl-pi",
				httpPort: port,
			}),
			{
				httpHost: "127.0.0.1",
				stopTimeoutMs: 200,
				spawnStage: () => {
					const stage = new Stage(++nextPid)
					stages.push(stage)
					return stage as unknown as ChildProcess
				},
			},
		)
		Object.assign(demod, { capsSource: sourceManager })
	})

	afterEach(async () => {
		await demod.stop()
		killSpy.mockRestore()
	})

	function retuneCentre(): void {
		const source = (
			demod as unknown as {
				capsSource: { emitCaps(update: { centerFreq?: number }): void }
			}
		).capsSource
		source.emitCaps({ centerFreq: 446_093_750 })
	}

	it("omits tone when none has been reported", async () => {
		const stopped = demod.getStatus()
		expect(stopped.running).toBe(false)
		expect("tone" in stopped).toBe(false)
		expect(stopped.tone).toBeUndefined()
		await demod.start()
		const running = demod.getStatus()
		expect(running.running).toBe(true)
		expect("tone" in running).toBe(false)
		expect(running.tone).toBeUndefined()
	})

	it("reports the current tone while running and keeps the last one", async () => {
		await demod.start()
		demod.noteTransmissionTone({
			ctcssHz: 88.5,
			dcs: null,
			at: "2026-10-17T10:00:02.000Z",
		})
		expect(demod.getStatus().tone).toEqual({
			ctcssHz: 88.5,
			dcs: null,
			at: "2026-10-17T10:00:02.000Z",
		})
		demod.noteTransmissionTone({
			ctcssHz: null,
			dcs: { code: "023", polarity: "normal" },
			at: "2026-10-17T10:00:08.000Z",
		})
		expect(demod.getStatus().tone).toEqual({
			ctcssHz: null,
			dcs: { code: "023", polarity: "normal" },
			at: "2026-10-17T10:00:08.000Z",
		})
	})

	it("hides a reported tone until running, then shows it", async () => {
		demod.noteTransmissionTone({
			ctcssHz: 88.5,
			dcs: null,
			at: "2026-10-17T10:00:02.000Z",
		})
		expect("tone" in demod.getStatus()).toBe(false)
		await demod.start()
		expect(demod.getStatus().tone?.ctcssHz).toBe(88.5)
	})

	it("treats an off-table tone as no tone and still reports the transmission", async () => {
		await demod.start()
		demod.noteTransmissionTone({
			ctcssHz: 12,
			dcs: { code: "999", polarity: "normal" },
			at: "2026-10-17T10:00:02.000Z",
		})
		expect(demod.getStatus().tone).toEqual({
			ctcssHz: null,
			dcs: null,
			at: "2026-10-17T10:00:02.000Z",
		})
	})

	it("clears the tone on a centre-frequency retune, an offset change, and stop", async () => {
		await demod.start()
		const tone = {
			ctcssHz: 88.5,
			dcs: null,
			at: "2026-10-17T10:00:02.000Z",
		}
		demod.noteTransmissionTone(tone)
		retuneCentre()
		expect("tone" in demod.getStatus()).toBe(false)

		demod.noteTransmissionTone(tone)
		await demod.reconfigure({ offsetHz: 6_000 })
		expect("tone" in demod.getStatus()).toBe(false)

		demod.noteTransmissionTone(tone)
		await demod.reconfigure({ squelch: -50 })
		expect(demod.getStatus().tone).toEqual(tone)

		await demod.stop()
		expect(demod.getStatus().running).toBe(false)
		expect("tone" in demod.getStatus()).toBe(false)
		await demod.start()
		expect("tone" in demod.getStatus()).toBe(false)
	})

	it("does not repopulate the tone from a transmission that started before the clear", async () => {
		await demod.start()
		const startedAt = new Date(Date.now() - 60_000).toISOString()
		const stale = {
			ctcssHz: 88.5,
			dcs: null,
			at: "2026-10-17T10:00:02.000Z",
			startedAt,
		}
		// Generation 0 is the channel before any clear.
		demod.noteTransmissionTone({ ...stale, generation: 0 })
		expect(demod.getStatus().tone?.ctcssHz).toBe(88.5)

		retuneCentre()
		expect("tone" in demod.getStatus()).toBe(false)
		demod.noteTransmissionTone(stale)
		demod.noteTransmissionTone({ ...stale, generation: 0 })
		expect("tone" in demod.getStatus()).toBe(false)

		const afterRetune = new Date(Date.now() + 1_000).toISOString()
		demod.noteTransmissionTone({
			ctcssHz: 88.5,
			dcs: null,
			at: afterRetune,
			startedAt: afterRetune,
			generation: 1,
		})
		expect(demod.getStatus().tone).toEqual({
			ctcssHz: 88.5,
			dcs: null,
			at: afterRetune,
		})

		await demod.reconfigure({ offsetHz: 6_000 })
		demod.noteTransmissionTone({
			ctcssHz: 103.5,
			dcs: null,
			at: afterRetune,
			generation: 1,
		})
		demod.noteTransmissionTone(stale)
		expect("tone" in demod.getStatus()).toBe(false)

		await demod.stop()
		demod.noteTransmissionTone({ ...stale, generation: 2 })
		await demod.start()
		expect("tone" in demod.getStatus()).toBe(false)
	})
})

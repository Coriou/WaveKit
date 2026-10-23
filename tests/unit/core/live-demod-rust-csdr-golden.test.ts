/**
 * Csdr-path goldens recorded from the live demodulator before the Rust engine
 * seam. Parsed config omits `engine`; the runtime default is csdr, so these
 * argv and HTTP headers must keep matching. Status still reports `engine`
 * (requirement 1.5); argv and headers did not change.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { MockInstance } from "vitest"
import * as http from "node:http"
import type { ChildProcess } from "node:child_process"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import type { LiveDemodulator as LiveDemodulatorType } from "../../../src/core/live-demodulator.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	FakeProcess,
	createFakeFanout,
	createFakeSourceManager,
} from "./live-demodulator-continuity-fakes.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

import { spawn } from "node:child_process"

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = http.createServer()
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

describe("csdr live demod goldens", () => {
	let processes: FakeProcess[]
	let killSpy: MockInstance<(pid: number, signal?: string | number) => true>
	let liveDemod: LiveDemodulatorType | undefined
	let LiveDemodulatorClass: new (...args: unknown[]) => LiveDemodulatorType

	beforeEach(async () => {
		const module = await import("../../../src/core/live-demodulator.js")
		LiveDemodulatorClass = module.LiveDemodulator as unknown as new (
			...args: unknown[]
		) => LiveDemodulatorType
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
		liveDemod = undefined
		killSpy.mockRestore()
		spawnMock.mockReset()
	})

	async function capture(overrides: Record<string, unknown>): Promise<{
		commands: string[]
		keys: string[]
		headers: unknown
	}> {
		const port = await freePort()
		const config = LiveDemodConfigSchema.parse({
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: port,
			...overrides,
		})
		const demod = new LiveDemodulatorClass(
			createLogger({ level: "fatal" }),
			createFakeSourceManager(),
			createFakeFanout(),
			config,
			{ httpHost: "127.0.0.1" },
		)
		liveDemod = demod
		await demod.start()
		const commands = spawnMock.mock.calls.map(call => {
			const argv = call[1] as string[]
			return argv[1] ?? ""
		})
		const keys = Object.keys(demod.getStatus()).sort()
		const headers = await new Promise<unknown>((resolve, reject) => {
			const req = http.get(
				{ host: "127.0.0.1", port, path: "/stream" },
				res => {
					const copy = { ...res.headers }
					delete copy["date"]
					resolve({ status: res.statusCode, headers: copy })
					res.destroy()
				},
			)
			req.on("error", reject)
		})
		await demod.stop()
		liveDemod = undefined
		spawnMock.mockClear()
		return { commands, keys, headers }
	}

	it("argv, status keys and HTTP headers for default, nfm and am", async () => {
		expect({
			default: await capture({}),
			nfm: await capture({ modulation: "nfm" }),
			am: await capture({ modulation: "am", bandwidth: 10000 }),
		}).toMatchInlineSnapshot(`
			{
			  "am": {
			    "commands": [
			      "csdr convert -i char -o float | csdr firdecimate 120 0.002083 --cutoff 0.3750",
			      "csdr amdemod | csdr agc -f float -p fast -r 0.4 | csdr dcblock | csdr gain 2 | csdr limit | csdr convert -i float -o s16",
			    ],
			    "headers": {
			      "headers": {
			        "access-control-allow-origin": "*",
			        "access-control-expose-headers": "X-Audio-Format, X-Sample-Rate, X-Channels, Retry-After",
			        "cache-control": "no-cache, no-store",
			        "connection": "keep-alive",
			        "content-type": "application/octet-stream",
			        "transfer-encoding": "chunked",
			        "x-audio-format": "s16le",
			        "x-channels": "1",
			        "x-sample-rate": "20000",
			      },
			      "status": 200,
			    },
			    "keys": [
			      "agc",
			      "autoSquelch",
			      "bytesStreamed",
			      "clientCount",
			      "config",
			      "decimationFactor",
			      "effectiveSampleRate",
			      "enabled",
			      "engine",
			      "httpUrl",
			      "pipelineHealth",
			      "pipelineRestarts",
			      "running",
			      "sourceConnected",
			      "sourceId",
			      "sourceIqSampleRate",
			      "squelchOpen",
			      "thresholdDbfs",
			      "toneSquelch",
			      "wavUrl",
			    ],
			  },
			  "default": {
			    "commands": [
			      "csdr convert -i char -o float | csdr firdecimate 96 0.002604 --cutoff 0.3750",
			      "csdr fmdemod | csdr dcblock | csdr gain 2 | csdr limit | csdr convert -i float -o s16",
			    ],
			    "headers": {
			      "headers": {
			        "access-control-allow-origin": "*",
			        "access-control-expose-headers": "X-Audio-Format, X-Sample-Rate, X-Channels, Retry-After",
			        "cache-control": "no-cache, no-store",
			        "connection": "keep-alive",
			        "content-type": "application/octet-stream",
			        "transfer-encoding": "chunked",
			        "x-audio-format": "s16le",
			        "x-channels": "1",
			        "x-sample-rate": "25000",
			      },
			      "status": 200,
			    },
			    "keys": [
			      "agc",
			      "autoSquelch",
			      "bytesStreamed",
			      "clientCount",
			      "config",
			      "decimationFactor",
			      "effectiveSampleRate",
			      "enabled",
			      "engine",
			      "httpUrl",
			      "pipelineHealth",
			      "pipelineRestarts",
			      "running",
			      "sourceConnected",
			      "sourceId",
			      "sourceIqSampleRate",
			      "squelchOpen",
			      "thresholdDbfs",
			      "toneSquelch",
			      "wavUrl",
			    ],
			  },
			  "nfm": {
			    "commands": [
			      "csdr convert -i char -o float | csdr firdecimate 96 0.002604 --cutoff 0.3750",
			      "csdr fmdemod | csdr dcblock | csdr gain 2 | csdr limit | csdr convert -i float -o s16",
			    ],
			    "headers": {
			      "headers": {
			        "access-control-allow-origin": "*",
			        "access-control-expose-headers": "X-Audio-Format, X-Sample-Rate, X-Channels, Retry-After",
			        "cache-control": "no-cache, no-store",
			        "connection": "keep-alive",
			        "content-type": "application/octet-stream",
			        "transfer-encoding": "chunked",
			        "x-audio-format": "s16le",
			        "x-channels": "1",
			        "x-sample-rate": "25000",
			      },
			      "status": 200,
			    },
			    "keys": [
			      "agc",
			      "autoSquelch",
			      "bytesStreamed",
			      "clientCount",
			      "config",
			      "decimationFactor",
			      "effectiveSampleRate",
			      "enabled",
			      "engine",
			      "httpUrl",
			      "pipelineHealth",
			      "pipelineRestarts",
			      "running",
			      "sourceConnected",
			      "sourceId",
			      "sourceIqSampleRate",
			      "squelchOpen",
			      "thresholdDbfs",
			      "toneSquelch",
			      "wavUrl",
			    ],
			  },
			}
		`)
	})
})

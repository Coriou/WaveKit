import * as net from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AudioOutput } from "../../../src/core/audio-output.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "error" })
const holders: net.Server[] = []

async function hold(): Promise<number> {
	const server = net.createServer()
	holders.push(server)
	// AudioOutput binds the wildcard address; macOS lets it share a port with a
	// loopback-only listener, so the held port must be wildcard too.
	await new Promise<void>(resolve => server.listen(0, resolve))
	return (server.address() as net.AddressInfo).port
}

afterEach(async () => {
	for (const server of holders.splice(0))
		await new Promise<void>(resolve => server.close(() => resolve()))
})

function make(port: number) {
	const output = new AudioOutput(logger, {
		port,
		format: "S16LE",
		sampleRate: 48000,
	})
	const log = (
		output as unknown as { log: { error: (...a: unknown[]) => void } }
	).log
	const error = vi.spyOn(log, "error")
	return { output, error }
}

describe("AudioOutput start failure (WG9 5.1)", () => {
	it("rejects EADDRINUSE with a fixed log and no unhandled error event", async () => {
		const port = await hold()
		const { output, error } = make(port)
		await expect(output.start()).rejects.toMatchObject({ code: "EADDRINUSE" })
		expect(error).toHaveBeenCalledTimes(1)
		const [fields, text] = error.mock.calls[0] as [unknown, string]
		expect(text).toBe("Failed to start audio output server")
		expect(JSON.stringify(fields)).not.toContain(String(port))
		expect(JSON.stringify(fields)).not.toContain("127.0.0.1")
	})

	it("emits a post-listen error only with a listener, else logs", async () => {
		const { output, error } = make(0)
		await output.start()
		try {
			const server = (output as unknown as { server: net.Server }).server
			expect(() => server.emit("error", new Error("boom"))).not.toThrow()
			expect(error).toHaveBeenCalledTimes(1)
			const listener = vi.fn()
			output.on("error", listener)
			server.emit("error", new Error("boom2"))
			expect(listener).toHaveBeenCalledTimes(1)
			expect(error).toHaveBeenCalledTimes(1)
		} finally {
			await output.stop()
		}
	})
})

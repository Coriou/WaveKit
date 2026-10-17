import * as net from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "error" })
const holders: net.Server[] = []

async function hold(): Promise<number> {
	const server = net.createServer()
	holders.push(server)
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	return (server.address() as net.AddressInfo).port
}

afterEach(async () => {
	for (const server of holders.splice(0))
		await new Promise<void>(resolve => server.close(() => resolve()))
})

function make(port: number) {
	const relay = new TunerRelay(
		logger,
		new SourceManager(logger),
		new FanoutManager(logger),
		{ enabled: true, host: "127.0.0.1", port, controlPolicy: "exclusive" },
	)
	const log = (
		relay as unknown as { log: { error: (...a: unknown[]) => void } }
	).log
	return { relay, error: vi.spyOn(log, "error") }
}

describe("TunerRelay start failure (WG9 5.1)", () => {
	it("rejects EADDRINUSE with a fixed log and no unhandled error event", async () => {
		const port = await hold()
		const { relay, error } = make(port)
		await expect(relay.start()).rejects.toMatchObject({ code: "EADDRINUSE" })
		expect(error).toHaveBeenCalledTimes(1)
		const [fields, text] = error.mock.calls[0] as [unknown, string]
		expect(text).toBe("Failed to start tuner relay server")
		expect(JSON.stringify(fields)).not.toContain(String(port))
		expect(JSON.stringify(fields)).not.toContain("127.0.0.1")
		const state = relay as unknown as {
			branchId: unknown
			dataHandler: unknown
			branchStream: unknown
		}
		expect(state.branchId).toBeNull()
		expect(state.dataHandler).toBeNull()
		expect(state.branchStream).toBeNull()
	})

	it("emits a post-listen error only with a listener, else logs", async () => {
		const { relay, error } = make(0)
		await relay.start()
		try {
			const server = (relay as unknown as { server: net.Server }).server
			expect(() => server.emit("error", new Error("boom"))).not.toThrow()
			expect(error).toHaveBeenCalledTimes(1)
			const listener = vi.fn()
			relay.on("error", listener)
			server.emit("error", new Error("boom2"))
			expect(listener).toHaveBeenCalledTimes(1)
			expect(error).toHaveBeenCalledTimes(1)
		} finally {
			await relay.stop()
		}
	})
})

/**
 * The golden collector (tests/integration/fixtures/collect-outputs.mjs) against a stand-in app: an early WebSocket
 * close must fail the run instead of exiting 0 with a truncated output set (final review infra M2).
 */
import { afterEach, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { resolve } from "node:path"
import { WebSocketServer } from "ws"

const COLLECTOR = resolve("tests/integration/fixtures/collect-outputs.mjs")
let server: Server | null = null
let wss: WebSocketServer | null = null

afterEach(async () => {
	wss?.close()
	await new Promise(r => (server ? server.close(r) : r(undefined)))
	server = null
	wss = null
})

/** /health/live, /api/decoders/:id and /ws; `onSubscribe` decides what the socket does next. */
async function app(
	onSubscribe: (send: (m: unknown) => void, close: () => void) => void,
) {
	server = createServer((req, res) => {
		res.setHeader("content-type", "application/json")
		res.end(
			JSON.stringify(req.url === "/health/live" ? { ok: true } : { id: "dec" }),
		)
	})
	wss = new WebSocketServer({ server, path: "/ws" })
	wss.on("connection", socket =>
		socket.once("message", () =>
			onSubscribe(
				m => socket.send(JSON.stringify(m)),
				() => socket.close(1008, "slow client"),
			),
		),
	)
	await new Promise<void>(r => server!.listen(0, "127.0.0.1", r))
	return (server.address() as AddressInfo).port
}

function collect(port: number, seconds: number) {
	return new Promise<{
		code: number | null
		stdout: string
		stderr: string
		ms: number
	}>(done => {
		const t0 = Date.now()
		const child = spawn(process.execPath, [
			COLLECTOR,
			String(port),
			String(seconds),
			"dec",
		])
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (b: Buffer) => (stdout += b.toString()))
		child.stderr.on("data", (b: Buffer) => (stderr += b.toString()))
		child.on("close", code =>
			done({ code, stdout, stderr, ms: Date.now() - t0 }),
		)
	})
}

describe("collect-outputs.mjs", () => {
	it("exits 0 with the outputs and the status when the socket stays open", async () => {
		const port = await app(send =>
			send({
				type: "decoder:output",
				data: {
					decoderId: "dec",
					output: { type: "ship", data: { mmsi: "1" } },
				},
			}),
		)
		const r = await collect(port, 1)
		expect(r.code, r.stderr).toBe(0)
		expect(
			r.stdout
				.trim()
				.split("\n")
				.map(l => (JSON.parse(l) as { kind: string }).kind),
		).toEqual(["output", "status"])
	})
	it("exits non-zero as soon as the server closes the socket early", async () => {
		const port = await app((send, close) => {
			send({
				type: "decoder:output",
				data: { decoderId: "dec", output: { type: "ship", data: {} } },
			})
			close()
		})
		const r = await collect(port, 10)
		expect(r.code).toBe(3)
		expect(r.stderr).toMatch(/WebSocket closed.*1008/)
		expect(r.ms).toBeLessThan(8000)
	}, 15000)
})

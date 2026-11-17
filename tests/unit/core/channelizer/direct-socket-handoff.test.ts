/**
 * Direct channel input on real sockets, with no channelizer binary: a Unix-socket server in a fresh temp directory
 * stands in for wavekit-chan's channel socket and writes 1 MiB the moment a client connects. The real
 * ChannelizerManager (with a scripted process) connects through its own connector, and a real BaseDecoder spawns a
 * harmless shell pipeline with that socket as stdin. Every verdict is on the bytes the child wrote to a file.
 *
 * D1: Node never reads a byte of the socket (bytesRead stays 0, the child gets the stream from byte 0).
 * D3: Node's copy is destroyed right after the spawn, and the child still receives what is sent later.
 * The last cases move the pause after an await and show the stream's head is then lost, which is why the pause lives
 * inside the connector, before `connect` is emitted.
 */
import { spawn } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import {
	ChannelizerConfigSchema,
	type SourceCaps,
} from "../../../../src/config.js"
import {
	ChannelizerManager,
	type ChannelizerManagerDeps,
} from "../../../../src/core/channelizer/channelizer-manager.js"
import type { ChannelizerRequest } from "../../../../src/core/channelizer/protocol.js"
import type {
	DirectChannelRequestResult,
	DirectChannelSocket,
} from "../../../../src/core/channelizer/types.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import { BaseDecoder } from "../../../../src/decoders/base-decoder.js"
import type {
	DecoderCaps,
	DecoderOutput,
} from "../../../../src/decoders/types.js"
import { DecoderSpawnError } from "../../../../src/utils/errors.js"

const logger = pino({ level: "silent" })
const MIB = 1 << 20
const caps: SourceCaps = {
	kind: "iq",
	format: "U8_IQ",
	sampleRate: 2_048_000,
	centerFreq: 162e6,
	exclusive: false,
}
const request = {
	centerHz: 162e6,
	bandwidthHz: 45_600,
	transitionHz: 1200,
	outputRateHz: 48_000,
	format: "cf32" as const,
}

/** No 64 KiB period, so a lost head cannot line up with the rest. */
function pattern(offset: number, length: number): Buffer {
	const out = Buffer.allocUnsafe(length)
	for (let i = 0; i < length; i++) {
		const n = offset + i
		out[i] = (n * 7 + (n >>> 13) * 31 + (n >>> 17)) & 0xff
	}
	return out
}

/** Event-loop turns (each a real 10 ms timer), so a socket that is not paused has time to read. Never asserted. */
async function turns(count = 20): Promise<void> {
	for (let i = 0; i < count; i++)
		await new Promise(resolve => setTimeout(resolve, 10))
}

class ShellDecoder extends BaseDecoder {
	constructor(
		private readonly script: string,
		private readonly file: string,
	) {
		super({ id: "shell", type: "shell", enabled: true, options: {} }, logger)
	}
	protected getCommand(): string {
		return "/bin/sh"
	}
	protected getArgs(): string[] {
		return ["-c", this.script, this.file]
	}
	protected parseOutput(): DecoderOutput | null {
		return null
	}
	protected getCaps(): DecoderCaps {
		return { input: "iq", output: "text", integrationPattern: "pure_consumer" }
	}
}

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/** A server that writes the first MiB to each connection on accept and keeps them for the rest of the test. */
async function channelServer() {
	const dir = mkdtempSync("/tmp/wkd-")
	const path = join(dir, "chan.sock")
	const conns: Socket[] = []
	const waiters: (() => void)[] = []
	const server: Server = createServer(conn => {
		conns.push(conn)
		conn.on("error", () => {})
		conn.write(pattern(0, MIB))
		for (const wake of waiters.splice(0)) wake()
	})
	server.listen(path)
	await once(server, "listening")
	cleanup.push(() => {
		for (const conn of conns) conn.destroy()
		server.close()
		rmSync(dir, { recursive: true, force: true })
	})
	/** The n-th accepted connection (0-based), once it is accepted. */
	const accepted = async (n = 0): Promise<Socket> => {
		while (conns.length <= n)
			await new Promise<void>(resolve => waiters.push(resolve))
		return conns[n]!
	}
	return {
		dir,
		path,
		accepted,
		/** The second MiB on connection n, then the end of its stream. */
		finish: async (n = 0) => {
			;(await accepted(n)).end(pattern(MIB, MIB))
		},
		/** The end of connection n's stream, with nothing more. */
		end: async (n: number) => {
			;(await accepted(n)).end()
		},
	}
}

function scriptedManager(
	socketPath: string,
	dir: string,
	connect?: ChannelizerManagerDeps["connect"],
) {
	const sources = Object.assign(new EventEmitter(), { getCaps: () => caps })
	const fanout = new FanoutManager(logger)
	const sent: ChannelizerRequest[] = []
	const proc = Object.assign(new EventEmitter(), {
		generation: 1,
		input: new PassThrough(),
		start: () => {
			proc.emit("event", { v: 1, type: "ready", generation: 1, pid: 1 })
			return Promise.resolve()
		},
		stop: () => Promise.resolve(),
		send: (r: ChannelizerRequest) => {
			sent.push(r)
			if (r.type === "open")
				proc.emit("event", {
					v: 1,
					type: "opened",
					id: r.id,
					generation: 1,
					socket: socketPath,
					outputRateHz: r.outputRateHz,
					format: r.format,
					filterTaps: 10,
					groupDelaySamples: 5,
				})
			if (r.type === "close")
				proc.emit("event", {
					v: 1,
					type: "closed",
					id: r.id,
					generation: 1,
					reason: "requested",
				})
		},
	})
	const manager = new ChannelizerManager({
		sourceManager:
			sources as unknown as ChannelizerManagerDeps["sourceManager"],
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		logger,
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: dir }),
		createProcess: () => proc,
		...(connect ? { connect } : {}),
	})
	cleanup.push(async () => {
		await manager.destroy()
		fanout.destroy()
	})
	return { manager, sent }
}

async function directGrant(
	manager: ChannelizerManager,
): Promise<DirectChannelRequestResult> {
	return manager.requestChannel("s", "d", request, caps, undefined, {
		input: "direct",
	})
}

describe.each([
	["cat to a file", 'cat > "$0"'],
	["a shell pipeline", 'cat | cat > "$0"'],
])("direct hand-over to %s", (_name, script) => {
	it("gives the child every byte from byte 0, reads none and drops Node's copy after the spawn", async () => {
		const server = await channelServer()
		const { manager } = scriptedManager(server.path, server.dir)
		const grant = await directGrant(manager)
		if (!grant.ok || !("socket" in grant))
			throw new Error("expected a direct grant")
		expect("stream" in grant).toBe(false)
		const socket = grant.socket
		await server.accepted()
		await turns()
		expect(socket.bytesRead).toBe(0)
		expect(socket.listenerCount("data")).toBe(0)

		const file = join(server.dir, "out.bin")
		const decoder = new ShellDecoder(script, file)
		cleanup.push(() => decoder.stop())
		decoder.attachDirectInput(socket)
		const exited = once(decoder, "exit")
		await decoder.start()
		expect(socket.destroyed).toBe(true)
		expect(socket.bytesRead).toBe(0)

		await server.finish()
		const [code] = (await exited) as [number | null, string | null]
		expect(code).toBe(0)
		const written = readFileSync(file)
		expect(written.length).toBe(2 * MIB)
		expect(
			written.equals(Buffer.concat([pattern(0, MIB), pattern(MIB, MIB)])),
		).toBe(true)
		expect(decoder.getStatus().stats.bytesIn).toBe(0)
	}, 20_000)
})

describe("the pause lives in the connector", () => {
	/** A connector that awaits `connect` and only then pauses: the socket has started reading on its own. */
	const latePause: NonNullable<ChannelizerManagerDeps["connect"]> = async (
		path: string,
	) => {
		const socket = createConnection(path)
		socket.on("error", () => {})
		await once(socket, "connect")
		await turns()
		socket.pause()
		return socket
	}

	it("a socket paused after an await has read the stream's head: the grant is refused and the channel closed", async () => {
		const server = await channelServer()
		const { manager, sent } = scriptedManager(
			server.path,
			server.dir,
			latePause,
		)
		const grant = await directGrant(manager)
		expect(grant).toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: "channel socket not paused for direct input",
		})
		expect(sent.map(r => r.type)).toEqual(["open", "close"])
	}, 20_000)

	it("handed over anyway, the child misses everything Node read, and the decoder refuses that hand-over", async () => {
		const server = await channelServer()
		const late = (await latePause(server.path)) as DirectChannelSocket
		const lost = late.bytesRead
		expect(lost).toBeGreaterThan(0)

		// The decoder's guard: such a socket is never handed over.
		const decoder = new ShellDecoder('cat > "$0"', join(server.dir, "x.bin"))
		decoder.attachDirectInput(late)
		await expect(decoder.start()).rejects.toBeInstanceOf(DecoderSpawnError)
		expect(late.destroyed).toBe(true)

		// The same hand-over without the guard: what Node buffered never reaches the child.
		const again = (await latePause(server.path)) as DirectChannelSocket
		const missing = again.bytesRead
		expect(missing).toBeGreaterThan(0)
		const file = join(server.dir, "late.bin")
		const child = spawn("/bin/sh", ["-c", 'cat > "$0"', file], {
			stdio: [again, "ignore", "ignore"],
		})
		again.destroy()
		const exited = once(child, "exit")
		// Connection 0 was the refused hand-over; connection 1 is this child's.
		await server.end(1)
		await exited
		const written = readFileSync(file)
		expect(written.length).toBe(MIB - missing)
		expect(written.equals(pattern(0, MIB))).toBe(false)
		expect(written.equals(pattern(missing, MIB - missing))).toBe(true)
	}, 20_000)
})

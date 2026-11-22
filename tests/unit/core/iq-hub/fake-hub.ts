/**
 * An in-process fake `wavekit-iqhub` speaking the protocol subset the supervisor uses, with a
 * real Unix listener in a private 0700 mkdtemp directory. Injected through a HubProcessFactory.
 * No network: the "upstream" is scripted by the test (front.send, front.endStream, ...).
 */
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import type {
	HubExit,
	HubProcess,
	HubProcessFactory,
	HubProcessHandlers,
	HubSpawnOptions,
} from "../../../../src/core/iq-hub/hub-process.js"

export const ALL_FEATURES = [
	"mark",
	"sink-update",
	"link-gap",
	"tcp-connected",
	"header-timeout",
	"errno",
	"close-modes",
	"front",
	"rcvbuf",
	"stats-file",
]

export type Request = Record<string, unknown> & { type: string; seq?: number }

export type ConnectBehavior =
	| { kind: "accept"; localPort?: number; header?: Buffer; delayMs?: number }
	| { kind: "refuse"; reason: string; errno?: number }
	| { kind: "reject"; reason: string }
	| { kind: "silent" }

export class FakeFront {
	readonly commands: Buffer[] = []
	socket: net.Socket | null = null
	started = false
	sinkBytes = 0
	headerSent = 0
	dropped = 0
	ended = false
	nodeEof = false
	/** The hub itself destroyed the front connection (its close is no Node EOF). */
	hubClosed = false
	private onStart: (() => void)[] = []
	private onEof: (() => void)[] = []
	private onCommand: (() => void)[] = []

	constructor(
		readonly hub: FakeHubInstance,
		readonly sink: string,
		readonly attempt: FakeAttempt,
	) {}

	get commandBytes(): Buffer {
		return Buffer.concat(this.commands)
	}

	whenStarted(): Promise<void> {
		if (this.started) return Promise.resolve()
		return new Promise(resolve => this.onStart.push(resolve))
	}

	whenEof(): Promise<void> {
		if (this.nodeEof) return Promise.resolve()
		return new Promise(resolve => this.onEof.push(resolve))
	}

	async whenCommandBytes(n: number): Promise<Buffer> {
		while (this.commandBytes.length < n)
			await new Promise<void>(resolve => this.onCommand.push(resolve))
		return this.commandBytes
	}

	noteCommand(chunk: Buffer): void {
		this.commands.push(Buffer.from(chunk))
		for (const wake of this.onCommand.splice(0)) wake()
	}

	noteEof(): void {
		this.nodeEof = true
		for (const wake of this.onEof.splice(0)) wake()
	}

	start(): void {
		if (this.started || !this.socket || !this.attempt.adopted) return
		this.started = true
		this.hub.emit("sink-started", {
			sink: this.sink,
			startSourcePos: this.hub.sourcePos,
			sinkByte: 0,
		})
		this.socket.write(this.attempt.header)
		this.headerSent = this.attempt.header.length
		for (const wake of this.onStart.splice(0)) wake()
	}

	/** Upstream payload delivered to the front. */
	send(payload: Buffer): void {
		this.hub.sourcePos += payload.length
		this.sinkBytes += payload.length
		this.socket?.write(payload)
	}

	/** A lag skip the hub reports (the bytes never reach Node). */
	gap(droppedBytes: number, cause: "lag" | "start" = "lag"): void {
		this.hub.emit("sink-gap", {
			sink: this.sink,
			atSinkByte: this.sinkBytes,
			atSourcePos: this.hub.sourcePos,
			droppedBytes,
			cause,
		})
		this.hub.sourcePos += droppedBytes
		this.dropped += droppedBytes
	}

	placed(frontBytes: number, queuedBytes = 0): void {
		this.hub.emit("front-placed", {
			sink: this.sink,
			frontBytes,
			atSourcePos: this.hub.sourcePos,
			sinkByte: this.sinkBytes,
			queuedBytes,
		})
	}

	frontEnded(reason: string, errno?: number, discardedBytes = 0): void {
		if (this.ended) return
		this.ended = true
		this.hub.emit("front-ended", {
			sink: this.sink,
			sinkBytes: this.sinkBytes,
			headerSent: this.headerSent,
			droppedBytes: this.dropped,
			discardedBytes,
			reason,
			...(errno !== undefined ? { errno } : {}),
		})
	}

	/**
	 * The upstream stream ends: `closed` of the adopted attempt, `front-ended`, then the front's FIN
	 * (or the FIN first with `finFirst`, or no FIN with `noFin`). `discardedBytes` of upstream
	 * payload the front's EOF cut off advance the source position without reaching Node.
	 */
	endStream(
		reason: string,
		options: {
			errno?: number
			finFirst?: boolean
			noFin?: boolean
			discardedBytes?: number
		} = {},
	): void {
		this.hub.sourcePos += options.discardedBytes ?? 0
		this.hub.closeAttempt(this.attempt, "adopted", reason, options.errno)
		if (options.finFirst) this.socket?.end()
		this.frontEnded(reason, options.errno, options.discardedBytes ?? 0)
		if (!options.finFirst && !options.noFin) this.socket?.end()
	}
}

export interface FakeAttempt {
	id: number
	seq: number | undefined
	request: Request
	header: Buffer
	adopted: boolean
	closed: boolean
	front: FakeFront | null
}

export class FakeHubInstance implements HubProcess {
	readonly pid: number
	readonly requests: Request[] = []
	readonly attempts = new Map<number, FakeAttempt>()
	readonly fronts = new Map<string, FakeFront>()
	readonly server: net.Server
	readonly signals: string[] = []
	sourcePos = 0
	stream = 0
	stopped = false
	exited = false
	controlEnded = false
	private progress: ReturnType<typeof setInterval> | null = null
	private readonly frontWaiters: ((front: FakeFront) => void)[] = []
	private readonly requestWaiters: (() => void)[] = []

	constructor(
		readonly owner: FakeHub,
		readonly socketDir: string,
		readonly sinkSocket: string,
		private readonly handlers: HubProcessHandlers,
		pid: number,
	) {
		this.pid = pid
		this.server = net.createServer({ allowHalfOpen: true }, conn =>
			this.onConnection(conn),
		)
	}

	listen(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server.once("error", reject)
			this.server.listen(this.sinkSocket, () => resolve())
		})
	}

	emit(type: string, members: Record<string, unknown>, seq?: number): void {
		if (this.stopped || this.exited) return
		const line = JSON.stringify({
			v: 1,
			type,
			mono: 1,
			...members,
			...(seq !== undefined ? { seq } : {}),
			sourcePos: this.sourcePos,
		})
		this.handlers.onLine(line)
	}

	emitRaw(line: string): void {
		this.handlers.onLine(line)
	}

	ready(features = ALL_FEATURES): void {
		this.emit("ready", {
			protocol: 1,
			features,
			sinkSocket: this.sinkSocket,
			maxSinks: 32,
			maxAttempts: 4,
		})
	}

	send(line: string): boolean {
		if (this.exited || this.controlEnded) return false
		if (this.stopped) return true
		const request = JSON.parse(line) as Request
		this.requests.push(request)
		for (const wake of this.requestWaiters.splice(0)) wake()
		this.owner.onRequest(this, request)
		return true
	}

	requestsOf(type: string): Request[] {
		return this.requests.filter(r => r.type === type)
	}

	async whenRequest(type: string, count = 1): Promise<Request> {
		while (this.requestsOf(type).length < count)
			await new Promise<void>(resolve => this.requestWaiters.push(resolve))
		return this.requestsOf(type)[count - 1] as Request
	}

	whenFront(): Promise<FakeFront> {
		return new Promise(resolve => this.frontWaiters.push(resolve))
	}

	startProgress(): void {
		if (this.progress !== null) return
		this.progress = setInterval(
			() => this.emit("progress", { stream: null }),
			50,
		)
	}

	/** SIGSTOP: the process emits and reads nothing. */
	stop(): void {
		this.stopped = true
	}

	endControl(): void {
		this.controlEnded = true
		if (this.owner.ignoreShutdown) return
		this.exit({ code: 0, signal: null, spawnError: null })
	}

	kill(signal: "SIGKILL" | "SIGTERM" | "SIGSTOP" | "SIGCONT"): void {
		this.signals.push(signal)
		if (signal === "SIGSTOP") this.stop()
		else if (signal === "SIGCONT") this.stopped = false
		else this.exit({ code: null, signal, spawnError: null })
	}

	stderrTail(): string {
		return "fake hub\n"
	}

	removeSocketDir(): Promise<void> {
		return fs.promises.rm(this.socketDir, { recursive: true, force: true })
	}

	exit(exit: HubExit): void {
		if (this.exited) return
		this.exited = true
		if (this.progress !== null) clearInterval(this.progress)
		for (const front of this.fronts.values()) {
			front.hubClosed = true
			front.socket?.destroy()
		}
		this.server.close()
		setImmediate(() => this.handlers.onExit(exit))
	}

	closeAttempt(
		attempt: FakeAttempt,
		phase: string,
		reason: string,
		errno?: number,
		extra: Record<string, unknown> = {},
	): void {
		if (attempt.closed) return
		attempt.closed = true
		this.emit("closed", {
			attempt: attempt.id,
			phase,
			reason,
			...(errno !== undefined ? { errno } : {}),
			...(attempt.front ? { front: attempt.front.sink } : {}),
			...extra,
		})
	}

	adopt(attempt: FakeAttempt): void {
		if (attempt.adopted || attempt.closed) return
		attempt.adopted = true
		this.stream += 1
		this.emit("adopted", { attempt: attempt.id, stream: this.stream })
		attempt.front?.start()
	}

	private onConnection(conn: net.Socket): void {
		conn.on("error", () => {})
		let buffered = Buffer.alloc(0)
		let front: FakeFront | null = null
		conn.on("data", (chunk: Buffer) => {
			if (front) {
				front.noteCommand(chunk)
				return
			}
			buffered = Buffer.concat([buffered, chunk])
			const nl = buffered.indexOf(0x0a)
			if (nl === -1) return
			const hello = JSON.parse(buffered.subarray(0, nl).toString()) as {
				sink: string
			}
			const found = this.fronts.get(hello.sink)
			if (!found) {
				this.emit("sink-rejected", { reason: "unknown" })
				conn.destroy()
				return
			}
			front = found
			front.socket = conn
			this.emit("sink-bound", { sink: front.sink })
			const rest = buffered.subarray(nl + 1)
			if (rest.length > 0) front.noteCommand(rest)
			for (const wake of this.frontWaiters.splice(0)) wake(front)
			front.start()
		})
		// F9: the front's EOF (or its close: Node destroyed it) ends its delivery and gracefully
		// aborts its attempt.
		const peerGone = () => {
			if (!front || front.nodeEof || front.hubClosed) return
			front.noteEof()
			if (this.owner.ignoreFrontEof) return
			front.frontEnded("front-closed")
			if (!conn.destroyed) conn.end()
			this.closeAttempt(front.attempt, "adopted", "aborted", undefined, {
				mode: "graceful",
				by: "front",
			})
			this.emit("sink-closed", {
				sink: front.sink,
				reason: "peer",
				sinkBytes: front.sinkBytes,
			})
		}
		conn.on("end", peerGone)
		conn.on("close", peerGone)
	}
}

/** The factory and the script for every instance it spawns. */
export class FakeHub {
	readonly instances: FakeHubInstance[] = []
	features = ALL_FEATURES
	readyDelayMs = 0
	noReady = false
	spawnFails = false
	ignoreShutdown = false
	ignoreFrontEof = false
	configureAnswer: "configured" | "reject" | "silent" = "configured"
	sinkOpenReject: string | null = null
	connectBehavior: (attempt: number) => ConnectBehavior = () => ({
		kind: "accept",
	})
	defaultHeader = Buffer.from("RTL0\x00\x00\x00\x05\x00\x00\x00\x1d", "latin1")
	private nextPid = 900_001
	private readonly spawnWaiters: ((hub: FakeHubInstance) => void)[] = []
	readonly dirs: string[] = []

	get factory(): HubProcessFactory {
		return (options, handlers) => this.spawn(options, handlers)
	}

	get last(): FakeHubInstance {
		const hub = this.instances.at(-1)
		if (!hub) throw new Error("no fake hub spawned")
		return hub
	}

	whenSpawned(count = 1): Promise<FakeHubInstance> {
		if (this.instances.length >= count)
			return Promise.resolve(this.instances[count - 1] as FakeHubInstance)
		return new Promise(resolve =>
			this.spawnWaiters.push(hub => {
				if (this.instances.length >= count) resolve(hub)
			}),
		)
	}

	private async spawn(
		_options: HubSpawnOptions,
		handlers: HubProcessHandlers,
	): Promise<HubProcess> {
		if (this.spawnFails) throw new Error("spawn ENOENT")
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wk-fakehub-"))
		await fs.promises.chmod(dir, 0o700)
		this.dirs.push(dir)
		const hub = new FakeHubInstance(
			this,
			dir,
			path.join(dir, "hub.sock"),
			handlers,
			this.nextPid++,
		)
		await hub.listen()
		this.instances.push(hub)
		for (const wake of this.spawnWaiters.splice(0)) wake(hub)
		if (!this.noReady)
			setTimeout(() => hub.ready(this.features), this.readyDelayMs)
		return hub
	}

	onRequest(hub: FakeHubInstance, request: Request): void {
		const seq = request.seq
		switch (request.type) {
			case "configure":
				if (this.configureAnswer === "silent") return
				if (this.configureAnswer === "reject") {
					hub.emit("rejected", { request: "configure", reason: "bounds" }, seq)
					return
				}
				hub.sourcePos = 0
				hub.emit("configured", { ringBytes: 1000 }, seq)
				hub.startProgress()
				return
			case "connect":
				this.onConnect(hub, request)
				return
			case "sink-open": {
				const attempt = hub.attempts.get(request["attempt"] as number)
				if (this.sinkOpenReject !== null || !attempt || attempt.closed) {
					hub.emit(
						"rejected",
						{
							request: "sink-open",
							reason: this.sinkOpenReject ?? "unknown-attempt",
						},
						seq,
					)
					return
				}
				const front = new FakeFront(hub, request["sink"] as string, attempt)
				attempt.front = front
				hub.fronts.set(front.sink, front)
				hub.emit("sink-ready", { sink: front.sink }, seq)
				return
			}
			case "abort": {
				const attempt = hub.attempts.get(request["attempt"] as number)
				if (!attempt || attempt.closed) {
					hub.emit(
						"rejected",
						{ request: "abort", reason: "unknown-attempt" },
						seq,
					)
					return
				}
				const phase = attempt.adopted ? "adopted" : "connect"
				hub.closeAttempt(attempt, phase, "aborted", undefined, {
					mode: "now",
					seq,
				})
				const front = attempt.front
				if (front?.started) {
					front.frontEnded("aborted")
					front.socket?.end()
				} else if (front) {
					hub.emit("sink-closed", {
						sink: front.sink,
						reason: "attempt-closed",
						sinkBytes: 0,
					})
					front.hubClosed = true
					front.socket?.destroy()
				}
				return
			}
			case "shutdown":
				if (this.ignoreShutdown) return
				hub.exit({ code: 0, signal: null, spawnError: null })
				return
			default:
				return
		}
	}

	private onConnect(hub: FakeHubInstance, request: Request): void {
		const id = request["attempt"] as number
		const behavior = this.connectBehavior(id)
		if (behavior.kind === "reject") {
			hub.emit(
				"rejected",
				{ request: "connect", reason: behavior.reason },
				request.seq,
			)
			return
		}
		const attempt: FakeAttempt = {
			id,
			seq: request.seq,
			request,
			header: this.defaultHeader,
			adopted: false,
			closed: false,
			front: null,
		}
		hub.attempts.set(id, attempt)
		if (behavior.kind === "silent") return
		if (behavior.kind === "refuse") {
			setImmediate(() =>
				hub.closeAttempt(attempt, "connect", behavior.reason, behavior.errno, {
					connectSeq: request.seq,
				}),
			)
			return
		}
		if (behavior.header) attempt.header = behavior.header
		const run = () => {
			if (attempt.closed) return
			hub.emit(
				"tcp-connected",
				{ attempt: id, localPort: behavior.localPort ?? 40_000 + id },
				request.seq,
			)
			hub.emit("connected", {
				attempt: id,
				headerHex: attempt.header.toString("hex"),
			})
			// A fronted attempt adopts itself once its header is complete.
			if (attempt.front) hub.adopt(attempt)
		}
		if (behavior.delayMs !== undefined) setTimeout(run, behavior.delayMs)
		else setImmediate(run)
	}

	async cleanup(): Promise<void> {
		for (const hub of this.instances)
			if (!hub.exited) hub.exit({ code: 0, signal: null, spawnError: null })
		for (const dir of this.dirs)
			await fs.promises.rm(dir, { recursive: true, force: true })
	}
}

/** Resolves on the socket's `close`, with the error it reported (if any). */
export function closeOf(
	socket: net.Socket,
): Promise<{ error: (Error & { code?: string }) | null; events: string[] }> {
	const events: string[] = []
	let error: (Error & { code?: string }) | null = null
	socket.on("error", (err: Error & { code?: string }) => {
		error = err
		events.push("error")
	})
	socket.on("end", () => events.push("end"))
	return new Promise(resolve =>
		socket.once("close", () => {
			events.push("close")
			resolve({ error, events })
		}),
	)
}

/** Collects every byte the socket reads. */
export function collect(socket: net.Socket): { bytes: () => Buffer } {
	const chunks: Buffer[] = []
	socket.on("data", (chunk: Buffer) => chunks.push(chunk))
	return { bytes: () => Buffer.concat(chunks) }
}

export async function until(
	predicate: () => boolean,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition not met in time")
		await new Promise(resolve => setTimeout(resolve, 5))
	}
}

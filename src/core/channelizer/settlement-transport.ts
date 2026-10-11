import type { ChildProcess } from "node:child_process"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, rmdir, unlink } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { WaveKitError } from "../../utils/errors.js"
import { isSettlementToken } from "./protocol.js"
import { registerSettlementTransport } from "./settlement-observer.js"
import type {
	ChannelSettlementObserver,
	CleanupOutcome,
	LocalCleanupClaim,
	ProcessClaim,
	ProviderLifetime,
} from "./settlement-observer.js"

const FRAME_BYTES = 256
const MAX_PULLS = 8
const MAX_CANDIDATES = 4
const MAX_ADMISSIONS = 8
const unavailable = (detail: string) =>
	new WaveKitError(detail, "CHANNELIZER_UNAVAILABLE")

type Disposition = "UNACCEPTED" | "ACCEPTED" | "REJECTED" | "CLOSING" | "CLOSED"
interface Hello {
	readonly type: "hello"
	readonly nonce: string
	readonly pid: string
}
interface Disposed {
	readonly type: "disposed"
	readonly token: string
	readonly id: string
}
type Frame = Hello | Disposed

/** Exact canonical spelling also rejects duplicate keys, escapes, BOM and invalid UTF8. */
export function parseSettlementFrame(frame: Buffer): Frame | undefined {
	if (
		frame.length > FRAME_BYTES ||
		frame.length === 0 ||
		frame[frame.length - 1] !== 10
	)
		return undefined
	for (const byte of frame)
		if (byte > 127 || byte === 0 || byte === 13) return undefined
	const line = frame.toString("ascii")
	const hello =
		/^\{"v":1,"type":"hello","nonce":"([0-9a-f]{64})","pid":"([1-9][0-9]{0,19})"\}\n$/.exec(
			line,
		)
	if (hello?.[1] && hello[2] && isSettlementToken(hello[2]))
		return { type: "hello", nonce: hello[1], pid: hello[2] }
	const disposed =
		/^\{"v":1,"type":"disposed","token":"([1-9][0-9]{0,19})","id":"([A-Za-z0-9._-]{1,64})"\}\n$/.exec(
			line,
		)
	if (disposed?.[1] && disposed[2] && isSettlementToken(disposed[1]))
		return { type: "disposed", token: disposed[1], id: disposed[2] }
	return undefined
}

interface CandidateRecord {
	readonly socket: Socket
	readonly process: ProcessClaim
	readonly provider: ProviderLifetime
	readonly startup: object
	readonly cleanup: LocalCleanupClaim
	readonly buffer: Buffer
	disposition: Disposition
	wasRejected: boolean
	length: number
	running: boolean
	scheduled: boolean
	closed: boolean
	eof: boolean
	immediate: NodeJS.Immediate | undefined
	hello: Hello | undefined
}

/** Owns one original process incarnation. No reconnect or successor lookup is possible. */
export class SettlementTransport {
	readonly nonce = randomBytes(32)
	readonly authenticated: Promise<void>
	private resolveAuthenticated!: () => void
	private rejectAuthenticated!: (error: WaveKitError) => void
	private authenticationSettled = false
	private readonly startup = Object.freeze({})
	private readonly candidates = new Set<CandidateRecord>()
	private accepted: CandidateRecord | undefined
	private child: ChildProcess | undefined
	private ready = false
	private sealed = false
	private admissions = 0
	private overflow: Socket | undefined
	private server: Server | undefined
	private serverClosing = false
	private serverClosed = false
	private listenSettled = false
	private readonly serverClaim: LocalCleanupClaim
	private readonly endpointClaim: LocalCleanupClaim
	private readonly directoryClaim: LocalCleanupClaim
	private readonly overflowClaim: LocalCleanupClaim
	private listenPromise: Promise<void> | undefined
	private cleanupPromise: Promise<readonly CleanupOutcome[]> | undefined
	private serverClosePromise: Promise<CleanupOutcome> | undefined
	private resolveServerClose: ((outcome: CleanupOutcome) => void) | undefined
	private directory = ""
	private observerDirectory = ""
	private path = ""
	private directoryIdentity: { dev: number; ino: number } | undefined
	private observerIdentity: { dev: number; ino: number } | undefined
	private endpointIdentity: { dev: number; ino: number } | undefined

	constructor(
		private readonly process: ProcessClaim,
		private readonly observer: ChannelSettlementObserver,
	) {
		// All local ownership exists before setup can yield or invoke a listener.
		const server = process.retainLocal("server")
		const endpoint = process.retainLocal("endpoint")
		const directory = process.retainLocal("directory")
		const overflow = process.retainLocal("candidate")
		if (!server || !endpoint || !directory || !overflow) {
			// These newly reserved claims precede every server/path/socket effect.
			for (const claim of [server, endpoint, directory, overflow])
				claim?.settle({ ok: true })
			throw unavailable("channel settlement local ownership unavailable")
		}
		if (!registerSettlementTransport(process, this)) {
			for (const claim of [server, endpoint, directory, overflow])
				claim.settle({ ok: true })
			throw unavailable("settlement transport already owned")
		}
		this.serverClaim = server
		this.endpointClaim = endpoint
		this.directoryClaim = directory
		this.overflowClaim = overflow
		this.authenticated = new Promise((resolve, reject) => {
			this.resolveAuthenticated = resolve
			this.rejectAuthenticated = reject
		})
		// Retain the rejection for the startup owner while avoiding a transient unhandled rejection.
		void this.authenticated.catch(() => {})
	}

	get socketPath(): string {
		return this.path
	}

	listen(): Promise<void> {
		this.listenPromise ??= this.setup()
		return this.listenPromise
	}

	private async setup(): Promise<void> {
		try {
			if (this.sealed || process.platform === "win32")
				throw unavailable("settlement startup sealed or unsupported")
			this.directory = await mkdtemp(join(tmpdir(), "wks-"))
			await chmod(this.directory, 0o700)
			const root = await lstat(this.directory)
			if (
				!root.isDirectory() ||
				root.isSymbolicLink() ||
				root.uid !== process.getuid?.() ||
				(root.mode & 0o777) !== 0o700
			)
				throw unavailable("invalid settlement directory ownership")
			this.directoryIdentity = { dev: root.dev, ino: root.ino }
			if (this.sealed) throw unavailable("settlement startup sealed")
			this.observerDirectory = join(this.directory, "observer")
			await mkdir(this.observerDirectory, { mode: 0o700 })
			const sub = await lstat(this.observerDirectory)
			if (
				!sub.isDirectory() ||
				sub.isSymbolicLink() ||
				sub.uid !== root.uid ||
				(sub.mode & 0o777) !== 0o700
			)
				throw unavailable("invalid settlement observer directory")
			this.observerIdentity = { dev: sub.dev, ino: sub.ino }
			this.path = join(this.observerDirectory, "ack.sock")
			if (!isAbsolute(this.path) || Buffer.byteLength(this.path, "utf8") > 90)
				throw unavailable("settlement socket path exceeds 90 UTF8 bytes")
			if (this.sealed) throw unavailable("settlement startup sealed")
			const server = createServer({ highWaterMark: FRAME_BYTES }, socket =>
				this.connect(socket),
			)
			this.server = server
			this.serverClosePromise = new Promise(resolve => {
				this.resolveServerClose = resolve
			})
			server.on("error", error => {
				const accepted = this.accepted
				if (accepted && this.hasAcceptedAuthority(accepted))
					this.loss(accepted, error)
				else this.failStartup(error)
			})
			server.on("close", () => {
				this.serverClosed = true
				const outcome: CleanupOutcome = { ok: true }
				this.serverClaim.settle(outcome)
				this.resolveServerClose?.(outcome)
			})
			await new Promise<void>((resolve, reject) => {
				const failed = (error: Error) => {
					this.listenSettled = true
					server.off("listening", listened)
					this.serverClosing = false
					this.closeServer()
					reject(error)
				}
				const listened = () => {
					this.listenSettled = true
					server.off("error", failed)
					resolve()
				}
				server.once("error", failed)
				server.once("listening", listened)
				server.listen(this.path)
			})
			const endpoint = await lstat(this.path)
			if (
				!endpoint.isSocket() ||
				endpoint.isSymbolicLink() ||
				endpoint.uid !== root.uid
			)
				throw unavailable("invalid settlement endpoint ownership")
			this.endpointIdentity = { dev: endpoint.dev, ino: endpoint.ino }
			await chmod(this.path, 0o600)
			if (this.sealed) {
				this.closeServer()
				throw unavailable("settlement startup sealed")
			}
		} catch (error: unknown) {
			this.failStartup(error)
			throw error
		}
	}

	assignChild(child: ChildProcess): void {
		if (this.sealed || this.child) {
			this.failStartup(unavailable("invalid settlement child assignment"))
			return
		}
		this.child = child
		if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
			this.failStartup(unavailable("settlement child has no valid PID"))
			return
		}
		for (const candidate of this.candidates)
			if (candidate.hello) this.authenticate(candidate, candidate.hello)
	}

	markReady(capability: "attempt-disposal-v1"): void {
		if (this.sealed) return
		if (capability !== "attempt-disposal-v1") {
			this.failStartup(unavailable("settlement capability mismatch"))
			return
		}
		this.ready = true
		this.completeAuthentication()
	}

	private completeAuthentication(): void {
		if (
			this.sealed ||
			!this.ready ||
			!this.accepted ||
			this.authenticationSettled
		)
			return
		this.authenticationSettled = true
		this.resolveAuthenticated()
	}

	private connect(socket: Socket): void {
		// Untracked postseal sockets are covered by the original server-close aggregate barrier.
		if (this.sealed || this.accepted) {
			socket.on("error", () => {})
			socket.destroy()
			return
		}
		if (
			this.candidates.size >= MAX_CANDIDATES ||
			this.admissions >= MAX_ADMISSIONS
		) {
			if (!this.overflow) {
				this.overflow = socket
				socket.on("error", () => {})
				socket.once("close", () => {
					this.overflowClaim.settle({ ok: true })
					this.overflow = undefined
				})
			}
			this.failStartup(
				unavailable("settlement startup candidate capacity unavailable"),
			)
			socket.destroy()
			return
		}
		const cleanup = this.process.retainLocal("candidate")
		if (!cleanup) {
			this.failStartup(
				unavailable("settlement candidate ownership unavailable"),
			)
			socket.destroy()
			return
		}
		this.admissions++
		const candidate: CandidateRecord = {
			socket,
			process: this.process,
			provider: this.observer.provider,
			startup: this.startup,
			cleanup,
			buffer: Buffer.alloc(FRAME_BYTES),
			disposition: "UNACCEPTED",
			wasRejected: false,
			length: 0,
			running: false,
			scheduled: false,
			closed: false,
			eof: false,
			immediate: undefined,
			hello: undefined,
		}
		this.candidates.add(candidate)
		socket.on("readable", () => this.pump(candidate))
		socket.on("end", () => {
			candidate.eof = true
			this.pump(candidate)
		})
		socket.on("error", error => this.loss(candidate, error))
		socket.on("close", () => {
			this.loss(candidate, unavailable("settlement socket closed"))
			candidate.disposition = "CLOSED"
			candidate.cleanup.settle({ ok: true })
			this.candidates.delete(candidate)
		})
	}

	private fence(candidate: CandidateRecord): void {
		candidate.closed = true
		if (candidate.immediate) clearImmediate(candidate.immediate)
		candidate.immediate = undefined
		candidate.scheduled = false
	}

	private rejectCandidate(candidate: CandidateRecord): void {
		if (
			candidate.disposition === "CLOSED" ||
			candidate.disposition === "CLOSING"
		)
			return
		candidate.disposition = "REJECTED"
		candidate.wasRejected = true
		this.fence(candidate)
		candidate.disposition = "CLOSING"
		candidate.socket.destroy()
	}

	private hasAcceptedAuthority(candidate: CandidateRecord): boolean {
		return (
			!this.sealed &&
			candidate === this.accepted &&
			candidate.socket === this.accepted.socket &&
			candidate.process === this.process &&
			candidate.provider === this.observer.provider &&
			candidate.startup === this.startup &&
			candidate.disposition === "ACCEPTED" &&
			!candidate.wasRejected
		)
	}

	private loss(candidate: CandidateRecord, error: unknown): void {
		if (this.hasAcceptedAuthority(candidate)) {
			candidate.disposition = "CLOSING"
			this.sealed = true
			this.process.sealStartup()
			this.observer.sealAdmission()
			this.fence(candidate)
			this.rejectAuthentication(error)
			this.closeServer()
			candidate.socket.destroy()
		} else if (candidate.disposition === "UNACCEPTED")
			this.rejectCandidate(candidate)
		else this.fence(candidate)
	}

	private authenticate(candidate: CandidateRecord, hello: Hello): void {
		if (
			candidate.closed ||
			this.sealed ||
			candidate.disposition !== "UNACCEPTED"
		)
			return
		if (!this.child) {
			candidate.hello = hello
			return
		}
		if (
			this.accepted ||
			hello.pid !== String(this.child.pid) ||
			!timingSafeEqual(Buffer.from(hello.nonce, "hex"), this.nonce)
		) {
			this.rejectCandidate(candidate)
			return
		}
		// Claim authority before destroying any other socket, which can reenter synchronously.
		candidate.disposition = "ACCEPTED"
		candidate.hello = undefined
		this.accepted = candidate
		this.candidates.delete(candidate)
		for (const other of this.candidates) this.rejectCandidate(other)
		this.closeServer()
		this.completeAuthentication()
	}

	private frame(candidate: CandidateRecord, bytes: Buffer): void {
		const frame = parseSettlementFrame(bytes)
		if (!frame) {
			this.loss(candidate, unavailable("invalid settlement frame"))
			return
		}
		if (candidate.disposition === "UNACCEPTED") {
			if (frame.type !== "hello" || candidate.hello) {
				this.rejectCandidate(candidate)
				return
			}
			this.authenticate(candidate, frame)
			return
		}
		if (!this.hasAcceptedAuthority(candidate)) return
		if (
			frame.type !== "disposed" ||
			!this.observer.recordDisposed(candidate.process, frame.token, frame.id)
		)
			this.loss(candidate, unavailable("invalid settlement disposal identity"))
	}

	private pump(candidate: CandidateRecord): void {
		if (candidate.closed || candidate.running || candidate.scheduled) return
		candidate.running = true
		let pulls = 0
		let nullRead = false
		try {
			while (!candidate.closed && pulls < MAX_PULLS) {
				const available = candidate.socket.readableLength
				if (available <= 0) break
				const room = FRAME_BYTES - candidate.length
				if (room <= 0) {
					this.loss(candidate, unavailable("overlong settlement frame"))
					break
				}
				pulls++
				const chunk: unknown = candidate.socket.read(
					Math.min(available, FRAME_BYTES, room),
				)
				if (chunk === null) {
					nullRead = true
					break
				}
				if (
					!Buffer.isBuffer(chunk) ||
					chunk.length === 0 ||
					chunk.length > room
				) {
					this.loss(candidate, unavailable("invalid settlement readable pull"))
					break
				}
				for (const byte of chunk) {
					if (candidate.closed) break
					candidate.buffer[candidate.length++] = byte
					if (byte === 10) {
						this.frame(
							candidate,
							candidate.buffer.subarray(0, candidate.length),
						)
						candidate.length = 0
					} else if (candidate.length === FRAME_BYTES) {
						this.loss(candidate, unavailable("overlong settlement frame"))
					}
				}
			}
		} catch (error: unknown) {
			this.loss(candidate, error)
		} finally {
			candidate.running = false
		}
		if (candidate.closed) return
		if (
			!nullRead &&
			pulls === MAX_PULLS &&
			candidate.socket.readableLength > 0
		) {
			candidate.scheduled = true
			candidate.immediate = setImmediate(() => {
				candidate.immediate = undefined
				candidate.scheduled = false
				if (!candidate.closed) this.pump(candidate)
			})
			return
		}
		if (candidate.eof && candidate.socket.readableLength === 0)
			this.loss(
				candidate,
				unavailable(
					candidate.length
						? "partial settlement frame at EOF"
						: "settlement EOF",
				),
			)
	}

	private rejectAuthentication(error: unknown): void {
		if (this.authenticationSettled) return
		this.authenticationSettled = true
		this.rejectAuthenticated(
			error instanceof WaveKitError ? error : unavailable(String(error)),
		)
	}

	private failStartup(error: unknown): void {
		if (this.sealed) return
		this.sealed = true
		this.process.sealStartup()
		this.rejectAuthentication(error)
		if (this.accepted) {
			this.accepted.disposition = "CLOSING"
			this.fence(this.accepted)
			this.accepted.socket.destroy()
		}
		for (const candidate of this.candidates) this.rejectCandidate(candidate)
		this.closeServer()
	}

	seal(): void {
		this.failStartup(unavailable("settlement startup sealed"))
	}

	private closeServer(): void {
		if (!this.server || this.serverClosing || this.serverClosed) return
		this.serverClosing = true
		// A pending listen callback still belongs to this server and may only close it.
		if (!this.server.listening && !this.listenSettled) {
			this.server.once("listening", () => {
				this.server?.close()
			})
			return
		}
		this.server.close(error => {
			if (!error) return
			const outcome: CleanupOutcome =
				"code" in error && error.code === "ERR_SERVER_NOT_RUNNING"
					? { ok: true }
					: {
							ok: false,
							state: "failed",
							detail: "settlement server cleanup failed",
						}
			this.serverClosed = outcome.ok
			this.serverClaim.settle(outcome)
			this.resolveServerClose?.(outcome)
		})
	}

	cleanup(): Promise<readonly CleanupOutcome[]> {
		this.cleanupPromise ??= this.cleanupOwned()
		return this.cleanupPromise
	}

	private async cleanupOwned(): Promise<readonly CleanupOutcome[]> {
		this.seal()
		// Setup must settle before any owned pathname is inspected or removed.
		if (this.listenPromise) await this.listenPromise.catch(() => {})
		const outcomes: CleanupOutcome[] = []
		const serverOutcome =
			this.serverClosePromise ?? Promise.resolve<CleanupOutcome>({ ok: true })
		if (!this.serverClosePromise) this.serverClaim.settle({ ok: true })
		if (!this.overflow) this.overflowClaim.settle({ ok: true })
		const removeOwned = async (
			path: string,
			identity: { dev: number; ino: number } | undefined,
			directory: boolean,
		): Promise<CleanupOutcome> => {
			if (!path) return { ok: true }
			try {
				let stat
				try {
					stat = await lstat(path)
				} catch (error: unknown) {
					if (
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					)
						return { ok: true }
					throw error
				}
				if (!identity)
					return {
						ok: false,
						state: "unknown",
						detail: "unknown settlement pathname ownership",
					}
				if (
					stat.dev !== identity.dev ||
					stat.ino !== identity.ino ||
					stat.isSymbolicLink()
				)
					return {
						ok: false,
						state: "unknown",
						detail: "settlement pathname identity changed",
					}
				if (directory) await rmdir(path)
				else await unlink(path)
				return { ok: true }
			} catch {
				return {
					ok: false,
					state: "failed",
					detail: "settlement pathname cleanup failed",
				}
			}
		}
		const pathOutcomes = async (): Promise<readonly CleanupOutcome[]> => {
			const endpoint = await removeOwned(
				this.path,
				this.endpointIdentity,
				false,
			)
			this.endpointClaim.settle(endpoint)
			const sub = await removeOwned(
				this.observerDirectory,
				this.observerIdentity,
				true,
			)
			const root = await removeOwned(
				this.directory,
				this.directoryIdentity,
				true,
			)
			this.directoryClaim.settle(!sub.ok ? sub : root)
			return [endpoint, sub, root]
		}
		// Initiate both independent owners before awaiting either actual outcome.
		const results = await Promise.allSettled([
			serverOutcome.then(outcome => [outcome]),
			pathOutcomes(),
		])
		for (const result of results) {
			if (result.status === "fulfilled") outcomes.push(...result.value)
			else
				outcomes.push({
					ok: false,
					state: "failed",
					detail: "settlement local cleanup failed",
				})
		}
		return outcomes
	}
}

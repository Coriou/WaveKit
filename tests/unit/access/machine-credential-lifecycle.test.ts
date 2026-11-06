import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerAccessRoutes } from "../../../src/access/access-routes.js"
import { resolveAccessBootstrap } from "../../../src/access/bootstrap-policy.js"
import { runAccessCommand } from "../../../src/access/command.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { installAccessHooks } from "../../../src/access/fastify-adapter.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import {
	ACCESS_CREDENTIAL_MISMATCH,
	PrivateAccessStorage,
} from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import { SessionStore } from "../../../src/access/sessions.js"
import { setupLocalAccess } from "../../../src/access/setup.js"
import { WaveKitError } from "../../../src/utils/errors.js"

const ownership = "single-host-pid-namespace" as const
const host = "receiver.lan:9000"
const origin = "https://receiver.lan:9000"
const resolvedBootstrap = resolveAccessBootstrap({
	mode: "protected",
	listenerScheme: "https",
	allowedAuthorities: [host],
	allowedOrigins: [origin],
	externalAudioOrigins: [
		"https://receiver.lan:9001",
		"https://receiver.lan:9002",
	],
})
if (resolvedBootstrap.mode !== "protected")
	throw new Error("Invalid test bootstrap")
const bootstrap = resolvedBootstrap

let root: string
let directory: string
let out: string
const running: { close: () => Promise<void> }[] = []

beforeEach(async () => {
	root = await fs.mkdtemp(join(tmpdir(), "wavekit-machine-lifecycle-"))
	await fs.chmod(root, 0o700)
	directory = join(root, "private")
	const outDir = join(root, "agent")
	await fs.mkdir(outDir, { mode: 0o700 })
	await fs.chmod(outDir, 0o700)
	out = join(outDir, "machine-token")
	expect((await setupLocalAccess({ directory, ownership })).kind).toBe("ready")
})

afterEach(async () => {
	vi.restoreAllMocks()
	for (const core of running.splice(0))
		await core.close().catch(() => undefined)
	vi.useRealTimers()
	await fs.rm(root, { recursive: true, force: true })
})

/** The production composition: runtime context, root hook, access routes, one protected route. */
async function startCore() {
	const runtime = await openAccessRuntime({
		bootstrap,
		audio: {
			analog: {
				listenerScheme: "https",
				allowedAuthorities: ["receiver.lan:9001"],
			},
			digital: {
				listenerScheme: "https",
				allowedAuthorities: ["receiver.lan:9002"],
			},
		},
		directory,
		ownership,
	})
	const app = Fastify({ logger: false })
	installAccessHooks(app, runtime.api)
	registerAccessRoutes(app, runtime.services)
	app.get("/api/agent/status", async () => ({ ok: true }))
	app.get("/health", async () => ({ ok: true }))
	await app.ready()
	let closing: Promise<void> | undefined
	const core = {
		app,
		runtime,
		close: () => {
			closing ??= app.close().then(() => runtime.close())
			return closing
		},
		/** A protected read with this bearer credential. */
		bearer: async (token: string) =>
			(
				await app.inject({
					method: "GET",
					url: "/api/agent/status",
					headers: { host, authorization: `Bearer ${token}` },
				})
			).statusCode,
		cookie: async (cookie: string) =>
			(
				await app.inject({
					method: "GET",
					url: "/api/agent/status",
					headers: { host, origin, cookie },
				})
			).statusCode,
		/** Pairs a browser through the real routes and returns its session cookie. */
		pair: async (token: string) => {
			const issued = await app.inject({
				method: "POST",
				url: "/api/access/pairing-codes",
				headers: { host, authorization: `Bearer ${token}` },
			})
			expect(issued.statusCode).toBe(201)
			const redeemed = await app.inject({
				method: "POST",
				url: "/api/access/pair",
				headers: { host, origin },
				payload: { code: issued.json<{ code: string }>().code },
			})
			expect(redeemed.statusCode).toBe(201)
			const header = redeemed.headers["set-cookie"]
			if (typeof header !== "string") throw new Error("Expected a cookie")
			return header.split(";")[0] ?? ""
		},
	}
	running.push(core)
	return core
}

function exportToken(extra: string[] = []) {
	return runAccessCommand([
		"machine-token",
		"--private-directory",
		directory,
		"--out",
		out,
		...extra,
	])
}

function rotate(extra: string[] = []) {
	return runAccessCommand([
		"rotate-credential",
		"--private-directory",
		directory,
		...extra,
	])
}

const statePath = () => join(directory, "access-state.json")
const fencePath = () => join(directory, "credential-fence.json")

async function storedToken(): Promise<string> {
	const state = JSON.parse(await fs.readFile(statePath(), "utf8")) as {
		machineToken: string
	}
	return state.machineToken
}

/** Fails like a process that died between the fence and the state write. */
function failNextStateRename() {
	const real = fs.rename.bind(fs)
	let armed = true
	return vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (armed && String(to) === statePath()) {
			armed = false
			throw new WaveKitError("injected", "INJECTED")
		}
		await real(from, to)
	})
}

/** A startup, an export and a --keep-sessions rotation all refuse with the code. */
async function expectRefusedUntilRotated(revoked: string) {
	await expect(startCore()).rejects.toMatchObject({
		code: ACCESS_CREDENTIAL_MISMATCH,
	})
	await expect(
		PrivateAccessStorage.readMachineCredential({ directory }, t => t),
	).rejects.toMatchObject({ code: ACCESS_CREDENTIAL_MISMATCH })
	const exported = await exportToken(["--replace"])
	expect(exported.exitCode).toBe(1)
	expect(exported.lines.join("\n")).toContain(ACCESS_CREDENTIAL_MISMATCH)
	expect(exported.lines.join("\n")).toContain("rotate-credential")
	expect(exported.lines.join("\n")).not.toContain(revoked)
	const before = await fs.readFile(statePath(), "utf8")
	const kept = await rotate(["--keep-sessions"])
	expect(kept.exitCode).toBe(1)
	expect(kept.lines.join("\n")).toContain(ACCESS_CREDENTIAL_MISMATCH)
	expect(kept.lines.join("\n")).toContain("did not change")
	expect(kept.lines.join("\n")).toContain("without --keep-sessions")
	expect(await fs.readFile(statePath(), "utf8")).toBe(before)
}

/** What a client does: read the file once and trim the newline. */
async function tokenFile(): Promise<string> {
	return (await fs.readFile(out, "utf8")).trim()
}

describe("machine credential lifecycle", () => {
	it("mints, survives restarts, refuses a live rotation, then rotates and re-exports", async () => {
		// Mint while the core runs: the export needs no stopped core and no exec.
		let core = await startCore()
		expect((await exportToken()).exitCode).toBe(0)
		expect((await fs.stat(out)).mode & 0o7777).toBe(0o600)
		const minted = await tokenFile()
		expect(await core.bearer(minted)).toBe(200)

		// A core restart reopens storage and rebuilds the policy: same token.
		await core.close()
		core = await startCore()
		expect(await core.bearer(minted)).toBe(200)

		// A live owner holds the directory: refused, nothing changes.
		const refused = await rotate()
		expect(refused.exitCode).toBe(1)
		expect(refused.lines.join("\n")).toContain("ACCESS_STORAGE_BUSY")
		expect(await core.bearer(minted)).toBe(200)
		expect(
			await PrivateAccessStorage.readMachineCredential({ directory }, t => t),
		).toBe(minted)

		// Stopped core: rotation revokes the exported copy after the next start.
		await core.close()
		const rotated = await rotate()
		expect(rotated.exitCode).toBe(0)
		expect(rotated.lines.join("\n")).not.toContain(minted)
		core = await startCore()
		expect(await core.bearer(minted)).toBe(401)
		expect(await tokenFile()).toBe(minted)
		expect(await core.bearer(await tokenFile())).toBe(401)

		// A plain export will not overwrite; --replace refreshes the same file.
		const exists = await exportToken()
		expect(exists.exitCode).toBe(1)
		expect(exists.lines.join("\n")).toContain("ACCESS_TOKEN_OUT_EXISTS")
		expect((await exportToken(["--replace"])).exitCode).toBe(0)
		const fresh = await tokenFile()
		expect(fresh).not.toBe(minted)
		expect(await core.bearer(fresh)).toBe(200)
		expect(await core.bearer(minted)).toBe(401)
		expect((await fs.stat(out)).mode & 0o7777).toBe(0o600)

		// The new token survives the next restart as the first one did.
		await core.close()
		core = await startCore()
		expect(await core.bearer(fresh)).toBe(200)
	})

	it("keeps paired browsers only with --keep-sessions", async () => {
		await exportToken()
		let core = await startCore()
		const browser = await core.pair(await tokenFile())
		expect(await core.cookie(browser)).toBe(200)
		await core.close()

		expect((await rotate(["--keep-sessions"])).exitCode).toBe(0)
		core = await startCore()
		expect(await core.cookie(browser)).toBe(200)
		expect(await core.bearer(await tokenFile())).toBe(401)
		await core.close()

		expect((await rotate()).exitCode).toBe(0)
		core = await startCore()
		expect(await core.cookie(browser)).toBe(401)
	})

	it("stops admitting anything once a stalled core's lock was reclaimed and the credential rotated", async () => {
		// Timers frozen as in a paused container: the core refreshes no heartbeat.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
		await exportToken()
		const stalled = await startCore()
		const minted = await tokenFile()
		const browser = await stalled.pair(minted)
		const lock = (await fs.readdir(directory)).find(entry =>
			entry.startsWith("owner-"),
		)
		if (!lock) throw new Error("Expected the core's owner file")
		const old = new Date(Date.now() - 120_000)
		await fs.utimes(join(directory, lock), old, old)

		// The rotator observes the unchanged heartbeat past its lease and reclaims.
		let clock = 0
		const rotator = await PrivateAccessStorage.open({
			directory,
			mode: "load",
			ownership,
			lockWait: {
				now: () => clock,
				sleep: async ms => {
					clock += ms
				},
			},
		})
		await rotator.rotateMachineCredential()
		await rotator.close()

		// The core resumes: its next heartbeat finds the lock gone.
		vi.advanceTimersByTime(10_000)
		const statuses = new Set<number>()
		for (let attempt = 0; attempt < 200; attempt++) {
			const status = await stalled.bearer(minted)
			statuses.add(status)
			if (status === 503) break
			await new Promise(resolve => setTimeout(resolve, 5))
		}
		expect([...statuses].at(-1)).toBe(503)
		expect(await stalled.bearer(minted)).toBe(503)
		expect(await stalled.cookie(browser)).toBe(503)
		expect(
			stalled.runtime.analogAudio.policy.evaluate({
				method: "GET",
				rawTarget: "/stream",
				rawHeaders: [
					"Host",
					"receiver.lan:9001",
					"Authorization",
					`Bearer ${minted}`,
				],
				transport: "http",
				surface: "audio",
				remoteAddress: "127.0.0.1",
			}),
		).toMatchObject({ kind: "deny", status: 503, code: "ACCESS_UNAVAILABLE" })
		// The public liveness probe still answers: the process is up, access is not.
		const health = await stalled.app.inject({
			method: "GET",
			url: "/health",
			headers: { host },
		})
		expect(health.statusCode).toBe(200)
		await stalled.close()
		vi.useRealTimers()

		const restarted = await startCore()
		expect(await restarted.bearer(minted)).toBe(401)
		expect((await exportToken(["--replace"])).exitCode).toBe(0)
		expect(await restarted.bearer(await tokenFile())).toBe(200)
	})

	it("never restores a revoked credential when a paused owner's write lands after a rotation", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
		await exportToken()
		const stale = await startCore()
		const minted = await tokenFile()
		const browser = await stale.pair(minted)
		const issued = await stale.app.inject({
			method: "POST",
			url: "/api/access/pairing-codes",
			headers: { host, authorization: `Bearer ${minted}` },
		})

		// The owner passes its heartbeat check, then stops just before its rename.
		const real = fs.rename.bind(fs)
		let reached!: () => void
		let release!: () => void
		const paused = new Promise<void>(resolve => {
			reached = resolve
		})
		const resume = new Promise<void>(resolve => {
			release = resolve
		})
		let armed = true
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (armed && String(to) === statePath()) {
				armed = false
				reached()
				await resume
			}
			await real(from, to)
		})
		const pendingWrite = stale.app.inject({
			method: "POST",
			url: "/api/access/pair",
			headers: { host, origin },
			payload: { code: issued.json<{ code: string }>().code },
		})
		await paused

		// Its lock expires; another process reclaims it and rotates successfully.
		const lock = (await fs.readdir(directory)).find(entry =>
			entry.startsWith("owner-"),
		)
		if (!lock) throw new Error("Expected the core's owner file")
		const old = new Date(Date.now() - 120_000)
		await fs.utimes(join(directory, lock), old, old)
		let clock = 0
		const rotator = await PrivateAccessStorage.open({
			directory,
			mode: "load",
			ownership,
			lockWait: {
				now: () => clock,
				sleep: async ms => {
					clock += ms
				},
			},
		})
		await rotator.rotateMachineCredential()
		const replacement = rotator.useMachineCredential(t => t)
		await rotator.close()

		// The old owner resumes with ownership already lost: the rename still lands.
		vi.advanceTimersByTime(10_000)
		for (let attempt = 0; attempt < 200; attempt++) {
			if ((await stale.bearer(minted)) === 503) break
			await new Promise(resolve => setTimeout(resolve, 5))
		}
		expect(await stale.bearer(minted)).toBe(503)
		release()
		await pendingWrite
		expect(await storedToken()).toBe(minted)
		await stale.close()
		vi.useRealTimers()

		// A restart refuses rather than admit the revoked token.
		await expectRefusedUntilRotated(minted)

		// Rotating again recovers; the browser the stale write carried stays out.
		const recovered = await rotate()
		expect(recovered.exitCode).toBe(0)
		expect(recovered.lines.join("\n")).toContain("sessions were removed")
		expect((await exportToken(["--replace"])).exitCode).toBe(0)
		const fresh = await tokenFile()
		const core = await startCore()
		expect(await core.bearer(fresh)).toBe(200)
		expect(await core.bearer(minted)).toBe(401)
		expect(await core.bearer(replacement)).toBe(401)
		expect(await core.cookie(browser)).toBe(401)
	})

	it("fails closed after a crash between the fence and the state write, then recovers by rotating", async () => {
		await exportToken()
		const minted = await tokenFile()
		const spy = failNextStateRename()
		const crashed = await rotate()
		spy.mockRestore()
		expect(crashed.exitCode).toBe(1)
		expect(crashed.lines.join("\n")).toContain("may have been replaced")
		expect(await storedToken()).toBe(minted)
		await expectRefusedUntilRotated(minted)

		expect((await rotate()).exitCode).toBe(0)
		expect((await exportToken(["--replace"])).exitCode).toBe(0)
		const fresh = await tokenFile()
		expect(fresh).not.toBe(minted)
		const core = await startCore()
		expect(await core.bearer(fresh)).toBe(200)
		expect(await core.bearer(minted)).toBe(401)
	})

	it("loads a directory that never rotated, without creating a fence", async () => {
		await exportToken()
		const minted = await tokenFile()
		const core = await startCore()
		const browser = await core.pair(minted)
		await core.close()
		const restarted = await startCore()
		expect(await restarted.bearer(minted)).toBe(200)
		expect(await restarted.cookie(browser)).toBe(200)
		await expect(fs.lstat(fencePath())).rejects.toMatchObject({
			code: "ENOENT",
		})
	})

	it.each([
		["not JSON", "not json"],
		["empty", ""],
		["a missing binding", JSON.stringify({ version: 1 })],
		[
			"another version",
			JSON.stringify({ version: 2, credentialBinding: "a".repeat(64) }),
		],
		[
			"an extra field",
			JSON.stringify({
				version: 1,
				credentialBinding: "a".repeat(64),
				token: "x",
			}),
		],
		[
			"a binding that is not a hash",
			JSON.stringify({ version: 1, credentialBinding: "A".repeat(64) }),
		],
	])(
		"refuses a fence holding %s until rotation replaces it",
		async (_, text) => {
			await exportToken()
			const minted = await tokenFile()
			await fs.writeFile(fencePath(), text, { mode: 0o600 })
			await expectRefusedUntilRotated(minted)
			expect((await rotate()).exitCode).toBe(0)
			expect((await exportToken(["--replace"])).exitCode).toBe(0)
			const core = await startCore()
			expect(await core.bearer(await tokenFile())).toBe(200)
			expect(await core.bearer(minted)).toBe(401)
		},
	)

	it("refuses a fence that is not a private regular file, even for rotation", async () => {
		await exportToken()
		await fs.writeFile(fencePath(), "{}", { mode: 0o644 })
		await fs.chmod(fencePath(), 0o644)
		await expect(startCore()).rejects.toMatchObject({
			code: "ACCESS_STORAGE_UNSAFE",
		})
		const refused = await rotate()
		expect(refused.exitCode).toBe(1)
		expect(refused.lines.join("\n")).toContain("ACCESS_STORAGE_UNSAFE")
		expect(refused.lines.join("\n")).toContain("did not change")
	})

	it("keeps loading after ordinary writes by the owner that rotated", async () => {
		await exportToken()
		expect((await rotate()).exitCode).toBe(0)
		expect((await fs.lstat(fencePath())).mode & 0o7777).toBe(0o600)
		expect((await exportToken(["--replace"])).exitCode).toBe(0)
		const token = await tokenFile()
		const core = await startCore()
		const browser = await core.pair(token)
		await core.close()
		const restarted = await startCore()
		expect(await restarted.bearer(token)).toBe(200)
		expect(await restarted.cookie(browser)).toBe(200)
	})

	it("a running owner keeps its own credential when a stale write lands, and its next write repairs the disk", async () => {
		await exportToken()
		const minted = await tokenFile()
		const staleState = await fs.readFile(statePath(), "utf8")
		expect((await rotate()).exitCode).toBe(0)
		const current = await PrivateAccessStorage.readMachineCredential(
			{ directory },
			t => t,
		)
		const core = await startCore()
		await fs.writeFile(statePath(), staleState)

		expect(await core.bearer(current)).toBe(200)
		expect(await core.bearer(minted)).toBe(401)
		const exported = await exportToken(["--replace"])
		expect(exported.lines.join("\n")).toContain(ACCESS_CREDENTIAL_MISMATCH)

		await core.pair(current)
		expect(await storedToken()).toBe(current)
		expect((await exportToken(["--replace"])).exitCode).toBe(0)
		expect(await tokenFile()).toBe(current)
	})

	it("tells setup to rotate rather than provision over a mismatch", async () => {
		await exportToken()
		const minted = await tokenFile()
		const spy = failNextStateRename()
		await rotate()
		spy.mockRestore()
		const result = await runAccessCommand([
			"setup",
			"--private-directory",
			directory,
			"--ownership",
			ownership,
			"--api-origin",
			origin,
			"--allow-origin",
			origin,
		])
		expect(result.exitCode).toBe(1)
		expect(result.lines.join("\n")).toContain(ACCESS_CREDENTIAL_MISMATCH)
		expect(result.lines.join("\n")).toContain("rotate-credential")
		expect(await storedToken()).toBe(minted)
	})

	it("does not claim nothing changed when rotation fails after the new state landed", async () => {
		await exportToken()
		const minted = await tokenFile()
		const probe = await fs.open(root, "r")
		const handlePrototype = Object.getPrototypeOf(probe) as {
			sync(this: { stat(): Promise<{ isDirectory(): boolean }> }): Promise<void>
		}
		await probe.close()
		const realSync = handlePrototype.sync
		let directorySyncs = 0
		const spy = vi
			.spyOn(handlePrototype, "sync")
			.mockImplementation(async function (this: {
				stat(): Promise<{ isDirectory(): boolean }>
			}) {
				// Directory fsyncs follow each rename: the fence's, then the state's.
				if ((await this.stat()).isDirectory() && ++directorySyncs === 2)
					throw new WaveKitError("injected", "INJECTED")
				return realSync.call(this)
			})
		const result = await rotate()
		spy.mockRestore()
		expect(result.exitCode).toBe(1)
		const text = result.lines.join("\n")
		expect(text).not.toContain("did not change")
		expect(text).toContain("may have been replaced")
		expect(text).not.toContain(minted)

		// The disk really moved, so the message above had to say so.
		const stored = await PrivateAccessStorage.readMachineCredential(
			{ directory },
			t => t,
		)
		expect(stored).not.toBe(minted)
		const core = await startCore()
		expect(await core.bearer(stored)).toBe(200)
		expect(await core.bearer(minted)).toBe(401)
	})

	it("rejects a credential authority check that is not a function", async () => {
		const token = generateMachineToken()
		const digest = digestMachineToken(token)
		const sessions = await SessionStore.open({
			credentialBinding: sessionCredentialBinding(digest),
			persist: async () => {},
		})
		const options = {
			listenerScheme: "https" as const,
			allowedAuthorities: [host],
			allowedOrigins: [origin],
			sessionCookieName: "wavekit_session",
			machineSecretDigest: digest,
			sessions,
		}
		expect(() => new AccessPolicy(options)).not.toThrow()
		expect(
			() =>
				new AccessPolicy({
					...options,
					credentialAuthorityLost: false as unknown as () => boolean,
				}),
		).toThrow(WaveKitError)
	})

	it("says rotation changed nothing when it never reached the credential", async () => {
		await fs.chmod(directory, 0o755)
		const loose = await rotate()
		expect(loose.exitCode).toBe(1)
		expect(loose.lines.join("\n")).toContain("ACCESS_STORAGE_UNSAFE")
		expect(loose.lines.join("\n")).toContain("did not change")
		await fs.chmod(directory, 0o700)
	})

	it("tells the operator to stop a core that runs in another PID namespace", async () => {
		vi.spyOn(PrivateAccessStorage, "open").mockRejectedValueOnce(
			new WaveKitError("held", "ACCESS_STORAGE_FOREIGN_OWNER"),
		)
		const result = await rotate()
		expect(result.exitCode).toBe(1)
		expect(result.lines).toEqual([
			"ACCESS_STORAGE_FOREIGN_OWNER: Stop the core and retry credential rotation.",
		])
	})
})

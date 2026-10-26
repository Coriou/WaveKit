import fs from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LockOwner } from "../../../src/utils/lock-owner.js"
import {
	bootTime,
	LOCK_WAIT_MS,
	HEARTBEAT_MS,
} from "../../../src/utils/lock-owner.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { SessionStore } from "../../../src/access/sessions.js"
import {
	generateMachineToken,
	verifyMachineToken,
} from "../../../src/access/credentials.js"

const roots: string[] = []
const owners: PrivateAccessStorage[] = []
const ownership = "single-host-pid-namespace" as const

afterEach(async () => {
	vi.restoreAllMocks()
	for (const storage of owners.splice(0))
		await storage.close().catch(() => undefined)
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true })
})

async function location() {
	const root = await fs.mkdtemp(join(tmpdir(), "wavekit-private-access-"))
	roots.push(root)
	return { root, directory: join(root, "private") }
}

async function open(
	directory: string,
	mode: "load" | "provision" = "provision",
) {
	const storage = await PrivateAccessStorage.open({
		directory,
		mode,
		ownership,
	})
	owners.push(storage)
	return storage
}

describe("private single-operator persistence", () => {
	it("reads the validated machine credential while a writer is live without writing or inspecting ownership", async () => {
		const { directory } = await location()
		const writer = await open(directory)
		const digest = writer.machineSecretDigest()
		const entries = await fs.readdir(directory)
		const before = await Promise.all(
			entries.map(async entry => ({
				entry,
				content: await fs.readFile(join(directory, entry), "utf8"),
				stat: await fs.stat(join(directory, entry)),
			})),
		)
		const mkdir = vi.spyOn(fs, "mkdir")
		const write = vi.spyOn(fs, "writeFile")
		const unlink = vi.spyOn(fs, "unlink")
		const rename = vi.spyOn(fs, "rename")
		const kill = vi.spyOn(process, "kill")
		const fileOpen = vi.spyOn(fs, "open")
		expect(
			await PrivateAccessStorage.readMachineCredential({ directory }, token =>
				verifyMachineToken(token, digest),
			),
		).toBe(true)
		for (const spy of [mkdir, write, unlink, rename, kill])
			expect(spy).not.toHaveBeenCalled()
		for (const [, flags] of fileOpen.mock.calls) {
			expect(typeof flags).toBe("number")
			expect(
				Number(flags) &
					(constants.O_WRONLY |
						constants.O_RDWR |
						constants.O_CREAT |
						constants.O_TRUNC),
			).toBe(0)
		}
		expect(await fs.readdir(directory)).toEqual(entries)
		for (const previous of before) {
			expect(await fs.readFile(join(directory, previous.entry), "utf8")).toBe(
				previous.content,
			)
			const current = await fs.stat(join(directory, previous.entry))
			expect(current.ino).toBe(previous.stat.ino)
			expect(current.mtimeMs).toBe(previous.stat.mtimeMs)
			expect(current.mode).toBe(previous.stat.mode)
		}
	})

	it("readonly reads never provision a missing directory and sanitize invalid options", async () => {
		const { root, directory } = await location()
		const mkdir = vi.spyOn(fs, "mkdir")
		await expect(
			PrivateAccessStorage.readMachineCredential({ directory }, () => "unused"),
		).rejects.toMatchObject({
			code: "ACCESS_CREDENTIAL_UNAVAILABLE",
			cause: undefined,
		})
		await expect(
			PrivateAccessStorage.readMachineCredential(
				{ directory: "private-secret" },
				() => "unused",
			),
		).rejects.toMatchObject({
			code: "ACCESS_CREDENTIAL_UNAVAILABLE",
			cause: undefined,
		})
		expect(mkdir).not.toHaveBeenCalled()
		expect(await fs.readdir(root)).toEqual([])
	})

	it("closes the readonly directory before callback execution, and sanitizes callback failure", async () => {
		const { directory } = await location()
		const writer = await open(directory)
		const originalOpen = fs.open
		let closed = false
		vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
			const handle = await originalOpen(path, flags, mode)
			if (path === directory) {
				const close = handle.close.bind(handle)
				vi.spyOn(handle, "close").mockImplementation(async () => {
					closed = true
					await close()
				})
			}
			return handle
		})
		const token = writer.useMachineCredential(value => value)
		await expect(
			PrivateAccessStorage.readMachineCredential({ directory }, () => {
				expect(closed).toBe(true)
				throw new Error(`${token} ${directory}`)
			}),
		).rejects.toMatchObject({
			message: "Private access storage unavailable",
			code: "ACCESS_CREDENTIAL_UNAVAILABLE",
			cause: undefined,
		})
		expect(closed).toBe(true)
	})

	it("rechecks the directory after load before handing credentials to a consumer", async () => {
		const { directory } = await location()
		const writer = await open(directory)
		await writer.close()
		const originalOpen = fs.open
		vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
			const handle = await originalOpen(path, flags, mode)
			if (path === join(directory, "access-state.json")) {
				await fs.rename(directory, `${directory}.old`)
				await fs.mkdir(directory, { mode: 0o700 })
			}
			return handle
		})
		const consumer = vi.fn()
		await expect(
			PrivateAccessStorage.readMachineCredential({ directory }, consumer),
		).rejects.toMatchObject({ code: "ACCESS_CREDENTIAL_UNAVAILABLE" })
		expect(consumer).not.toHaveBeenCalled()
	})

	it.each([
		"directory",
		"state",
		"marker",
		"hardlink",
		"mode",
		"oversized",
		"corrupt",
	] as const)(
		"readonly reads refuse unsafe %s without repair or owner-file changes",
		async kind => {
			const { root, directory } = await location()
			const writer = await open(directory)
			await writer.close()
			const untouched = join(root, "untouched")
			await fs.writeFile(untouched, "unchanged", { mode: 0o600 })
			if (kind === "directory") {
				await fs.rename(directory, `${directory}.real`)
				await fs.symlink(`${directory}.real`, directory)
			} else if (["state", "marker", "hardlink"].includes(kind)) {
				const selected = join(
					directory,
					kind === "marker" ? "initialized" : "access-state.json",
				)
				await fs.unlink(selected)
				if (kind === "hardlink") await fs.link(untouched, selected)
				else await fs.symlink(untouched, selected)
			} else if (kind === "mode")
				await fs.chmod(join(directory, "access-state.json"), 0o644)
			else
				await fs.writeFile(
					join(directory, "access-state.json"),
					kind === "oversized" ? "s".repeat(65537) : "private-corrupt-secret",
				)
			const entries = await fs.readdir(directory)
			const mkdir = vi.spyOn(fs, "mkdir")
			const write = vi.spyOn(fs, "writeFile")
			const unlink = vi.spyOn(fs, "unlink")
			await expect(
				PrivateAccessStorage.readMachineCredential(
					{ directory },
					() => "unused",
				),
			).rejects.toMatchObject({
				code: "ACCESS_CREDENTIAL_UNAVAILABLE",
				cause: undefined,
			})
			for (const spy of [mkdir, write, unlink])
				expect(spy).not.toHaveBeenCalled()
			expect(await fs.readdir(directory)).toEqual(entries)
			expect(await fs.readFile(untouched, "utf8")).toBe("unchanged")
		},
	)

	it("provisions once with private permissions and restores remembered browsers across process ownership lifetimes", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		expect(storage.created).toBe(true)
		expect((await fs.stat(directory)).mode & 0o7777).toBe(0o700)
		for (const entry of await fs.readdir(directory))
			expect((await fs.stat(join(directory, entry))).mode & 0o7777).toBe(0o600)
		const digest = storage.machineSecretDigest()
		expect(
			storage.useMachineCredential(token => verifyMachineToken(token, digest)),
		).toBe(true)
		expect(JSON.stringify(storage)).toBe("{}")
		const sessions = await SessionStore.open({
			credentialBinding: storage.credentialBinding,
			snapshot: storage.startupSnapshot(),
			persist: storage.persist,
		})
		const browser = await sessions.create()
		if (browser.kind !== "created") throw new Error("Expected browser")
		await storage.close()
		const restarted = await open(directory, "load")
		expect(restarted.created).toBe(false)
		expect(restarted.machineSecretDigest()).toEqual(digest)
		const restored = await SessionStore.open({
			credentialBinding: restarted.credentialBinding,
			snapshot: restarted.startupSnapshot(),
			persist: restarted.persist,
		})
		expect(restored.lookup(browser.cookieValue)).toMatchObject({
			principalId: browser.principalId,
		})
		const clone = restarted.startupSnapshot()
		clone.sessions.length = 0
		expect(restarted.startupSnapshot().sessions).toHaveLength(1)
		expect(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		).not.toContain(browser.cookieValue)
	})

	it("does not issue credentials in load mode or silently repair deleted prior setup state", async () => {
		const { root, directory } = await location()
		const mkdir = vi.spyOn(fs, "mkdir")
		await expect(open(directory, "load")).rejects.toMatchObject({
			code: "ACCESS_STORAGE_MISSING",
		})
		expect(mkdir).not.toHaveBeenCalled()
		expect(await fs.readdir(root)).toEqual([])
		mkdir.mockRestore()
		const storage = await open(directory)
		await storage.close()
		await fs.unlink(join(directory, "access-state.json"))
		await expect(open(directory)).rejects.toMatchObject({
			code: "ACCESS_STORAGE_INCOMPLETE",
		})
		expect(await fs.readdir(directory)).toEqual(["initialized"])
	})

	it("refuses concurrent owners, including its own PID, and serializes concurrent session writes", async () => {
		const { directory } = await location()
		// Initialization has its own tests; this fixture isolates writer ownership.
		await (await open(directory)).close()
		const results = await Promise.allSettled([
			open(directory, "load"),
			open(directory, "load"),
		])
		expect(
			results.filter(result => result.status === "fulfilled").length,
		).toBeLessThanOrEqual(1)
		for (const result of results)
			if (result.status === "rejected")
				expect(result.reason).toMatchObject({ code: "ACCESS_STORAGE_BUSY" })
		const first = results.find(result => result.status === "fulfilled")
		const storage =
			first?.status === "fulfilled" ? first.value : await open(directory)
		await expect(open(directory, "load")).rejects.toMatchObject({
			code: "ACCESS_STORAGE_BUSY",
		})
		const store = await SessionStore.open({
			credentialBinding: storage.credentialBinding,
			persist: storage.persist,
			snapshot: storage.startupSnapshot(),
		})
		const created = await Promise.all([
			store.create(),
			store.create(),
			store.create(),
		])
		expect(created.every(result => result.kind === "created")).toBe(true)
		await storage.close()
		expect(
			(await open(directory, "load")).startupSnapshot().sessions,
		).toHaveLength(3)
	})

	it("concurrent first-use provisioning never acknowledges duplicate credentials or silently repairs both failed attempts", async () => {
		const { directory } = await location()
		const results = await Promise.allSettled([open(directory), open(directory)])
		expect(
			results.filter(result => result.status === "fulfilled"),
		).toHaveLength(
			results.some(result => result.status === "fulfilled") ? 1 : 0,
		)
		for (const result of results) {
			if (result.status === "rejected")
				expect(result.reason).toMatchObject({
					code: expect.stringMatching(/^ACCESS_STORAGE_(BUSY|INCOMPLETE)$/),
				})
		}
		const winner = results.find(result => result.status === "fulfilled")
		if (!winner || winner.status !== "fulfilled") {
			// Both refusals are reported as refusals: do not provision a fallback
			// here or turn a partially initialized result into a success assertion.
			expect(await fs.readdir(directory)).toEqual([])
			await expect(
				PrivateAccessStorage.readMachineCredential(
					{ directory },
					() => "unused",
				),
			).rejects.toMatchObject({ code: "ACCESS_CREDENTIAL_UNAVAILABLE" })
			return
		}
		const digest = winner.value.machineSecretDigest()
		const before = await fs.readFile(
			join(directory, "access-state.json"),
			"utf8",
		)
		await winner.value.close()
		const restored = await open(directory, "load")
		expect(restored.machineSecretDigest()).toEqual(digest)
		expect(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		).toBe(before)
		expect(
			(await fs.readdir(directory)).filter(
				entry => entry === "access-state.json",
			),
		).toHaveLength(1)
	})

	it("recovers only validated dead unique owners in its own scope", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		const ownerPath = (await fs.readdir(directory)).find(entry =>
			entry.startsWith("owner-"),
		)!
		const owner = JSON.parse(
			await fs.readFile(join(directory, ownerPath), "utf8"),
		) as { pid: number; nonce: string; scope: string; version: number }
		await storage.close()
		delete (owner as { identity?: unknown }).identity
		const deadName = `owner-99999999-${owner.nonce}.lock`
		await fs.writeFile(
			join(directory, deadName),
			JSON.stringify({ ...owner, pid: 99999999 }),
			{ mode: 0o600 },
		)
		const recovered = await open(directory, "load")
		expect((await fs.readdir(directory)).includes(deadName)).toBe(false)
		await recovered.close()
		await fs.writeFile(
			join(directory, deadName),
			JSON.stringify({ ...owner, pid: 99999999, scope: "a".repeat(64) }),
			{ mode: 0o600 },
		)
		let clock = Date.now()
		await expect(
			PrivateAccessStorage.open({
				directory,
				mode: "load",
				ownership,
				lockWait: {
					now: () => clock,
					sleep: async ms => {
						clock += ms
						await fs.utimes(
							join(directory, deadName),
							new Date(clock),
							new Date(clock),
						)
					},
				},
			}),
		).rejects.toMatchObject({ code: "ACCESS_STORAGE_FOREIGN_OWNER" })
		expect((await fs.readdir(directory)).includes(deadName)).toBe(true)
	})

	it("holds a fresh legacy owner without borrowing the contender's start time", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		const name = (await fs.readdir(directory)).find(entry =>
			entry.startsWith("owner-"),
		)!
		const record = JSON.parse(
			await fs.readFile(join(directory, name), "utf8"),
		) as { identity?: LockOwner; pid: number; nonce: string }
		await storage.close()
		delete record.identity
		record.pid = 99999999
		const legacyName = `owner-${record.pid}-${record.nonce}.lock`
		await fs.writeFile(join(directory, legacyName), JSON.stringify(record), {
			mode: 0o600,
		})
		vi.spyOn(process, "kill").mockReturnValue(true)
		const readFile = fs.readFile
		vi.spyOn(fs, "readFile").mockImplementation((path, options) =>
			path === `/proc/${record.pid}/stat`
				? Promise.resolve(
						`99999999 (legacy) ${["S", ...Array<string>(18).fill("0"), "1"].join(" ")}`,
					)
				: readFile(path, options),
		)
		await expect(open(directory, "load")).rejects.toMatchObject({
			code: "ACCESS_STORAGE_BUSY",
		})
		expect(await fs.readdir(directory)).toContain(legacyName)
	})
	it.each([false, true])(
		"handles a foreign container heartbeat, continued refresh=%s",
		async refresh => {
			const { directory } = await location()
			const storage = await open(directory)
			const name = (await fs.readdir(directory)).find(entry =>
				entry.startsWith("owner-"),
			)!
			const path = join(directory, name)
			const record = JSON.parse(await fs.readFile(path, "utf8")) as {
				scope: string
				identity: LockOwner
			}
			await storage.close()
			record.scope = "a".repeat(64)
			record.identity.hostname = "other-container"
			record.identity.pidNamespace = "other-namespace"
			await fs.writeFile(path, JSON.stringify(record), { mode: 0o600 })
			let clock = Date.now()
			const started = clock
			await fs.utimes(path, new Date(clock), new Date(clock))
			const result = PrivateAccessStorage.open({
				directory,
				mode: "load",
				ownership,
				lockWait: {
					now: () => clock,
					sleep: async ms => {
						clock += ms
						if (refresh) await fs.utimes(path, new Date(clock), new Date(clock))
					},
				},
			})
			if (refresh) {
				await expect(result).rejects.toMatchObject({
					code: "ACCESS_STORAGE_FOREIGN_OWNER",
				})
				expect(await fs.readdir(directory)).toContain(name)
			} else {
				const recovered = await result
				expect(await fs.readdir(directory)).not.toContain(name)
				await recovered.close()
			}
			expect(clock - started).toBe(LOCK_WAIT_MS)
		},
	)

	it("refreshes the access owner mtime and stops on close", async () => {
		const { directory } = await location()
		vi.useFakeTimers()
		try {
			const storage = await open(directory)
			const name = (await fs.readdir(directory)).find(entry =>
				entry.startsWith("owner-"),
			)!
			const path = join(directory, name)
			await fs.utimes(path, new Date(0), new Date(0))
			await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
			let refreshed = 0
			const lstat = fs.lstat
			vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
				const stat = await lstat(...args)
				if (args[0] === path) refreshed = Number(stat.mtimeMs)
				return stat
			})
			await storage.close()
			expect(refreshed).toBe(Date.now())
			await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
			expect(await fs.readdir(directory)).not.toContain(name)
		} finally {
			vi.useRealTimers()
		}
	})

	it.each(["legacy-before-boot", "different-boot", "different-start"])(
		"recovers a reused live PID: %s",
		async kind => {
			const readFile = fs.readFile
			vi.spyOn(fs, "readFile").mockImplementation((path, options) =>
				path === "/proc/sys/kernel/random/boot_id"
					? Promise.resolve("11111111-1111-4111-8111-111111111111")
					: readFile(path, options),
			)
			const { directory } = await location()
			const storage = await open(directory)
			const name = (await fs.readdir(directory)).find(entry =>
				entry.startsWith("owner-"),
			)!
			const path = join(directory, name)
			const record = JSON.parse(await fs.readFile(path, "utf8")) as {
				scope?: string
				identity?: { bootId: { value: string }; startTime: { value: string } }
			}
			await storage.close()
			if (kind === "legacy-before-boot") delete record.identity
			else if (kind === "different-boot")
				record.identity!.bootId.value = "22222222-2222-4222-8222-222222222222"
			else record.identity!.startTime.value = "0"
			if (kind !== "different-start") record.scope = "a".repeat(64)
			await fs.writeFile(path, JSON.stringify(record), { mode: 0o600 })
			if (kind === "legacy-before-boot") {
				const old = new Date(bootTime() - 1000)
				await fs.utimes(path, old, old)
			}
			await open(directory, "load")
			expect(await fs.readdir(directory)).not.toContain(name)
		},
	)

	it("leaves a durable incomplete-setup marker if credential creation fails before rename", async () => {
		const { directory } = await location()
		const rename = fs.rename
		vi.spyOn(fs, "rename").mockImplementation((oldPath, newPath) => {
			if (newPath === join(directory, "access-state.json"))
				return Promise.reject(new Error("private-storage-failure"))
			return rename(oldPath, newPath)
		})
		await expect(open(directory)).rejects.toMatchObject({
			code: "ACCESS_STORAGE_UNAVAILABLE",
			cause: undefined,
		})
		vi.restoreAllMocks()
		expect(await fs.readdir(directory)).toEqual(["initialized"])
		await expect(open(directory)).rejects.toMatchObject({
			code: "ACCESS_STORAGE_INCOMPLETE",
		})
	})

	it("never treats EPERM or unknown liveness as permission to steal ownership", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("denied"), { code: "EPERM" })
		})
		await expect(open(directory, "load")).rejects.toMatchObject({
			code: "ACCESS_STORAGE_BUSY",
		})
		expect(
			(await fs.readdir(directory)).filter(entry => entry.startsWith("owner-")),
		).toHaveLength(1)
		await storage.close()
	})

	it.each(["directory", "state", "marker", "hardlink", "nonregular"] as const)(
		"rejects unsafe %s without altering its target",
		async kind => {
			const { root, directory } = await location()
			const storage = await open(directory)
			await storage.close()
			const other = join(root, "other")
			await fs.writeFile(other, "untouched", { mode: 0o600 })
			if (kind === "directory") {
				await fs.rename(directory, join(root, "real"))
				await fs.symlink(join(root, "real"), directory)
			} else {
				const target = join(
					directory,
					kind === "marker" ? "initialized" : "access-state.json",
				)
				await fs.unlink(target)
				if (kind === "hardlink") await fs.link(other, target)
				else if (kind === "nonregular") await fs.mkdir(target, { mode: 0o700 })
				else await fs.symlink(other, target)
			}
			await expect(open(directory, "load")).rejects.toMatchObject({
				code: "ACCESS_STORAGE_UNSAFE",
			})
			expect(await fs.readFile(other, "utf8")).toBe("untouched")
		},
	)

	it.each(["directory", "state", "marker"] as const)(
		"rejects permissive existing %s rather than chmod'ing it",
		async kind => {
			const { directory } = await location()
			const storage = await open(directory)
			await storage.close()
			const path =
				kind === "directory"
					? directory
					: join(
							directory,
							kind === "state" ? "access-state.json" : "initialized",
						)
			const mode = kind === "directory" ? 0o755 : 0o644
			await fs.chmod(path, mode)
			await expect(open(directory, "load")).rejects.toMatchObject({
				code: "ACCESS_STORAGE_UNSAFE",
			})
			expect((await fs.stat(path)).mode & 0o7777).toBe(mode)
		},
	)

	it("bounds existing input and rejects corrupt credential, binding and session records without leaking input", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		const state = JSON.parse(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		) as Record<string, unknown>
		await storage.close()
		for (const malformed of [
			"secret-corrupt-data",
			JSON.stringify({ ...state, machineToken: "private-malformed-token" }),
			JSON.stringify({ ...state, credentialBinding: "a".repeat(64) }),
			JSON.stringify({
				...state,
				sessions: {
					version: 1,
					credentialBinding: state["credentialBinding"],
					sessions: [{ deviceId: "bad" }],
				},
			}),
		]) {
			await fs.writeFile(join(directory, "access-state.json"), malformed)
			try {
				await open(directory, "load")
				expect.fail("Expected safe rejection")
			} catch (error) {
				expect(error).toMatchObject({
					code: "ACCESS_STORAGE_INVALID",
					cause: undefined,
				})
				expect(String(error)).not.toContain(malformed)
				expect(JSON.stringify(error)).not.toContain(directory)
			}
		}
		await fs.writeFile(join(directory, "access-state.json"), "x".repeat(65537))
		await expect(open(directory)).rejects.toMatchObject({
			code: "ACCESS_STORAGE_UNSAFE",
		})
	})

	it("atomically rotates machine credentials, removes remembered sessions, and rejects writes from an old session authority", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		const oldDigest = storage.machineSecretDigest()
		const old = await SessionStore.open({
			credentialBinding: storage.credentialBinding,
			persist: storage.persist,
		})
		const browser = await old.create()
		if (browser.kind !== "created") throw new Error("Expected browser")
		await storage.rotateMachineCredential()
		expect(storage.machineSecretDigest()).not.toEqual(oldDigest)
		expect(storage.startupSnapshot().sessions).toEqual([])
		expect(storage.startupSnapshot().credentialBinding).toBe(
			storage.credentialBinding,
		)
		expect(storage.startupSnapshot().credentialBinding).not.toBe(
			old.credentialBinding,
		)
		await expect(old.renew(browser.principalId)).rejects.toMatchObject({
			code: "ACCESS_UNAVAILABLE",
		})
		expect(storage.startupSnapshot().sessions).toEqual([])
		const digest = storage.machineSecretDigest()
		const mode = (await fs.stat(join(directory, "access-state.json"))).mode
		expect(mode & 0o777).toBe(0o600)
		await storage.close()
		const reloaded = await open(directory, "load")
		expect(reloaded.machineSecretDigest()).toEqual(digest)
		expect(reloaded.startupSnapshot().sessions).toEqual([])
	})

	it("rebinds remembered sessions when rotation keeps them, and still rejects the old binding", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		const old = await SessionStore.open({
			credentialBinding: storage.credentialBinding,
			persist: storage.persist,
		})
		const browser = await old.create()
		if (browser.kind !== "created") throw new Error("Expected browser")
		await storage.rotateMachineCredential({ keepSessions: true })
		expect(storage.startupSnapshot().sessions).toEqual([
			expect.objectContaining({ deviceId: browser.principalId }),
		])
		expect(storage.startupSnapshot().credentialBinding).toBe(
			storage.credentialBinding,
		)
		expect(storage.startupSnapshot().credentialBinding).not.toBe(
			old.credentialBinding,
		)
		await expect(old.renew(browser.principalId)).rejects.toMatchObject({
			code: "ACCESS_UNAVAILABLE",
		})
		expect(storage.startupSnapshot().sessions).toEqual([
			expect.objectContaining({ deviceId: browser.principalId }),
		])
		const mode = (await fs.stat(join(directory, "access-state.json"))).mode
		expect(mode & 0o777).toBe(0o600)
		const binding = storage.credentialBinding
		await storage.close()
		const reloaded = await open(directory, "load")
		expect(reloaded.startupSnapshot().sessions).toEqual([
			expect.objectContaining({ deviceId: browser.principalId }),
		])
		expect(reloaded.startupSnapshot().credentialBinding).toBe(binding)
	})

	it("keeps the previous credential and sessions when rotation fails before rename", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		const sessions = await SessionStore.open({
			credentialBinding: storage.credentialBinding,
			persist: storage.persist,
		})
		const browser = await sessions.create()
		if (browser.kind !== "created") throw new Error("Expected browser")
		const before = await fs.readFile(
			join(directory, "access-state.json"),
			"utf8",
		)
		vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("secret-rename"))
		try {
			await storage.rotateMachineCredential()
			expect.fail("Expected rotation to fail closed")
		} catch (error) {
			expect(error).toMatchObject({
				code: "ACCESS_STORAGE_UNAVAILABLE",
				cause: undefined,
			})
			expect(String(error)).not.toContain("secret-rename")
		}
		expect(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		).toBe(before)
		await storage.close()
		const reloaded = await open(directory, "load")
		expect(reloaded.startupSnapshot().sessions).toEqual([
			expect.objectContaining({ deviceId: browser.principalId }),
		])
	})

	it("persists monotonic renewals after a wall-clock backward jump", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		const epoch = Date.now()
		let monotonic = 0
		const store = await SessionStore.open({
			credentialBinding: storage.credentialBinding,
			persist: storage.persist,
			epochNow: () => epoch,
			monotonicNow: () => monotonic,
		})
		const browser = await store.create()
		if (browser.kind !== "created") throw new Error("Expected browser")
		monotonic = 24 * 60 * 60 * 1000
		vi.spyOn(Date, "now").mockReturnValue(epoch - 365 * 24 * 60 * 60 * 1000)
		await expect(store.renew(browser.principalId)).resolves.toMatchObject({
			kind: "renewed",
			expiresAt: browser.expiresAt + monotonic,
		})
		expect(storage.startupSnapshot().sessions[0]?.renewedAt).toBe(
			epoch + monotonic,
		)
	})

	it("keeps prior durable data on pre-rename failures, cleans only its temp and fails browser leases closed", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		const sessions = await SessionStore.open({
			credentialBinding: storage.credentialBinding,
			persist: storage.persist,
		})
		const browser = await sessions.create()
		if (browser.kind !== "created") throw new Error("Expected browser")
		const before = await fs.readFile(
			join(directory, "access-state.json"),
			"utf8",
		)
		const unrelated = join(directory, ".unrelated.tmp")
		await fs.writeFile(unrelated, "preserve", { mode: 0o600 })
		const cleanup = vi.fn()
		sessions.onInvalidated(browser.principalId, cleanup)
		vi.spyOn(fs, "rename").mockRejectedValueOnce(
			new Error(generateMachineToken()),
		)
		await expect(sessions.revoke(browser.principalId)).rejects.toMatchObject({
			code: "ACCESS_UNAVAILABLE",
			cause: undefined,
		})
		expect(cleanup).toHaveBeenCalledOnce()
		expect(storage.unavailable).toBe(true)
		expect(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		).toBe(before)
		expect(await fs.readFile(unrelated, "utf8")).toBe("preserve")
		expect(
			(await fs.readdir(directory)).filter(entry =>
				entry.startsWith(".access-state"),
			),
		).toHaveLength(0)
	})

	it.each(["access-state.json", "initialized"])(
		"fails closed without recreating %s deleted after open",
		async deleted => {
			const { directory } = await location()
			const storage = await open(directory)
			const store = await SessionStore.open({
				credentialBinding: storage.credentialBinding,
				persist: storage.persist,
			})
			await fs.unlink(join(directory, deleted))
			await expect(store.create()).rejects.toMatchObject({
				code: "ACCESS_UNAVAILABLE",
			})
			expect(store.exportSnapshot().sessions).toHaveLength(0)
			expect(storage.unavailable).toBe(true)
			expect((await fs.readdir(directory)).includes(deleted)).toBe(false)
		},
	)

	it("reports directory fsync failure after rename without claiming success or old disk contents", async () => {
		const { directory } = await location()
		const originalOpen = fs.open
		let directoryHandle: Awaited<ReturnType<typeof fs.open>> | undefined
		vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
			const handle = await originalOpen(path, flags, mode)
			if (path === directory) directoryHandle = handle
			return handle
		})
		const storage = await open(directory)
		const store = await SessionStore.open({
			credentialBinding: storage.credentialBinding,
			persist: storage.persist,
		})
		const browser = await store.create()
		if (browser.kind !== "created" || !directoryHandle)
			throw new Error("Expected browser and directory handle")
		const close = vi.fn()
		store.onInvalidated(browser.principalId, close)
		vi.spyOn(directoryHandle, "sync").mockRejectedValueOnce(
			new Error("private-path-must-not-escape"),
		)
		await expect(store.revoke(browser.principalId)).rejects.toMatchObject({
			code: "ACCESS_UNAVAILABLE",
			cause: undefined,
		})
		expect(close).toHaveBeenCalledOnce()
		expect(storage.unavailable).toBe(true)
		expect(store.exportSnapshot().sessions).toHaveLength(1)
		// Rename happened, but durability failed: disk may recover old or new state.
		expect(
			JSON.parse(
				await fs.readFile(join(directory, "access-state.json"), "utf8"),
			),
		).toMatchObject({ sessions: { sessions: [] } })
	})
})

describe("last-seen persistence (WG2 req 11.6)", () => {
	const failNextTempOpen = () => {
		const open = fs.open.bind(fs)
		let armed = true
		vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
			if (armed && String(path).endsWith(".tmp")) {
				armed = false
				throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })
			}
			return open(path, flags, mode)
		})
	}

	it("does not latch the storage on a failed last-seen write; the next login commits", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		const sessions = await SessionStore.open({
			credentialBinding: storage.credentialBinding,
			snapshot: storage.startupSnapshot(),
			persist: storage.persist,
			persistSeen: storage.persistSeen,
			logger: { warn: () => undefined },
		})
		const browser = await sessions.create()
		if (browser.kind !== "created") throw new Error("Expected browser")
		failNextTempOpen()
		await sessions.noteSeen(browser.principalId, Date.now())
		expect(storage.unavailable).toBe(false)
		expect(sessions.unavailable).toBe(false)
		const next = await sessions.create()
		expect(next.kind).toBe("created")
		const state = JSON.parse(
			await fs.readFile(join(directory, "access-state.json"), "utf8"),
		) as { sessions: { sessions: unknown[] } }
		expect(state.sessions.sessions).toHaveLength(2)
	})

	it("latches a last-seen write whose directory check fails after the temp write (R2 3)", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		const snapshot = storage.startupSnapshot()
		const openFile = fs.open.bind(fs)
		const lstat = fs.lstat.bind(fs)
		let wrote = false
		vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
			if (String(path).endsWith(".tmp")) wrote = true
			return openFile(path, flags, mode)
		})
		vi.spyOn(fs, "lstat").mockImplementation(async path => {
			if (wrote && String(path) === directory)
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
			return lstat(path)
		})
		await expect(storage.persistSeen(snapshot)).rejects.toThrow()
		expect(storage.unavailable).toBe(true)
	})

	it("still latches a failed full commit", async () => {
		const { directory } = await location()
		const storage = await open(directory)
		const snapshot = storage.startupSnapshot()
		failNextTempOpen()
		await expect(storage.persist(snapshot)).rejects.toThrow()
		expect(storage.unavailable).toBe(true)
	})
})

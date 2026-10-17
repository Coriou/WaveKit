import fs from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { sessionSnapshotSchema } from "../../../src/access/schema.js"
import { SessionFlows } from "../../../src/access/session-flows.js"
import { SessionStore } from "../../../src/access/sessions.js"
import type {
	SessionSnapshot,
	SessionStoreOptions,
} from "../../../src/access/sessions.js"
import type { AccessRequest } from "../../../src/access/types.js"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const START = 1_699_999_200_000
const origin = "http://receiver.lan:9000"
const roots: string[] = []
const owners: PrivateAccessStorage[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	for (const storage of owners.splice(0))
		await storage.close().catch(() => undefined)
	for (const root of roots.splice(0))
		await fs.rm(root, { recursive: true, force: true })
})

function created<T extends { kind: string }>(
	result: T,
): Extract<T, { kind: "created" }> {
	if (result.kind !== "created") throw new Error("Expected created session")
	return result as Extract<T, { kind: "created" }>
}

async function setup(overrides: Partial<SessionStoreOptions> = {}) {
	let epoch = START
	let mono = 0
	let random = 20
	let durable: SessionSnapshot | undefined
	const warn = vi.fn()
	const token = generateMachineToken(() => Buffer.alloc(32, 4))
	const digest = digestMachineToken(token)
	const persist = vi.fn((snapshot: SessionSnapshot) => {
		durable = structuredClone(snapshot)
		return Promise.resolve()
	})
	const options: SessionStoreOptions = {
		credentialBinding: sessionCredentialBinding(digest),
		persist,
		epochNow: () => epoch,
		monotonicNow: () => mono,
		random: size => Buffer.alloc(size, ++random),
		logger: { warn },
		maxSessions: 32,
		...overrides,
	}
	const sessions = await SessionStore.open(options)
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: ["receiver.lan:9000"],
		allowedOrigins: [origin],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const flows = new SessionFlows({ policy, sessions })
	const browser = created(await sessions.create())
	persist.mockClear()
	const request = (
		path: string,
		changes: Partial<AccessRequest> = {},
		session = browser,
	): AccessRequest => ({
		method: "POST",
		rawTarget: path,
		rawHeaders: [
			"Host",
			"receiver.lan:9000",
			"Origin",
			origin,
			"Cookie",
			`wavekit_session=${session.cookieValue}`,
			"X-WaveKit-CSRF",
			session.csrfToken,
		],
		transport: "http",
		surface: "api",
		remoteAddress: "127.0.0.1",
		...changes,
	})
	return {
		token,
		sessions,
		flows,
		browser,
		request,
		persist,
		warn,
		options,
		durable: () => durable,
		setClock: (value: number) => {
			epoch = value
			mono = value - START
		},
	}
}

function deferred() {
	let resolve: () => void = () => {}
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}

const legacySnapshotSchema = z
	.object({
		version: z.literal(1),
		credentialBinding: z.string(),
		sessions: z
			.array(
				z
					.object({
						deviceId: z.string(),
						tokenHash: z.string(),
						csrfToken: z.string(),
						createdAt: z.number(),
						renewedAt: z.number(),
						expiresAt: z.number(),
					})
					.strict(),
			)
			.max(32),
	})
	.strict()

describe("device labels", () => {
	it("parses the body before queueing and commits name and kind without touching expiry", async () => {
		const env = await setup()
		const before = env.sessions.exportSnapshot().sessions[0]
		if (!before) throw new Error("Missing session")
		const body: { deviceId: string; name: string; kind?: "phone" } = {
			deviceId: env.browser.principalId,
			name: "Radio",
		}
		const gate = deferred()
		env.persist.mockImplementationOnce(() => gate.promise)
		const pending = env.flows.label(
			env.request("/api/access/devices/label"),
			body,
		)
		body.name = "Changed"
		body.kind = "phone"
		await vi.waitFor(() => expect(env.persist).toHaveBeenCalledOnce())
		expect(env.sessions.exportSnapshot().sessions[0]?.name).toBeNull()
		gate.resolve()
		expect(await pending).toMatchObject({
			kind: "success",
			status: 200,
			body: { updated: true },
		})
		const record = env.sessions.exportSnapshot().sessions[0]
		expect(record).toMatchObject({
			name: "Radio",
			kind: null,
			lastSeenAt: null,
			renewedAt: before.renewedAt,
			expiresAt: before.expiresAt,
		})
	})

	it.each([
		[{ deviceId: `device_${"A".repeat(43)}` }, "no keys"],
		[{ name: "Radio" }, "missing device"],
		[
			{ deviceId: `device_${"A".repeat(43)}`, name: "a".repeat(65) },
			"65 characters",
		],
		[
			{ deviceId: `device_${"A".repeat(43)}`, name: `\u20ac`.repeat(43) },
			"129 bytes",
		],
		[{ deviceId: `device_${"A".repeat(43)}`, name: " leading" }, "untrimmed"],
		[{ deviceId: `device_${"A".repeat(43)}`, name: "bad\nname" }, "control"],
		[{ deviceId: `device_${"A".repeat(43)}`, name: "a\u0085b" }, "C1"],
		[{ deviceId: `device_${"A".repeat(43)}`, name: "a\u202eb" }, "bidi"],
		[{ deviceId: `device_${"A".repeat(43)}`, name: "a\u2066b" }, "isolate"],
		[
			{ deviceId: `device_${"A".repeat(43)}`, name: "a\ud800b" },
			"lone high surrogate",
		],
		[
			{ deviceId: `device_${"A".repeat(43)}`, name: "\udc00" },
			"lone low surrogate",
		],
		[{ deviceId: `device_${"A".repeat(43)}`, kind: "laptop" }, "kind"],
		[{ deviceId: "device_short", name: "Radio" }, "device id"],
	] as const)("rejects a %s body before persistence", async (body, _label) => {
		const env = await setup()
		const result = await env.flows.label(
			env.request("/api/access/devices/label"),
			body,
		)
		expect(result).toMatchObject({
			status: 400,
			body: { code: "MALFORMED_REQUEST" },
		})
		expect(env.persist).not.toHaveBeenCalled()
		expect(env.sessions.exportSnapshot().sessions[0]).toMatchObject({
			name: null,
			kind: null,
		})
	})

	it("clears with null, keeps an absent key, and reports an unknown or expired device", async () => {
		const env = await setup({ ttlMs: 1_000 })
		expect(
			await env.flows.label(env.request("/api/access/devices/label"), {
				deviceId: env.browser.principalId,
				name: "Field",
				kind: "tablet",
			}),
		).toMatchObject({ body: { updated: true } })
		expect(
			await env.flows.label(env.request("/api/access/devices/label"), {
				deviceId: env.browser.principalId,
				name: null,
			}),
		).toMatchObject({ body: { updated: true } })
		expect(env.sessions.exportSnapshot().sessions[0]).toMatchObject({
			name: null,
			kind: "tablet",
		})
		env.persist.mockClear()
		expect(
			await env.flows.label(env.request("/api/access/devices/label"), {
				deviceId: `device_${"B".repeat(42)}A`,
				name: "Other",
			}),
		).toMatchObject({ body: { updated: false } })
		expect(env.persist).not.toHaveBeenCalled()
		env.setClock(START + 500)
		const peer = created(await env.sessions.create())
		env.setClock(START + 1_000)
		env.persist.mockClear()
		expect(
			await env.flows.label(
				env.request("/api/access/devices/label", {}, peer),
				{ deviceId: env.browser.principalId, kind: "cli" },
			),
		).toMatchObject({ body: { updated: false } })
		expect(env.persist).not.toHaveBeenCalled()
		expect(env.sessions.exportSnapshot().sessions).toHaveLength(2)
		expect(env.sessions.exportSnapshot().sessions[0]?.kind).toBe("tablet")
	})

	it("orders a label ahead of a later revoke, and a revoke ahead of a later label", async () => {
		const env = await setup()
		const gate = deferred()
		env.persist.mockImplementationOnce(() => gate.promise)
		const labeling = env.flows.label(env.request("/api/access/devices/label"), {
			deviceId: env.browser.principalId,
			name: "Radio",
		})
		await vi.waitFor(() => expect(env.persist).toHaveBeenCalledOnce())
		const revoking = env.flows.revoke(
			env.request("/api/access/devices/revoke"),
			{ deviceId: env.browser.principalId },
		)
		gate.resolve()
		expect(await labeling).toMatchObject({ body: { updated: true } })
		expect(await revoking).toMatchObject({ body: { revoked: true } })
		expect(env.sessions.exportSnapshot().sessions).toHaveLength(0)

		const again = await setup()
		const held = deferred()
		again.persist.mockImplementationOnce(() => held.promise)
		const first = again.sessions.revoke(again.browser.principalId)
		await vi.waitFor(() => expect(again.persist).toHaveBeenCalledOnce())
		const second = again.sessions.label(again.browser.principalId, {
			kind: "other",
		})
		held.resolve()
		expect(await first).toBe(true)
		expect(await second).toBe(false)
		expect(again.persist).toHaveBeenCalledOnce()
		expect(again.sessions.exportSnapshot().sessions).toHaveLength(0)
	})

	it("latches on a failed label and leaves the committed snapshot unchanged", async () => {
		const env = await setup()
		const close = vi.fn()
		env.sessions.onInvalidated(env.browser.principalId, close)
		const before = env.sessions.exportSnapshot()
		env.persist.mockRejectedValueOnce(new Error("SECRET-disk"))
		const result = await env.flows.label(
			env.request("/api/access/devices/label"),
			{ deviceId: env.browser.principalId, name: "Radio" },
		)
		expect(result).toMatchObject({
			status: 503,
			body: { code: "ACCESS_UNAVAILABLE" },
		})
		expect(JSON.stringify(result)).not.toContain("SECRET")
		expect(env.sessions.exportSnapshot()).toEqual(before)
		expect(env.sessions.unavailable).toBe(true)
		expect(close).toHaveBeenCalledOnce()
		expect(env.sessions.lookup(env.browser.cookieValue)).toBeUndefined()
	})
})

describe("snapshot version 2", () => {
	it("loads a version 1 record as null labels and writes version 2", async () => {
		const env = await setup()
		const written = env.sessions.exportSnapshot()
		const legacy = {
			version: 1 as const,
			credentialBinding: written.credentialBinding,
			sessions: written.sessions.map(record => ({
				deviceId: record.deviceId,
				tokenHash: record.tokenHash,
				csrfToken: record.csrfToken,
				createdAt: record.createdAt,
				renewedAt: record.renewedAt,
				expiresAt: record.expiresAt,
			})),
		}
		const restarted = await SessionStore.open({
			...env.options,
			persist: async () => undefined,
			snapshot: legacy,
		})
		expect(restarted.lookup(env.browser.cookieValue)?.principalId).toBe(
			env.browser.principalId,
		)
		expect(restarted.exportSnapshot()).toMatchObject({
			version: 2,
			sessions: [{ name: null, kind: null, lastSeenAt: null }],
		})
		expect(
			restarted.snapshotActiveDevices(env.browser.principalId),
		).toMatchObject({
			kind: "active",
			devices: [{ name: null, kind: null, lastSeenAt: null }],
		})
	})

	it("fails closed on a corrupt version 2 record and documents the shape an older WaveKit refuses", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "wavekit-device-labels-"))
		roots.push(root)
		const directory = join(root, "private")
		const storage = await PrivateAccessStorage.open({
			directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		owners.push(storage)
		const sessions = await SessionStore.open({
			credentialBinding: storage.credentialBinding,
			persist: storage.persist,
			epochNow: () => START,
			monotonicNow: () => 0,
		})
		const browser = created(await sessions.create())
		const path = join(directory, "access-state.json")
		const original = JSON.parse(await fs.readFile(path, "utf8")) as {
			version: number
			sessions: {
				version: number
				sessions: Record<string, unknown>[]
			}
		}
		expect(original.version).toBe(1)
		expect(original.sessions.version).toBe(2)
		expect(original.sessions.sessions[0]).toMatchObject({
			name: null,
			kind: null,
			lastSeenAt: null,
		})
		expect(legacySnapshotSchema.safeParse(original.sessions).success).toBe(
			false,
		)
		expect(sessionSnapshotSchema.safeParse(original.sessions).success).toBe(
			true,
		)
		await storage.close()
		owners.splice(0, owners.length)
		const record = () => {
			const copy = JSON.parse(JSON.stringify(original)) as typeof original
			const row = copy.sessions.sessions[0]
			if (!row) throw new Error("Missing stored session")
			return { copy, row }
		}
		for (const corrupt of [
			(row: Record<string, unknown>) => {
				row["name"] = "bad\nname"
			},
			(row: Record<string, unknown>) => {
				row["name"] = "a".repeat(65)
			},
			(row: Record<string, unknown>) => {
				row["name"] = "a\u202eb"
			},
			(row: Record<string, unknown>) => {
				row["kind"] = "laptop"
			},
			(row: Record<string, unknown>) => {
				row["lastSeenAt"] = HOUR + 1
			},
		]) {
			const { copy, row } = record()
			corrupt(row)
			await fs.writeFile(path, JSON.stringify(copy))
			await expect(
				PrivateAccessStorage.open({
					directory,
					mode: "load",
					ownership: "single-host-pid-namespace",
				}),
			).rejects.toMatchObject({ code: "ACCESS_STORAGE_INVALID" })
			await expect(
				SessionStore.open({
					credentialBinding: "a".repeat(64),
					persist: async () => undefined,
					snapshot: copy.sessions,
				}),
			).rejects.toMatchObject({ code: "SESSION_SNAPSHOT_INVALID" })
		}
		const legacy = record().copy
		legacy.sessions.version = 1
		for (const row of legacy.sessions.sessions) {
			delete row["name"]
			delete row["kind"]
			delete row["lastSeenAt"]
		}
		await fs.writeFile(path, JSON.stringify(legacy))
		const loaded = await PrivateAccessStorage.open({
			directory,
			mode: "load",
			ownership: "single-host-pid-namespace",
		})
		owners.push(loaded)
		expect(loaded.startupSnapshot()).toMatchObject({
			version: 2,
			sessions: [
				{
					deviceId: browser.principalId,
					name: null,
					kind: null,
					lastSeenAt: null,
				},
			],
		})
		const disk = JSON.parse(await fs.readFile(path, "utf8")) as {
			sessions: { version: number }
		}
		expect(disk.sessions.version).toBe(1)
	})

	it("keeps 32 sessions with 128-byte names under the 64 KiB state cap", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "wavekit-device-size-"))
		roots.push(root)
		const directory = join(root, "private")
		const storage = await PrivateAccessStorage.open({
			directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		owners.push(storage)
		let random = 30
		let latest: SessionSnapshot | undefined
		const sessions = await SessionStore.open({
			credentialBinding: storage.credentialBinding,
			persist: async snapshot => {
				latest = structuredClone(snapshot)
			},
			epochNow: () => START,
			monotonicNow: () => 0,
			maxSessions: 32,
			random: size => Buffer.alloc(size, ++random),
		})
		for (let index = 0; index < 32; index++) created(await sessions.create())
		const name = "\u00e9".repeat(64)
		expect([...name].length).toBe(64)
		expect(new TextEncoder().encode(name).length).toBe(128)
		const full = latest
		if (!full) throw new Error("Missing snapshot")
		full.sessions = full.sessions.map(record => ({
			...record,
			name,
			kind: "desktop",
			lastSeenAt: START,
		}))
		await storage.persist(full)
		const path = join(directory, "access-state.json")
		const bytes = (await fs.stat(path)).size
		expect(bytes).toBeLessThanOrEqual(64 * 1024)
		expect(bytes).toBeGreaterThan(32 * 128)
		await storage.close()
		owners.splice(0, owners.length)
		const loaded = await PrivateAccessStorage.open({
			directory,
			mode: "load",
			ownership: "single-host-pid-namespace",
		})
		owners.push(loaded)
		expect(loaded.startupSnapshot().sessions).toHaveLength(32)
		expect(loaded.startupSnapshot().sessions[0]?.name).toBe(name)
	})
})

describe("coarse last-seen", () => {
	it("commits one hour floor, ignores bursts and earlier hours, keeps a later hour that arrives mid-commit, and does not renew", async () => {
		const env = await setup()
		const before = env.sessions.exportSnapshot().sessions[0]
		if (!before) throw new Error("Missing session")
		const gate = deferred()
		env.persist.mockImplementationOnce(() => gate.promise)
		const first = env.sessions.noteSeen(env.browser.principalId, START + 10)
		await vi.waitFor(() => expect(env.persist).toHaveBeenCalledOnce())
		// WG2 R2: a next-hour admission while that commit runs is queued, not dropped.
		const later = env.sessions.noteSeen(
			env.browser.principalId,
			START + HOUR + 10,
		)
		expect(env.sessions.exportSnapshot().sessions[0]?.lastSeenAt).toBeNull()
		gate.resolve()
		await first
		await later
		expect(env.persist).toHaveBeenCalledTimes(2)
		expect(env.sessions.exportSnapshot().sessions[0]).toMatchObject({
			lastSeenAt: START + HOUR,
			renewedAt: before.renewedAt,
			expiresAt: before.expiresAt,
			name: null,
		})
		env.persist.mockClear()
		// Bursts and earlier hours write nothing.
		await env.sessions.noteSeen(env.browser.principalId, START + 2 * HOUR - 1)
		await env.sessions.noteSeen(env.browser.principalId, START)
		await env.sessions.noteSeen(env.browser.principalId, START - HOUR)
		expect(env.persist).not.toHaveBeenCalled()
		expect(env.sessions.exportSnapshot().sessions[0]?.lastSeenAt).toBe(
			START + HOUR,
		)
		expect(env.sessions.exportSnapshot().sessions[0]?.expiresAt).toBe(
			before.expiresAt,
		)
	})

	it("keeps a failed last-seen commit from latching, logs it once per 60s, and retries", async () => {
		const env = await setup()
		const close = vi.fn()
		env.sessions.onInvalidated(env.browser.principalId, close)
		const before = env.sessions.exportSnapshot()
		env.persist.mockRejectedValue(new Error("SECRET-seen"))
		await env.sessions.noteSeen(env.browser.principalId, START + 5)
		await env.sessions.noteSeen(env.browser.principalId, START + 59_999)
		expect(env.sessions.exportSnapshot()).toEqual(before)
		expect(env.sessions.unavailable).toBe(false)
		expect(close).not.toHaveBeenCalled()
		expect(env.sessions.lookup(env.browser.cookieValue)?.expiresAt).toBe(
			env.browser.expiresAt,
		)
		expect(env.warn).toHaveBeenCalledTimes(1)
		expect(JSON.stringify(env.warn.mock.calls)).not.toContain(
			env.browser.principalId,
		)
		expect(JSON.stringify(env.warn.mock.calls)).not.toContain("SECRET")
		await env.sessions.noteSeen(env.browser.principalId, START + 5 + 60_000)
		expect(env.warn).toHaveBeenCalledTimes(2)
		env.persist.mockReset()
		const durable = vi.fn((snapshot: SessionSnapshot) => {
			void snapshot
		})
		env.persist.mockImplementation(snapshot => {
			durable(snapshot)
			return Promise.resolve()
		})
		await env.sessions.noteSeen(env.browser.principalId, START + 5 + 60_000)
		expect(env.sessions.unavailable).toBe(false)
		expect(env.sessions.exportSnapshot().sessions[0]?.lastSeenAt).toBe(START)
		expect(env.sessions.exportSnapshot().sessions[0]?.expiresAt).toBe(
			before.sessions[0]?.expiresAt,
		)
		expect(close).not.toHaveBeenCalled()
	})

	it("does not let an inventory read commit, including through the flow", async () => {
		const env = await setup()
		await env.sessions.noteSeen(env.browser.principalId, START)
		env.persist.mockClear()
		const read = env.flows.devices(
			env.request("/api/access/devices", { method: "GET" }),
		)
		const head = env.flows.devices(
			env.request("/api/access/devices", { method: "HEAD" }),
		)
		expect(read).toMatchObject({
			kind: "success",
			body: {
				devices: [
					{
						name: null,
						kind: null,
						lastSeenAt: START,
						current: true,
					},
				],
			},
		})
		expect(head.status).toBe(200)
		expect(env.persist).not.toHaveBeenCalled()
		expect(env.sessions.snapshotRememberedDevices()[0]?.lastSeenAt).toBe(START)
		expect(env.persist).not.toHaveBeenCalled()
	})

	it("stays at or under 32 devices times 24 hourly commits", async () => {
		const env = await setup()
		const ids = [env.browser.principalId]
		for (let index = 1; index < 32; index++)
			ids.push(created(await env.sessions.create()).principalId)
		env.persist.mockClear()
		for (let hour = 0; hour < 24; hour++) {
			const now = START + hour * HOUR + 5
			await Promise.all(ids.map(id => env.sessions.noteSeen(id, now)))
			await Promise.all(ids.map(id => env.sessions.noteSeen(id, now + 10)))
		}
		expect(env.persist).toHaveBeenCalledTimes(32 * 24)
		for (const record of env.sessions.exportSnapshot().sessions) {
			expect(record.lastSeenAt).toBe(START + 23 * HOUR)
			expect(record.expiresAt).toBe(START + 30 * DAY)
		}
	})
})

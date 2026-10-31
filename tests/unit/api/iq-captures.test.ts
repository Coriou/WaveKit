import { EventEmitter, once } from "node:events"
import { createWriteStream, writeFileSync } from "node:fs"
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	truncate,
	writeFile,
} from "node:fs/promises"
import { request, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import fc from "fast-check"
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
	IQ_CAPTURE_MAX_BYTES,
	IQ_CAPTURE_NAME,
	IQ_CAPTURES_MAX_COUNT,
	IQ_CAPTURES_MIN_FREE_BYTES,
	IQ_CAPTURES_QUOTA_BYTES,
	type IqCapture,
	type TunerState,
} from "@wavekit/api-types"
import {
	iqCaptureRoutes,
	IqCaptureStore,
	type IqCaptureOptions,
} from "../../../src/api/routes/iq-captures.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { createLogger } from "../../../src/utils/logger.js"
import type { SourceStatus } from "../../../src/core/source-manager.js"
import { installAccessHooks } from "../../../src/access/fastify-adapter.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import type { DeniedAdmission } from "../../../src/access/types.js"

const url = "/api/iq/captures"
let app: FastifyInstance
let dir: string
let fanout: FanoutManager
let input: PassThrough
let sources: EventEmitter & {
	getStatus: (id: string) => SourceStatus | undefined
	getAllStatus: () => SourceStatus[]
}
let statuses: SourceStatus[]
let denial: DeniedAdmission | undefined
let invalidate: (() => void) | undefined
let available: number
let tuner: TunerState | undefined

const status = (id: string, rate = 1000): SourceStatus =>
	({
		id,
		connected: true,
		caps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: rate,
			centerFreq: 100_000_000,
		},
	}) as SourceStatus

const options = (extra: Partial<IqCaptureOptions> = {}): IqCaptureOptions => ({
	dir,
	sourceManager: sources,
	fanoutFor: () => fanout,
	tunerState: () => tuner,
	availableBytes: async () => available,
	access: {
		authorizeMetadataMutation: () => denial,
		leaseDownload: (_request, raw, cancel) => {
			let released = false
			const finish = () => {
				if (released) return
				released = true
				cancel()
			}
			invalidate = () => {
				finish()
				raw.destroy()
			}
			raw.once("finish", finish)
			return {
				kind: "attached",
				active: () => !released && !raw.destroyed,
				release: invalidate,
			}
		},
	},
	...extra,
})

/** Replaces the app with one built from `extra` (a fresh plugin over the same directory). */
const rebuild = async (extra: Partial<IqCaptureOptions> = {}) => {
	await app.close()
	app = Fastify()
	await app.register(iqCaptureRoutes, options(extra))
	await app.ready()
}

/** A promise the test opens by hand. */
const gate = () => {
	let open!: () => void
	const opened = new Promise<void>(resolve => {
		open = resolve
	})
	return { opened, open }
}

/** Starts a capture and waits until its branch listens. */
const start = async (
	body: Record<string, unknown> = { name: "first", seconds: 1 },
) => {
	const added = once(fanout, "branch-added")
	const pending = app
		.inject({ method: "POST", url, payload: body })
		.then(r => r)
	await added
	await Promise.resolve()
	return { pending }
}

/** A stored capture written straight to disk (sparse data of `bytes`). */
const plant = async (
	name: string,
	bytes: number,
	startedAt = "2026-01-01T00:00:00.000Z",
) => {
	const meta: IqCapture = {
		name,
		sourceId: "source",
		format: "cu8",
		centerHz: 100_000_000,
		sampleRate: 1000,
		gain: null,
		startedAt,
		durationS: 1,
		bytes,
	}
	await writeFile(join(dir, `${name}.cu8`), "")
	await truncate(join(dir, `${name}.cu8`), bytes)
	await writeFile(join(dir, `${name}.json`), JSON.stringify(meta))
}

beforeEach(async () => {
	dir = join(await mkdtemp(join(tmpdir(), "wk-iq-captures-")), "iq-captures")
	denial = undefined
	invalidate = undefined
	available = 10 * 1024 ** 3
	tuner = undefined
	statuses = [status("source")]
	sources = Object.assign(new EventEmitter(), {
		getStatus: (id: string) => statuses.find(s => s.id === id),
		getAllStatus: () => statuses,
	})
	fanout = new FanoutManager(createLogger({ level: "fatal" }))
	input = new PassThrough()
	fanout.attachSource(input)
	app = Fastify()
	await app.register(iqCaptureRoutes, options())
	await app.ready()
})

afterEach(async () => {
	await app.close()
	input.destroy()
	fanout.detachSource()
	await rm(dirname(dir), { recursive: true, force: true })
	vi.restoreAllMocks()
})

it("stores, lists, downloads and deletes a named capture at the current tuning", async () => {
	tuner = { gainMode: "manual", gain: 372 } as TunerState
	const { pending } = await start()
	input.write(Buffer.alloc(1500, 7))
	input.write(Buffer.alloc(700, 9))
	const res = await pending
	expect(res.statusCode).toBe(201)
	const capture = res.json<IqCapture>()
	expect(capture).toMatchObject({
		name: "first",
		sourceId: "source",
		format: "cu8",
		centerHz: 100_000_000,
		sampleRate: 1000,
		gain: 372,
		durationS: 1,
		bytes: 2000,
	})
	expect(Number.isNaN(Date.parse(capture.startedAt))).toBe(false)
	const expected = Buffer.concat([Buffer.alloc(1500, 7), Buffer.alloc(500, 9)])
	expect(await readFile(join(dir, "first.cu8"))).toEqual(expected)
	expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)
	expect((await readdir(dir)).sort()).toEqual(["first.cu8", "first.json"])

	const list = await app.inject({ method: "GET", url })
	expect(list.json()).toEqual({
		captures: [capture],
		usedBytes: 2000,
		quotaBytes: IQ_CAPTURES_QUOTA_BYTES,
		maxCount: IQ_CAPTURES_MAX_COUNT,
	})

	const file = await app.inject({ method: "GET", url: `${url}/first` })
	expect(file.statusCode).toBe(200)
	expect(file.rawPayload).toEqual(expected)
	expect(file.headers).toMatchObject({
		"content-type": "application/octet-stream",
		"content-disposition": 'attachment; filename="first.cu8"',
		"content-length": "2000",
		"cache-control": "no-store",
		"x-wavekit-center-hz": "100000000",
		"x-wavekit-sample-rate": "1000",
		"x-wavekit-start-time": capture.startedAt,
	})

	expect(
		(await app.inject({ method: "DELETE", url: `${url}/first` })).statusCode,
	).toBe(204)
	expect(await readdir(dir)).toEqual([])
	expect(
		(await app.inject({ method: "GET", url: `${url}/first` })).statusCode,
	).toBe(404)
	expect(
		(await app.inject({ method: "DELETE", url: `${url}/first` })).statusCode,
	).toBe(404)
})

it("records null gain under AGC or unknown tuner state", async () => {
	tuner = { gainMode: "agc", gain: 300 } as TunerState
	const { pending } = await start()
	input.write(Buffer.alloc(2000))
	expect((await pending).json<IqCapture>().gain).toBeNull()
	tuner = {
		gainMode: "manual",
		gain: 300,
		unknownFields: ["gain"],
	} as TunerState
	const { pending: next } = await start({ name: "second", seconds: 1 })
	input.write(Buffer.alloc(2000))
	expect((await next).json<IqCapture>().gain).toBeNull()
})

it.each([
	"../escape",
	"a/b",
	"..",
	".hidden",
	"Upper",
	"with.dot",
	"x.cu8",
	"",
	"-lead",
	"a%2Fb",
	"a".repeat(65),
])("refuses the name %j without echoing it", async name => {
	const res = await app.inject({
		method: "POST",
		url,
		payload: { name, seconds: 1 },
	})
	expect(res.statusCode).toBe(400)
	const body = res.json<{ code: string; fields: { field: string }[] }>()
	expect(body.code).toBe("VALIDATION_ERROR")
	expect(body.fields.map(f => f.field)).toEqual(["name"])
	if (name.length > 2) expect(res.body).not.toContain(name)
})

it("accepts a name at the 64-character bound", async () => {
	const { pending } = await start({ name: "a".repeat(64), seconds: 1 })
	input.write(Buffer.alloc(2000))
	expect((await pending).statusCode).toBe(201)
})

it.each([0, 11, 1.5, -1])(
	"refuses seconds outside 1 to 10 whole seconds: %s",
	async seconds => {
		const res = await app.inject({
			method: "POST",
			url,
			payload: { name: "x", seconds },
		})
		expect(res.statusCode).toBe(400)
		expect(res.json<{ fields: { field: string }[] }>().fields[0]?.field).toBe(
			"seconds",
		)
	},
)

it.each(["..%2F..%2Fetc", "%2E%2E", "Upper", "a.json"])(
	"answers 404 for the unchecked path name %s",
	async name => {
		for (const method of ["GET", "DELETE"] as const) {
			const res = await app.inject({ method, url: `${url}/${name}` })
			// A dot segment may be normalized away to another route: still a 404.
			expect(res.statusCode).toBe(404)
		}
	},
)

it("never builds a path outside the capture directory from an accepted name", () => {
	// Feature: iq-captures, Property 1: accepted names stay inside the directory
	const store = new IqCaptureStore("/captures")
	fc.assert(
		fc.property(fc.string({ maxLength: 80 }), name => {
			if (!IQ_CAPTURE_NAME.test(name)) return
			for (const path of [
				store.data(name),
				store.meta(name),
				store.partial(name),
			])
				expect(dirname(path)).toBe("/captures")
			expect(name).not.toMatch(/[./\\A-Z]/)
		}),
		{ numRuns: 200 },
	)
})

it("refuses a duplicate name and a second capture on the same source", async () => {
	const { pending } = await start()
	const busy = await app.inject({
		method: "POST",
		url,
		payload: { name: "other", seconds: 1 },
	})
	expect(busy.statusCode).toBe(409)
	expect(busy.json()).toMatchObject({ code: "IQ_CAPTURE_BUSY" })
	// Deleting the running capture's name is refused too.
	expect(
		(await app.inject({ method: "DELETE", url: `${url}/first` })).statusCode,
	).toBe(409)
	input.write(Buffer.alloc(2000))
	expect((await pending).statusCode).toBe(201)
	const dup = await app.inject({
		method: "POST",
		url,
		payload: { name: "first", seconds: 1 },
	})
	expect(dup.statusCode).toBe(409)
	expect(dup.json()).toMatchObject({ code: "IQ_CAPTURE_EXISTS" })
})

it("needs sourceId when several sources are configured", async () => {
	statuses = [status("a"), status("b")]
	const res = await app.inject({
		method: "POST",
		url,
		payload: { name: "x", seconds: 1 },
	})
	expect(res.statusCode).toBe(400)
	expect(res.json<{ fields: { field: string }[] }>().fields[0]?.field).toBe(
		"sourceId",
	)
	expect(
		(
			await app.inject({
				method: "POST",
				url,
				payload: { name: "x", seconds: 1, sourceId: "c" },
			})
		).statusCode,
	).toBe(404)
})

it("refuses unsupported and disconnected sources", async () => {
	statuses = [status("source", 3_200_001)]
	expect(
		(
			await app.inject({
				method: "POST",
				url,
				payload: { name: "x", seconds: 1 },
			})
		).json(),
	).toMatchObject({ code: "IQ_CAPTURE_UNSUPPORTED" })
	statuses = [{ ...status("source"), connected: false } as SourceStatus]
	expect(
		(
			await app.inject({
				method: "POST",
				url,
				payload: { name: "x", seconds: 1 },
			})
		).statusCode,
	).toBe(503)
})

it("admits the quota bytes exactly and refuses one byte past them", async () => {
	await app.inject({ method: "GET", url })
	for (let i = 0; i < 7; i++) await plant(`full-${i}`, IQ_CAPTURE_MAX_BYTES)
	// 7 × 64,000,000 + (64,000,000 − 2000) + the 2000-byte capture = 512,000,000.
	await plant("rest", IQ_CAPTURE_MAX_BYTES - 2000)
	const { pending } = await start()
	input.write(Buffer.alloc(2000))
	expect((await pending).statusCode).toBe(201)
	await rm(join(dir, "first.json"))
	await rm(join(dir, "first.cu8"))
	await rm(join(dir, "rest.json"))
	await plant("rest", IQ_CAPTURE_MAX_BYTES - 1999)
	const refused = await app.inject({
		method: "POST",
		url,
		payload: { name: "late", seconds: 1 },
	})
	expect(refused.statusCode).toBe(507)
	expect(refused.json()).toMatchObject({ code: "IQ_CAPTURE_QUOTA" })
	expect(await readdir(dir)).not.toContain("late.cu8.partial")
})

it("admits the capture count bound and refuses past it", async () => {
	await app.inject({ method: "GET", url })
	for (let i = 0; i < IQ_CAPTURES_MAX_COUNT - 1; i++) await plant(`c-${i}`, 2)
	const { pending } = await start()
	input.write(Buffer.alloc(2000))
	expect((await pending).statusCode).toBe(201)
	const refused = await app.inject({
		method: "POST",
		url,
		payload: { name: "late", seconds: 1 },
	})
	expect(refused.statusCode).toBe(507)
	expect(refused.json()).toMatchObject({ code: "IQ_CAPTURE_QUOTA" })
})

it("keeps the minimum free space: at the bound admitted, one byte short refused", async () => {
	available = IQ_CAPTURES_MIN_FREE_BYTES + 2000
	const { pending } = await start()
	input.write(Buffer.alloc(2000))
	expect((await pending).statusCode).toBe(201)
	available = IQ_CAPTURES_MIN_FREE_BYTES + 1999
	const refused = await app.inject({
		method: "POST",
		url,
		payload: { name: "late", seconds: 1 },
	})
	expect(refused.statusCode).toBe(507)
	expect(refused.json()).toMatchObject({ code: "IQ_CAPTURE_DISK_FULL" })
})

const settledDir = async () => {
	// Removal follows the file close; give the event loop a few turns.
	for (let i = 0; i < 50; i++) {
		const entries = await readdir(dir)
		if (entries.length === 0) return entries
		await delay(10)
	}
	return readdir(dir)
}

it.each(["caps-changed", "disconnected", "removed"])(
	"removes the partial file when the source reports %s",
	async event => {
		const { pending } = await start()
		input.write(Buffer.alloc(500))
		sources.emit(event, "source")
		const res = await pending
		expect(res.statusCode).toBe(503)
		expect(res.json()).toMatchObject({ code: "IQ_CAPTURE_INTERRUPTED" })
		expect(await settledDir()).toEqual([])
		expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)
	},
)

it("removes the partial file when a silent source times out", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
	try {
		const { pending } = await start()
		await vi.advanceTimersByTimeAsync(2000)
		vi.useRealTimers()
		expect((await pending).json()).toMatchObject({
			code: "IQ_CAPTURE_INTERRUPTED",
		})
		expect(await settledDir()).toEqual([])
	} finally {
		vi.useRealTimers()
	}
})

it("removes the partial file when the lease is revoked", async () => {
	const { pending } = await start()
	input.write(Buffer.alloc(500))
	invalidate?.()
	await pending.catch(() => undefined)
	expect(await settledDir()).toEqual([])
	expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)
	// The source slot is free again.
	const { pending: next } = await start({ name: "second", seconds: 1 })
	input.write(Buffer.alloc(2000))
	expect((await next).statusCode).toBe(201)
})

it("removes the partial file when the client disconnects", async () => {
	const address = await app.listen({ host: "127.0.0.1", port: 0 })
	const added = once(fanout, "branch-added")
	const client = request(`${address}${url}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		agent: false,
	})
	const response = new Promise<IncomingMessage | null>(resolve => {
		client.once("response", resolve)
		client.once("error", () => resolve(null))
	})
	client.end(JSON.stringify({ name: "first", seconds: 1 }))
	await added
	input.write(Buffer.alloc(500))
	client.destroy()
	await response
	expect(await settledDir()).toEqual([])
	expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)
})

it("removes the partial file on shutdown and partial files left by a crash", async () => {
	const { pending } = await start()
	input.write(Buffer.alloc(500))
	await app.close()
	expect((await pending).json()).toMatchObject({
		code: "IQ_CAPTURE_INTERRUPTED",
	})
	expect(await readdir(dir)).toEqual([])
	// A crash leaves a partial behind; the next process removes it at first use.
	await writeFile(join(dir, "crashed.cu8.partial"), Buffer.alloc(10))
	app = Fastify()
	await app.register(iqCaptureRoutes, options())
	await app.ready()
	expect((await app.inject({ method: "GET", url })).json()).toMatchObject({
		captures: [],
	})
	expect(await readdir(dir)).toEqual([])
})

it("removes data and metadata a crash left between rename and publication at first use", async () => {
	await app.inject({ method: "GET", url })
	for (let i = 0; i < 7; i++) await plant(`full-${i}`, IQ_CAPTURE_MAX_BYTES)
	await plant("rest", IQ_CAPTURE_MAX_BYTES - 2000)
	// The crash state: renamed data without metadata, a temp metadata file, and metadata
	// whose data is gone.
	await writeFile(join(dir, "first.cu8"), "")
	await truncate(join(dir, "first.cu8"), IQ_CAPTURE_MAX_BYTES)
	await writeFile(join(dir, "first.json.partial"), "{")
	await writeFile(
		join(dir, "lost.json"),
		(await readFile(join(dir, "rest.json"), "utf8")).replace(
			'"rest"',
			'"lost"',
		),
	)
	await rebuild()
	const listed = (await app.inject({ method: "GET", url })).json<{
		captures: IqCapture[]
	}>()
	expect(listed.captures.map(c => c.name).sort()).toEqual([
		"full-0",
		"full-1",
		"full-2",
		"full-3",
		"full-4",
		"full-5",
		"full-6",
		"rest",
	])
	expect((await readdir(dir)).sort()).toEqual(
		[...listed.captures.map(c => c.name)]
			.flatMap(name => [`${name}.cu8`, `${name}.json`])
			.sort(),
	)
	// The orphan name is free again, and the quota is exactly full with it stored:
	// 7 × 64,000,000 + (64,000,000 − 2000) + 2000 = 512,000,000.
	const { pending } = await start()
	input.write(Buffer.alloc(2000))
	expect((await pending).statusCode).toBe(201)
	const refused = await app.inject({
		method: "POST",
		url,
		payload: { name: "late", seconds: 1 },
	})
	expect(refused.statusCode).toBe(507)
	expect(refused.json()).toMatchObject({ code: "IQ_CAPTURE_QUOTA" })
})

it("ignores incomplete or foreign entries when listing", async () => {
	await app.inject({ method: "GET", url })
	await plant("good", 4, "2026-01-02T00:00:00.000Z")
	await plant("older", 4)
	await plant("short", 4)
	await truncate(join(dir, "short.cu8"), 3)
	await writeFile(join(dir, "bad.json"), "{not json")
	await writeFile(join(dir, "Foreign.json"), "{}")
	const body = (await app.inject({ method: "GET", url })).json<{
		captures: IqCapture[]
	}>()
	expect(body.captures.map(c => c.name)).toEqual(["good", "older"])
})

it("passes the access denial through on every route", async () => {
	denial = { kind: "deny", status: 401, code: "AUTH_REQUIRED", headers: {} }
	for (const [method, path] of [
		["POST", url],
		["GET", url],
		["GET", `${url}/first`],
		["DELETE", `${url}/first`],
	] as const) {
		const res = await app.inject({
			method,
			url: path,
			...(method === "POST" ? { payload: { name: "x", seconds: 1 } } : {}),
		})
		expect(res.statusCode).toBe(401)
		expect(res.json()).toEqual({ code: "AUTH_REQUIRED" })
	}
	expect(await readdir(dirname(dir))).toEqual([])
})

it("uses protected admission and CSRF authorization with the real access policy", async () => {
	const protectedApp = Fastify()
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: async () => {},
		monotonicNow: () => 123_457,
	})
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: ["receiver.invalid"],
		allowedOrigins: ["http://receiver.invalid"],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const access = installAccessHooks(protectedApp, { policy, sessions })
	await protectedApp.register(iqCaptureRoutes, { ...options(), access })
	try {
		const payload = { name: "first", seconds: 1 }
		const missing = await protectedApp.inject({
			method: "POST",
			url,
			payload,
			headers: { host: "receiver.invalid" },
		})
		expect(missing.statusCode).toBe(401)
		const anonymousList = await protectedApp.inject({
			method: "GET",
			url,
			headers: { host: "receiver.invalid" },
		})
		expect(anonymousList.statusCode).toBe(401)
		const created = await sessions.create()
		if (created.kind !== "created") throw new Error("Expected session")
		const forbidden = await protectedApp.inject({
			method: "POST",
			url,
			payload,
			headers: {
				host: "receiver.invalid",
				origin: "http://receiver.invalid",
				cookie: `wavekit_session=${created.cookieValue}`,
			},
		})
		expect(forbidden.statusCode).toBe(403)
		const headers = {
			host: "receiver.invalid",
			authorization: `Bearer ${token}`,
		}
		const added = once(fanout, "branch-added")
		const pending = protectedApp
			.inject({ method: "POST", url, payload, headers })
			.then(r => r)
		await added
		await Promise.resolve()
		input.write(Buffer.alloc(2000, 3))
		expect((await pending).statusCode).toBe(201)
		const file = await protectedApp.inject({
			method: "GET",
			url: `${url}/first`,
			headers,
		})
		expect(file.rawPayload).toEqual(Buffer.alloc(2000, 3))
		expect(
			(
				await protectedApp.inject({
					method: "DELETE",
					url: `${url}/first`,
					headers,
				})
			).statusCode,
		).toBe(204)
	} finally {
		await protectedApp.close()
	}
})

/** Two sources, each with its own fanout: `a` on the default fanout, `b` on its own. */
const twoSources = async (extra: Partial<IqCaptureOptions> = {}) => {
	const fanoutB = new FanoutManager(createLogger({ level: "fatal" }))
	const inputB = new PassThrough()
	fanoutB.attachSource(inputB)
	statuses = [status("a"), status("b")]
	await rebuild({
		fanoutFor: id => (id === "b" ? fanoutB : fanout),
		...extra,
	})
	return {
		fanoutB,
		inputB,
		dispose: () => {
			inputB.destroy()
			fanoutB.detachSource()
		},
	}
}

it.each(["flush", "close"])(
	"answers 503 and removes the partial file when the %s after the last chunk fails",
	async step => {
		// Created like the real stream (exclusive, private), failing the final flush or the close.
		const failing = (path: string) => {
			writeFileSync(path, "", { flag: "wx", mode: 0o600 })
			return new Writable({
				write: (_chunk, _encoding, callback) => callback(),
				final: callback =>
					callback(step === "flush" ? new Error("flush") : null),
				destroy: (err, callback) =>
					callback(err ?? (step === "close" ? new Error("close") : null)),
			})
		}
		await rebuild({ createPartial: failing })
		const { pending } = await start()
		input.write(Buffer.alloc(2000))
		const res = await pending
		expect(res.statusCode).toBe(503)
		expect(res.json()).toMatchObject({ code: "IQ_CAPTURES_UNAVAILABLE" })
		expect(await readdir(dir)).toEqual([])
		expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)
	},
)

it("removes the partial file when the lease is revoked after the final chunk", async () => {
	// The lease is revoked inside end(): the capture has already chosen to keep the file.
	await rebuild({
		createPartial: path => {
			const real = createWriteStream(path, { flags: "wx", mode: 0o600 })
			const end = real.end.bind(real)
			real.end = ((...args: Parameters<typeof end>) => {
				invalidate?.()
				return end(...args)
			}) as typeof real.end
			return real
		},
	})
	const { pending } = await start()
	input.write(Buffer.alloc(2000))
	await pending.catch(() => undefined)
	// Shutdown waits for every capture's commit or cleanup.
	await rebuild()
	expect(await readdir(dir)).toEqual([])
})

it("reserves free space across running captures on different sources", async () => {
	const { dispose } = await twoSources()
	try {
		available = IQ_CAPTURES_MIN_FREE_BYTES + 2000
		const { pending } = await start({
			name: "first",
			seconds: 1,
			sourceId: "a",
		})
		const refused = await app.inject({
			method: "POST",
			url,
			payload: { name: "second", seconds: 1, sourceId: "b" },
		})
		expect(refused.statusCode).toBe(507)
		expect(refused.json()).toMatchObject({ code: "IQ_CAPTURE_DISK_FULL" })
		input.write(Buffer.alloc(2000))
		expect((await pending).statusCode).toBe(201)
	} finally {
		dispose()
	}
})

it("admits against one consistent quota state while another capture completes", async () => {
	const { inputB, fanoutB, dispose } = await twoSources()
	try {
		await app.inject({ method: "GET", url })
		// 7 × 64,000,000 + (64,000,000 − 4000) = quota − 4000 stored.
		for (let i = 0; i < 7; i++) await plant(`full-${i}`, IQ_CAPTURE_MAX_BYTES)
		await plant("rest", IQ_CAPTURE_MAX_BYTES - 4000)
		// The 2000-byte capture on `a` runs: quota − 2000 counted.
		const { pending: first } = await start({
			name: "first",
			seconds: 1,
			sourceId: "a",
		})
		// The 4000-byte request on `b` stalls inside its listing.
		const listing = gate()
		const hold = gate()
		const list = IqCaptureStore.prototype.list
		vi.spyOn(IqCaptureStore.prototype, "list").mockImplementation(
			async function (this: IqCaptureStore) {
				const captures = await list.call(this)
				listing.open()
				await hold.opened
				return captures
			},
		)
		const second = app
			.inject({
				method: "POST",
				url,
				payload: { name: "second", seconds: 2, sourceId: "b" },
			})
			.then(r => r)
		await listing.opened
		// The first capture completes while the listing is pending; given time, it would
		// commit and release its reservation between the second request's reads.
		input.write(Buffer.alloc(2000))
		await Promise.race([first, delay(100)])
		hold.open()
		const refused = await second
		expect(refused.statusCode).toBe(507)
		expect(refused.json()).toMatchObject({ code: "IQ_CAPTURE_QUOTA" })
		expect((await first).statusCode).toBe(201)
		vi.restoreAllMocks()
		const body = (await app.inject({ method: "GET", url })).json<{
			usedBytes: number
		}>()
		expect(body.usedBytes).toBe(IQ_CAPTURES_QUOTA_BYTES - 2000)
		expect(fanoutB.getTelemetrySnapshot().branches).toHaveLength(0)
		inputB.end()
	} finally {
		dispose()
	}
})

it.each([
	["with", true],
	["without", false],
])(
	"refuses with 409 when the tuning changes during admission %s an event",
	async (_label, emit) => {
		const checking = gate()
		const hold = gate()
		await rebuild({
			availableBytes: async () => {
				checking.open()
				await hold.opened
				return available
			},
		})
		const pending = app
			.inject({ method: "POST", url, payload: { name: "first", seconds: 1 } })
			.then(r => r)
		await checking.opened
		statuses = [
			{
				...status("source"),
				caps: { ...status("source").caps, centerFreq: 101_000_000 },
			} as SourceStatus,
		]
		if (emit) sources.emit("caps-changed", "source")
		hold.open()
		const res = await pending
		expect(res.statusCode).toBe(409)
		expect(res.json()).toEqual({
			error: "Conflict",
			code: "IQ_CAPTURE_SOURCE_CHANGED",
			message: expect.any(String),
		})
		expect(res.body).not.toContain("101000000")
		expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)
		expect(await readdir(dir)).toEqual([])
		// The source slot and the name are free again.
		statuses = [status("source")]
		const { pending: next } = await start()
		input.write(Buffer.alloc(2000))
		expect((await next).json<IqCapture>().centerHz).toBe(100_000_000)
	},
)

it("interrupts when the tuning changed silently before the first sample", async () => {
	const { pending } = await start()
	statuses = [status("source", 2000)]
	input.write(Buffer.alloc(2000))
	const res = await pending
	expect(res.statusCode).toBe(503)
	expect(res.json()).toMatchObject({ code: "IQ_CAPTURE_INTERRUPTED" })
	await rebuild()
	expect(await readdir(dir)).toEqual([])
})

it("keeps unflushed bytes reserved against the free-space floor until the file acknowledges them", async () => {
	// Every write callback is held, so the capture's bytes are queued but not on disk.
	const held: (() => void)[] = []
	const holding = (path: string) => {
		writeFileSync(path, "", { flag: "wx", mode: 0o600 })
		return new Writable({
			write: (chunk: Buffer, _encoding, callback) => {
				held.push(() => {
					writeFileSync(path, chunk, { flag: "a" })
					callback()
				})
			},
		})
	}
	const { dispose } = await twoSources({ createPartial: holding })
	try {
		available = IQ_CAPTURES_MIN_FREE_BYTES + 2000
		const { pending } = await start({
			name: "first",
			seconds: 1,
			sourceId: "a",
		})
		input.write(Buffer.alloc(2000))
		while (held.length === 0) await delay(1)
		// statfs has not seen the 2000 bytes yet: a second 2000-byte capture breaches the floor.
		const refused = await app.inject({
			method: "POST",
			url,
			payload: { name: "second", seconds: 1, sourceId: "b" },
		})
		expect(refused.statusCode).toBe(507)
		expect(refused.json()).toMatchObject({ code: "IQ_CAPTURE_DISK_FULL" })
		for (const release of held.splice(0)) release()
		expect((await pending).statusCode).toBe(201)
	} finally {
		for (const release of held.splice(0)) release()
		dispose()
	}
})

it("removes a finished capture whose lease is revoked while its commit waits for the lock", async () => {
	let reads = 0
	const checking = gate()
	const hold = gate()
	const closing = gate()
	const { inputB, dispose } = await twoSources({
		availableBytes: async () => {
			// The second admission (source b) holds the lock inside its free-space read.
			if (++reads === 2) {
				checking.open()
				await hold.opened
			}
			return available
		},
		createPartial: path => {
			const real = createWriteStream(path, { flags: "wx", mode: 0o600 })
			if (path.includes("first")) real.once("close", closing.open)
			return real
		},
	})
	try {
		const { pending: first } = await start({
			name: "first",
			seconds: 1,
			sourceId: "a",
		})
		const revokeFirst = invalidate
		const second = app
			.inject({
				method: "POST",
				url,
				payload: { name: "second", seconds: 1, sourceId: "b" },
			})
			.then(r => r)
		await checking.opened
		input.write(Buffer.alloc(2000))
		await closing.opened
		// After the close the capture resolves and queues its commit behind the held admission.
		await new Promise(resolve => setImmediate(resolve))
		await delay(10)
		revokeFirst?.()
		hold.open()
		await first.catch(() => undefined)
		inputB.write(Buffer.alloc(2000))
		expect((await second).statusCode).toBe(201)
		const entries = await readdir(dir)
		expect(entries).not.toContain("first.cu8")
		expect(entries).not.toContain("first.json")
		expect(entries).not.toContain("first.cu8.partial")
	} finally {
		dispose()
	}
})

it("refuses a capture whose admission is still pending when shutdown starts", async () => {
	const checking = gate()
	const hold = gate()
	await rebuild({
		availableBytes: async () => {
			checking.open()
			await hold.opened
			return available
		},
	})
	const added = vi.fn()
	fanout.on("branch-added", added)
	const pending = app
		.inject({ method: "POST", url, payload: { name: "first", seconds: 1 } })
		.then(r => r)
	await checking.opened
	const closed = app.close()
	// Shutdown's abort snapshot is taken (no capture registered yet) while admission holds.
	await delay(20)
	hold.open()
	const res = await pending
	await closed
	expect(res.statusCode).toBe(503)
	expect(res.json()).toMatchObject({ code: "IQ_CAPTURES_UNAVAILABLE" })
	expect(added).not.toHaveBeenCalled()
	expect(await readdir(dir)).toEqual([])
	app = Fastify()
})

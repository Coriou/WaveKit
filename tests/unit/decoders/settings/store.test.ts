import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as nodeFs from "node:fs/promises"
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	DECODER_SETTINGS_FILE_MAX_BYTES,
	DECODER_SETTINGS_MAX_DECODERS,
	DECODER_SETTINGS_MAX_KEYS,
} from "@wavekit/api-types"
import type { DecoderSettingsFile } from "../../../../src/decoders/settings/contract.js"
import { DecoderSettingsError } from "../../../../src/decoders/settings/contract.js"
import {
	DECODER_SETTINGS_TMP_SWEEP_MAX,
	openDecoderSettingsStore,
	parseDecoderSettingsFile,
	seedDecoderSettingsRevision,
	serializeDecoderSettingsFile,
} from "../../../../src/decoders/settings/store.js"
import type { DecoderSettingsFs } from "../../../../src/decoders/settings/store.js"
import type { Logger } from "../../../../src/utils/logger.js"

const FILE = "decoder-settings.json"
const AT = "2026-10-16T10:00:00.000Z"
const NOW = 1_700_000_000_000
const now = (): number => NOW
let dir: string

function captureLogger(): {
	logger: Logger
	warn: ReturnType<typeof vi.fn>
	text: () => string
} {
	const calls: unknown[][] = []
	const record = (...args: unknown[]): void => {
		calls.push(args)
	}
	const warn = vi.fn(record)
	const logger: Record<string, unknown> = {
		warn,
		error: vi.fn(record),
		info: vi.fn(record),
		debug: vi.fn(record),
		trace: vi.fn(record),
		fatal: vi.fn(record),
	}
	logger["child"] = (bindings: unknown) => {
		calls.push([bindings])
		return logger
	}
	return {
		logger: logger as unknown as Logger,
		warn,
		text: () => JSON.stringify(calls),
	}
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wavekit-decset-"))
})
afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

function valid(revision = 3): DecoderSettingsFile {
	return {
		schemaVersion: 1,
		revision,
		decoders: {
			"ais-1": {
				type: "ais",
				enabled: false,
				options: {
					gain: 12.5,
					agc: true,
					mode: "fast",
					channels: ["A", "B"],
					freqs: [161975000, 162025000],
				},
				updatedAt: AT,
			},
			"adsb-1": { type: "adsb", options: {}, updatedAt: AT },
		},
	}
}

async function put(content: string | object): Promise<void> {
	await writeFile(
		join(dir, FILE),
		typeof content === "string" ? content : JSON.stringify(content),
	)
}

async function corruptCopies(): Promise<string[]> {
	return (await readdir(dir)).filter(name =>
		name.startsWith(`${FILE}.corrupt-`),
	)
}

async function open(fs?: DecoderSettingsFs) {
	const log = captureLogger()
	const store = await openDecoderSettingsStore({
		stateDir: dir,
		logger: log.logger,
		now,
		...(fs === undefined ? {} : { fs }),
	})
	return { store, log }
}

const seeded = seedDecoderSettingsRevision(NOW, undefined)

/** A valid file whose serialised form (store format) is exactly `target` bytes. */
function fileOfSize(target: number): DecoderSettingsFile {
	const file: DecoderSettingsFile = {
		schemaVersion: 1,
		revision: 1,
		decoders: {},
	}
	const size = (): number =>
		Buffer.byteLength(serializeDecoderSettingsFile(file))
	let entry = 0
	let options: Record<string, string | string[]> = {}
	const newEntry = (): void => {
		options = {}
		file.decoders[`d${entry++}`] = { type: "t", options, updatedAt: AT }
	}
	newEntry()
	let key = 0
	for (;;) {
		if (Object.keys(options).length >= DECODER_SETTINGS_MAX_KEYS) newEntry()
		const name = `k${key++}`
		if (target - size() > 20_000) {
			options[name] = Array<string>(64).fill("x".repeat(256))
			continue
		}
		options[name] = ""
		const remaining = target - size()
		if (remaining <= 256) {
			if (remaining < 0) throw new Error("overshoot")
			options[name] = "x".repeat(remaining)
			break
		}
		options[name] = "x".repeat(256)
		if (target - size() < 64) {
			options[name] = "x".repeat(128)
		}
	}
	expect(size()).toBe(target)
	return file
}

function entries(count: number): Record<string, object> {
	const out: Record<string, object> = {}
	for (let i = 0; i < count; i++)
		out[`d${i}`] = { type: "t", options: {}, updatedAt: AT }
	return out
}

function keys(count: number): Record<string, number> {
	const out: Record<string, number> = {}
	for (let i = 0; i < count; i++) out[`k${i}`] = i
	return out
}

describe("decoder settings store load", () => {
	it("missing file is revision 0 and empty", async () => {
		const { store, log } = await open()
		expect(store.revision()).toBe(0)
		expect(store.snapshot()).toEqual({
			schemaVersion: 1,
			revision: 0,
			decoders: {},
		})
		expect(log.warn).not.toHaveBeenCalled()
	})

	it("loads a valid file as is (deep-frozen)", async () => {
		await put(valid())
		const { store } = await open()
		expect(store.snapshot()).toEqual(valid())
		expect(Object.isFrozen(store.snapshot().decoders["ais-1"]?.options)).toBe(
			true,
		)
		expect(await corruptCopies()).toEqual([])
	})

	it("corrupt JSON quarantines and seeds", async () => {
		await put("{not json")
		const { store, log } = await open()
		expect(store.revision()).toBe(seeded)
		expect(store.snapshot().decoders).toEqual({})
		expect(await corruptCopies()).toEqual([`${FILE}.corrupt-${NOW}`])
		expect(log.warn).toHaveBeenCalledTimes(1)
	})

	const base = valid()
	const ais = base.decoders["ais-1"]
	const shapes: [string, unknown][] = [
		["schemaVersion 2", { ...base, schemaVersion: 2 }],
		["schemaVersion missing", { revision: 3, decoders: {} }],
		["revision negative", { ...base, revision: -1 }],
		["revision fraction", { ...base, revision: 1.5 }],
		["revision string", { ...base, revision: "3" }],
		["revision unsafe", { ...base, revision: 2 ** 53 }],
		["decoders array", { ...base, decoders: [] }],
		["decoders null", { ...base, decoders: null }],
		["extra top key", { ...base, extra: 1 }],
		["entry not object", { ...base, decoders: { a: 1 } }],
		["type empty", { ...base, decoders: { a: { ...ais, type: "" } } }],
		["type number", { ...base, decoders: { a: { ...ais, type: 3 } } }],
		[
			"type too long",
			{ ...base, decoders: { a: { ...ais, type: "t".repeat(65) } } },
		],
		[
			"enabled string",
			{ ...base, decoders: { a: { ...ais, enabled: "yes" } } },
		],
		["enabled null", { ...base, decoders: { a: { ...ais, enabled: null } } }],
		[
			"options missing",
			{ ...base, decoders: { a: { type: "t", updatedAt: AT } } },
		],
		[
			"option null",
			{ ...base, decoders: { a: { ...ais, options: { x: null } } } },
		],
		[
			"option object",
			{ ...base, decoders: { a: { ...ais, options: { x: {} } } } },
		],
		[
			"option mixed list",
			{ ...base, decoders: { a: { ...ais, options: { x: [1, "a"] } } } },
		],
		[
			"option nested list",
			{ ...base, decoders: { a: { ...ais, options: { x: [[1]] } } } },
		],
		[
			"option long string",
			{ ...base, decoders: { a: { ...ais, options: { x: "s".repeat(257) } } } },
		],
		[
			"option long list",
			{
				...base,
				decoders: { a: { ...ais, options: { x: Array(65).fill(1) } } },
			},
		],
		[
			"option empty key",
			{ ...base, decoders: { a: { ...ais, options: { "": 1 } } } },
		],
		[
			"updatedAt not ISO",
			{ ...base, decoders: { a: { ...ais, updatedAt: "yesterday" } } },
		],
		[
			"updatedAt missing",
			{ ...base, decoders: { a: { type: "t", options: {} } } },
		],
		["extra entry key", { ...base, decoders: { a: { ...ais, note: "x" } } }],
		["top-level array", [1]],
		["null", null],
	]
	it.each(shapes)("%s is corrupt", async (_name, content) => {
		await put(JSON.stringify(content))
		const { store } = await open()
		expect(store.snapshot().decoders).toEqual({})
		expect(store.revision()).toBeGreaterThanOrEqual(seeded)
		expect(await corruptCopies()).toHaveLength(1)
	})

	it("a 1e300 number literal and NaN-like text are corrupt", () => {
		expect(
			parseDecoderSettingsFile(
				'{"schemaVersion":1,"revision":0,"decoders":{"a":{"type":"t","options":{"x":1e999},"updatedAt":"' +
					AT +
					'"}}}',
			).corrupt,
		).toBe(true)
	})

	it.each(["__proto__", "constructor", "prototype"])(
		"prototype key %s as id or option key is corrupt",
		async key => {
			const asId = `{"schemaVersion":1,"revision":1,"decoders":{"${key}":{"type":"t","options":{},"updatedAt":"${AT}"}}}`
			const asKey = `{"schemaVersion":1,"revision":1,"decoders":{"a":{"type":"t","options":{"${key}":1},"updatedAt":"${AT}"}}}`
			expect(parseDecoderSettingsFile(asId)).toEqual({
				corrupt: true,
				lostRevision: 1,
			})
			expect(parseDecoderSettingsFile(asKey)).toEqual({
				corrupt: true,
				lostRevision: 1,
			})
			await put(asKey)
			const { store } = await open()
			expect(store.snapshot().decoders).toEqual({})
			expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined()
		},
	)

	it("a file of exactly 256 KiB is accepted, one byte more is corrupt", async () => {
		const text = JSON.stringify(valid())
		const exact =
			text +
			" ".repeat(DECODER_SETTINGS_FILE_MAX_BYTES - Buffer.byteLength(text))
		await put(exact)
		const first = await open()
		expect(first.store.snapshot()).toEqual(valid())
		await put(`${exact} `)
		const second = await open()
		expect(second.store.snapshot().decoders).toEqual({})
		expect(second.store.revision()).toBe(
			seedDecoderSettingsRevision(NOW, undefined),
		)
		expect(await corruptCopies()).toHaveLength(1)
	})

	it("256 entries load, 257 are corrupt", async () => {
		await put({
			schemaVersion: 1,
			revision: 1,
			decoders: entries(DECODER_SETTINGS_MAX_DECODERS),
		})
		expect(Object.keys((await open()).store.snapshot().decoders)).toHaveLength(
			256,
		)
		await put({
			schemaVersion: 1,
			revision: 1,
			decoders: entries(DECODER_SETTINGS_MAX_DECODERS + 1),
		})
		expect((await open()).store.snapshot().decoders).toEqual({})
	})

	it("64 keys load, 65 are corrupt", async () => {
		const at64 = {
			schemaVersion: 1,
			revision: 1,
			decoders: { a: { type: "t", options: keys(64), updatedAt: AT } },
		}
		await put(at64)
		expect(
			Object.keys((await open()).store.snapshot().decoders["a"]?.options ?? {}),
		).toHaveLength(64)
		await put({
			...at64,
			decoders: { a: { type: "t", options: keys(65), updatedAt: AT } },
		})
		expect((await open()).store.snapshot().decoders).toEqual({})
	})

	it("quarantine keeps one copy", async () => {
		await writeFile(join(dir, `${FILE}.corrupt-1`), "x")
		await writeFile(join(dir, `${FILE}.corrupt-2`), "y")
		await put("garbage")
		await open()
		expect(await corruptCopies()).toEqual([`${FILE}.corrupt-${NOW}`])
	})

	it("seeds above a readable lost revision", async () => {
		const lost = NOW * 1000 + 5_000
		await put({ ...valid(lost), schemaVersion: 9 })
		const { store } = await open()
		expect(store.revision()).toBe(lost + 1)
	})

	it("seeds now x 1000 without a readable revision", async () => {
		await put({ schemaVersion: 1, revision: "x", decoders: {} })
		expect((await open()).store.revision()).toBe(NOW * 1000)
	})

	it("a missing file with a quarantined copy left is seeded", async () => {
		const lost = NOW * 1000 + 7
		await writeFile(
			join(dir, `${FILE}.corrupt-5`),
			JSON.stringify({ revision: lost }),
		)
		expect((await open()).store.revision()).toBe(lost + 1)
	})

	it("sweeps stale tmp files within bounds", async () => {
		const old = new Date(Date.now() - 120_000)
		for (let i = 0; i < 20; i++) {
			const name = join(dir, `${FILE}.${900_000 + i}.tmp`)
			await writeFile(name, "x")
			await utimes(name, old, old)
		}
		const own = join(dir, `${FILE}.${process.pid}.tmp`)
		await writeFile(own, "x")
		await utimes(own, old, old)
		await writeFile(join(dir, `${FILE}.999999.tmp`), "fresh")
		await open()
		const left = (await readdir(dir)).filter(name => name.endsWith(".tmp"))
		expect(left).toHaveLength(20 - DECODER_SETTINGS_TMP_SWEEP_MAX + 2)
		expect(left).toContain(`${FILE}.${process.pid}.tmp`)
		expect(left).toContain(`${FILE}.999999.tmp`)
	})
})

describe("decoder settings store write", () => {
	it("round trips through the file", async () => {
		const { store } = await open()
		await store.write(valid(1))
		expect(store.revision()).toBe(1)
		expect(store.snapshot()).toEqual(valid(1))
		expect(JSON.parse(await readFile(join(dir, FILE), "utf8"))).toEqual(
			valid(1),
		)
		const again = await open()
		expect(again.store.snapshot()).toEqual(valid(1))
		expect((await readdir(dir)).filter(n => n.endsWith(".tmp"))).toEqual([])
	})

	it("serialises concurrent writes in call order", async () => {
		let first = true
		const fs: DecoderSettingsFs = {
			...nodeFs,
			readdir: (path: string) => nodeFs.readdir(path),
			open: (async (...args: Parameters<typeof nodeFs.open>) => {
				if (first && String(args[0]).endsWith(".tmp")) {
					first = false
					await new Promise(resolve => setTimeout(resolve, 50))
				}
				return nodeFs.open(...args)
			}) as typeof nodeFs.open,
		}
		const { store } = await open(fs)
		const done: number[] = []
		await Promise.all(
			[1, 2, 3, 4, 5].map(revision =>
				store.write(valid(revision)).then(() => done.push(revision)),
			),
		)
		expect(done).toEqual([1, 2, 3, 4, 5])
		expect(store.revision()).toBe(5)
		expect(JSON.parse(await readFile(join(dir, FILE), "utf8")).revision).toBe(5)
	})

	it("a failed rename leaves memory and file unchanged and does not poison the chain", async () => {
		let fail = false
		const fs: DecoderSettingsFs = {
			...nodeFs,
			readdir: (path: string) => nodeFs.readdir(path),
			rename: (async (...args: Parameters<typeof nodeFs.rename>) => {
				if (fail) {
					fail = false
					throw Object.assign(new Error(`EACCES ${dir}`), { code: "EACCES" })
				}
				return nodeFs.rename(...args)
			}) as typeof nodeFs.rename,
		}
		const { store, log } = await open(fs)
		await store.write(valid(1))
		const before = await readFile(join(dir, FILE), "utf8")
		fail = true
		const error = await store.write(valid(2)).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(DecoderSettingsError)
		expect((error as DecoderSettingsError).code).toBe(
			"DECODER_SETTINGS_STORE_UNAVAILABLE",
		)
		expect((error as DecoderSettingsError).message).not.toContain(dir)
		expect(store.revision()).toBe(1)
		expect(await readFile(join(dir, FILE), "utf8")).toBe(before)
		expect((await readdir(dir)).filter(n => n.endsWith(".tmp"))).toEqual([])
		await store.write(valid(3))
		expect(store.revision()).toBe(3)
		expect(log.text()).not.toContain(dir)
	})

	it("write bounds: at the limit accepted, one past refused with DECODER_SETTINGS_LIMIT", async () => {
		const { store } = await open()
		const limit = async (file: DecoderSettingsFile): Promise<void> => {
			const error = await store.write(file).catch((e: unknown) => e)
			expect(error).toBeInstanceOf(DecoderSettingsError)
			expect((error as DecoderSettingsError).code).toBe(
				"DECODER_SETTINGS_LIMIT",
			)
		}
		const big = fileOfSize(DECODER_SETTINGS_FILE_MAX_BYTES)
		await store.write(big)
		expect((await open()).store.snapshot()).toEqual(big)
		const over = fileOfSize(DECODER_SETTINGS_FILE_MAX_BYTES + 1)
		over.revision = 2
		await limit(over)
		expect(store.revision()).toBe(1)

		await store.write({
			schemaVersion: 1,
			revision: 3,
			decoders: entries(256) as DecoderSettingsFile["decoders"],
		})
		await limit({
			schemaVersion: 1,
			revision: 4,
			decoders: entries(257) as DecoderSettingsFile["decoders"],
		})
		const withKeys = (n: number, revision: number): DecoderSettingsFile => ({
			schemaVersion: 1,
			revision,
			decoders: { a: { type: "t", options: keys(n), updatedAt: AT } },
		})
		await store.write(withKeys(64, 5))
		await limit(withKeys(65, 6))
		expect(store.revision()).toBe(5)
	})

	it("refuses writes after close", async () => {
		const { store } = await open()
		await store.close()
		await expect(store.write(valid(1))).rejects.toMatchObject({
			code: "DECODER_SETTINGS_STORE_UNAVAILABLE",
		})
	})

	it("logs never carry the directory, ids, keys or values", async () => {
		const secret = "sekrit-value"
		await put({
			schemaVersion: 1,
			revision: 1,
			decoders: {
				"my-id": { type: "t", options: { mykey: secret }, updatedAt: "bad" },
			},
		})
		const { log } = await open()
		expect(log.warn).toHaveBeenCalled()
		const text = log.text()
		for (const forbidden of [dir, secret, "my-id", "mykey", FILE]) {
			expect(text).not.toContain(forbidden)
		}
	})
})

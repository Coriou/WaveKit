import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	RECORDING_INVENTORY_ID,
	RECORDING_KEEPS_FILE_MAX_BYTES,
	RECORDING_KEEPS_FILE_NAME,
	RECORDING_KEEPS_MAX_BYTES,
	RECORDING_KEEPS_MAX_ENTRIES,
} from "@wavekit/api-types"
import {
	RECORDING_KEEP_KEY,
	dsdFmeKeepKey,
	recordingKeepKeyOf,
	scannerKeepKey,
} from "../../../../src/core/recordings/contract.js"
import type {
	RecordingKeepKey,
	RecordingKeepsFile,
} from "../../../../src/core/recordings/contract.js"
import {
	openRecordingKeepStore,
	parseRecordingKeepsFile,
	serializeRecordingKeepsFile,
} from "../../../../src/core/recordings/keep-store.js"
import type { RecordingKeepsFs } from "../../../../src/core/recordings/keep-store.js"
import type { Logger } from "../../../../src/utils/logger.js"

const silent: Logger = (() => {
	const l: Record<string, unknown> = {}
	for (const k of ["warn", "info", "debug", "error", "trace", "fatal"])
		l[k] = () => undefined
	l["child"] = () => l
	return l as unknown as Logger
})()

/** A read-only in-memory fs holding one file at the store path (the load path only). */
function memFs(content: Buffer | null): RecordingKeepsFs {
	const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" })
	const fs = {
		open: async () => {
			if (content === null) throw enoent()
			const c = content
			return {
				stat: async () => ({ isFile: () => true, size: c.length }),
				read: async (buf: Buffer, off: number, len: number, pos: number) => {
					const n = Math.max(0, Math.min(len, c.length - pos))
					c.copy(buf, off, pos, pos + n)
					return { bytesRead: n }
				},
				close: async () => undefined,
			}
		},
		rename: async () => undefined,
		unlink: async () => undefined,
		readdir: async () => (content === null ? [] : [RECORDING_KEEPS_FILE_NAME]),
		lstat: async () => {
			throw enoent()
		},
		mkdir: async () => undefined,
	}
	return fs as unknown as RecordingKeepsFs
}

/** A writable in-memory fs (the store's write path: exclusive create, write, sync, rename). */
function writableMemFs(): RecordingKeepsFs & { files: Map<string, Buffer> } {
	const files = new Map<string, Buffer>()
	const err = (code: string) => Object.assign(new Error(code), { code })
	const fs = {
		files,
		open: async (p: string, flags: unknown) => {
			if (flags === "r")
				return { sync: async () => undefined, close: async () => undefined }
			if (flags === "wx") {
				if (files.has(p)) throw err("EEXIST")
				files.set(p, Buffer.alloc(0))
				return {
					writeFile: async (body: string) => {
						files.set(p, Buffer.from(body, "utf8"))
					},
					sync: async () => undefined,
					close: async () => undefined,
				}
			}
			const c = files.get(p)
			if (c === undefined) throw err("ENOENT")
			return {
				stat: async () => ({ isFile: () => true, size: c.length }),
				read: async (buf: Buffer, off: number, len: number, pos: number) => {
					const n = Math.max(0, Math.min(len, c.length - pos))
					c.copy(buf, off, pos, pos + n)
					return { bytesRead: n }
				},
				close: async () => undefined,
			}
		},
		rename: async (a: string, b: string) => {
			const c = files.get(a)
			if (c === undefined) throw err("ENOENT")
			files.delete(a)
			files.set(b, c)
		},
		unlink: async (p: string) => {
			if (!files.delete(p)) throw err("ENOENT")
		},
		readdir: async (dir: string) =>
			[...files.keys()]
				.filter(k => k.startsWith(`${dir}/`))
				.map(k => k.slice(dir.length + 1)),
		lstat: async () => {
			throw err("ENOENT")
		},
		mkdir: async () => undefined,
	}
	return fs as unknown as RecordingKeepsFs & { files: Map<string, Buffer> }
}

const callName = fc
	.tuple(
		fc.integer({ min: 0, max: 99_999_999 }),
		fc.integer({ min: 0, max: 999_999 }),
		fc.integer({ min: 0, max: 99_999 }),
		fc.stringMatching(/^[A-Za-z0-9_.-]{1,40}$/),
	)
	.map(
		([d, t, r, rest]) =>
			`${String(d).padStart(8, "0")}_${String(t).padStart(6, "0")}_${String(r).padStart(5, "0")}_${rest}.wav`,
	)
const scanKey = fc
	.tuple(
		fc.stringMatching(/^[0-9A-Za-z]{1,26}$/),
		fc.stringMatching(/^[A-Za-z0-9_.-]{1,40}$/),
	)
	.map(([d, n]) => `scan:d_${d}~${n}.wav`)
const validKey = fc.oneof(
	callName.map(n => `dsd~${n}`),
	scanKey,
) as fc.Arbitrary<RecordingKeepKey>

const validFile: fc.Arbitrary<RecordingKeepsFile> = fc
	.record({
		revision: fc.nat(),
		keys: fc.uniqueArray(validKey, { maxLength: 40 }),
		bytes: fc.array(
			fc.nat({ max: Math.floor(RECORDING_KEEPS_MAX_BYTES / 40) }),
			{
				minLength: 40,
				maxLength: 40,
			},
		),
		time: fc.integer({ min: 0, max: 4_102_444_800_000 }),
	})
	.map(({ revision, keys, bytes, time }) => ({
		schemaVersion: 1 as const,
		revision,
		keeps: keys.map((key, i) => ({
			key,
			keptAt: new Date(time).toISOString(),
			bytes: bytes[i] ?? 0,
		})),
	}))

/** 2001 valid entries (computed once: the bound is a constant, not a random input). */
const OVER_ENTRIES_TEXT = serializeRecordingKeepsFile({
	schemaVersion: 1,
	revision: 1,
	keeps: Array.from({ length: RECORDING_KEEPS_MAX_ENTRIES + 1 }, (_, i) => ({
		key: `dsd~20261016_120000_00000_${i}.wav` as RecordingKeepKey,
		keptAt: "2026-10-17T00:00:00.000Z",
		bytes: 0,
	})),
})

describe("recording keep properties", () => {
	it(
		"round trips every valid file through store.write and a reload",
		{ timeout: 20_000 },
		async () => {
			// Feature: web-gaps-9, Property 3: keep store round trip and fail closed
			// Validates: Requirements 2.3, 2.4
			await fc.assert(
				fc.asyncProperty(validFile, validFile, async (first, second) => {
					const fs = writableMemFs()
					const a = await openRecordingKeepStore({
						stateDir: "/state",
						log: silent,
						fs,
					})
					expect(a.state()).toBe("ready")
					expect(a.snapshot().revision).toBe(0)
					await a.write(first)
					expect(a.snapshot()).toEqual(first)
					await a.write(second)
					expect(a.snapshot()).toEqual(second)
					await a.close()
					// Only the store file is left (no tmp), and a reload yields what was written.
					expect([...fs.files.keys()]).toEqual([
						`/state/${RECORDING_KEEPS_FILE_NAME}`,
					])
					const b = await openRecordingKeepStore({
						stateDir: "/state",
						log: silent,
						fs,
					})
					expect(b.state()).toBe("ready")
					expect(b.snapshot()).toEqual(second)
					await b.close()
				}),
				{ numRuns: 100 },
			)
		},
	)

	it(
		"round trips every valid file and fails closed on every corruption",
		{ timeout: 20_000 },
		async () => {
			// Feature: web-gaps-9, Property 3: keep store round trip and fail closed
			// Validates: Requirements 2.3, 2.4
			await fc.assert(
				fc.asyncProperty(
					validFile,
					fc.oneof(
						fc.constant({ t: "none" as const }),
						fc.record({
							t: fc.constant("truncate" as const),
							at: fc.nat(),
						}),
						fc.record({
							t: fc.constant("flip" as const),
							at: fc.nat(),
							byte: fc.integer({ min: 0, max: 255 }),
						}),
						fc.record({
							t: fc.constant("duplicate" as const),
						}),
						fc.record({
							t: fc.constant("pathKey" as const),
							key: fc.oneof(
								fc.constantFrom(
									"../x.wav",
									"/etc/passwd",
									"dsd~../../etc/passwd",
									"scan:d_x~../y.wav",
									"scan:d_x/../d_y~z.wav",
								),
								fc.string().map(s => `dsd~${s}/x.wav`),
							),
						}),
						fc.record({ t: fc.constant("overBytes" as const) }),
						fc.record({ t: fc.constant("overEntries" as const) }),
						fc.record({ t: fc.constant("overSize" as const) }),
					),
					async (file, c) => {
						let text = serializeRecordingKeepsFile(file)
						let mustFail = false
						switch (c.t) {
							case "none":
								break
							case "truncate": {
								const at = c.at % Math.max(1, text.length - 2)
								text = text.slice(0, at)
								mustFail = true
								break
							}
							case "flip": {
								const b = Buffer.from(text)
								const at = c.at % b.length
								b[at] = c.byte
								text = b.toString("latin1")
								// A flip may still yield a valid file (whitespace, a digit): checked below.
								break
							}
							case "duplicate": {
								const first = file.keeps[0]
								if (!first) return
								text = serializeRecordingKeepsFile({
									...file,
									keeps: [...file.keeps, first],
								})
								mustFail = true
								break
							}
							case "pathKey":
								text = serializeRecordingKeepsFile({
									...file,
									keeps: [
										...file.keeps,
										{
											key: c.key as RecordingKeepKey,
											keptAt: "2026-10-17T00:00:00.000Z",
											bytes: 0,
										},
									],
								})
								mustFail = true
								break
							case "overBytes":
								text = serializeRecordingKeepsFile({
									...file,
									keeps: [
										...file.keeps.slice(1),
										{
											key: "dsd~20261016_120000_00000_over.wav" as RecordingKeepKey,
											keptAt: "2026-10-17T00:00:00.000Z",
											bytes: RECORDING_KEEPS_MAX_BYTES + 1,
										},
									],
								})
								mustFail = true
								break
							case "overEntries":
								text = OVER_ENTRIES_TEXT
								mustFail = true
								break
							case "overSize":
								text =
									text +
									" ".repeat(
										RECORDING_KEEPS_FILE_MAX_BYTES +
											1 -
											Buffer.byteLength(text),
									)
								mustFail = true
								break
						}
						const parsed = parseRecordingKeepsFile(text)
						const store = await openRecordingKeepStore({
							stateDir: "/state",
							log: silent,
							fs: memFs(Buffer.from(text)),
						})
						if (c.t === "none") {
							expect(parsed).toEqual(file)
							expect(store.state()).toBe("ready")
							expect(store.snapshot()).toEqual(file)
							return
						}
						if (mustFail) expect(parsed).toBeNull()
						if (parsed === null) {
							expect(store.state()).toBe("failed")
							expect(store.snapshot().keeps).toEqual([])
						} else {
							// Whatever loads is a fully valid file within every bound.
							expect(store.state()).toBe("ready")
							expect(parsed.keeps.length).toBeLessThanOrEqual(
								RECORDING_KEEPS_MAX_ENTRIES,
							)
							expect(new Set(parsed.keeps.map(e => e.key)).size).toBe(
								parsed.keeps.length,
							)
							for (const e of parsed.keeps)
								expect(RECORDING_KEEP_KEY.test(e.key)).toBe(true)
							expect(
								parsed.keeps.reduce((n, e) => n + e.bytes, 0),
							).toBeLessThanOrEqual(RECORDING_KEEPS_MAX_BYTES)
						}
					},
				),
				{ numRuns: 200 },
			)
			const missing = await openRecordingKeepStore({
				stateDir: "/state",
				log: silent,
				fs: memFs(null),
			})
			expect(missing.state()).toBe("ready")
			expect(missing.snapshot().revision).toBe(0)
		},
	)

	it(
		"keys are never paths, and the inventory id maps to a key without its dsd index",
		{ timeout: 20_000 },
		() => {
			// Feature: web-gaps-9, Property 5: keep keys are never paths
			// Validates: Requirements 2.2, 2.9
			const hostile = fc.oneof(
				fc.string(),
				fc.string({ unit: "binary" }),
				fc
					.array(
						fc.constantFrom(
							"..",
							".",
							"/",
							"\\",
							"~",
							"%2F",
							"\0",
							"a",
							"d_x",
							".wav",
							"dsd:",
							"scan:",
							"_",
						),
						{
							maxLength: 12,
						},
					)
					.map(parts => parts.join("")),
				callName,
				callName.map(n => `../${n}`),
				callName.map(n => `${n}/../x.wav`),
			)
			/** A key is safe when it matches the grammar and carries no separator or NUL. */
			const safeKey = (k: string): boolean =>
				RECORDING_KEEP_KEY.test(k) &&
				!k.includes("/") &&
				!k.includes("\\") &&
				!k.includes("\0") &&
				// the file part ends in ".wav": it is never "." nor ".."
				k.endsWith(".wav")
			fc.assert(
				fc.property(hostile, hostile, fc.nat({ max: 9999 }), (a, b, n) => {
					const keys = [
						dsdFmeKeepKey(a),
						scannerKeepKey(a, b),
						scannerKeepKey(`d_${a}`, b),
						recordingKeepKeyOf(a),
						recordingKeepKeyOf(`dsd:${n}~${a}`),
						recordingKeepKeyOf(`scan:d_${a}~${b}`),
					]
					for (const k of keys) if (k !== null && !safeKey(k)) return false
					const id = `dsd:${n}~${a}`
					if (RECORDING_INVENTORY_ID.test(id)) {
						// The dsd index is not part of the key.
						const k0 = recordingKeepKeyOf(`dsd:0~${a}`)
						return recordingKeepKeyOf(id) === k0 && k0 === dsdFmeKeepKey(a)
					}
					return true
				}),
				{ numRuns: 200 },
			)
			fc.assert(
				fc.property(
					callName,
					fc.nat({ max: 9999 }),
					fc.nat({ max: 9999 }),
					(name, i, j) =>
						recordingKeepKeyOf(`dsd:${i}~${name}`) === `dsd~${name}` &&
						recordingKeepKeyOf(`dsd:${j}~${name}`) === `dsd~${name}`,
				),
				{ numRuns: 200 },
			)
		},
	)
})

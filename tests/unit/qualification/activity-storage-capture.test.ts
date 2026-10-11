import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import nodeFs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { PassThrough } from "node:stream"
import { pathToFileURL } from "node:url"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"

const source = resolve("scripts/qualification/activity-storage")
interface Config {
	scenario: string
	seed?: number
	reserveBytes?: number
	deadlineMs?: number
	phase?: string
	resourceWindow?: string
	output?: string
	captureReservation?: string
}
interface Owned {
	path: string
	output: string
	config: Config
	reservation: Record<string, unknown>
	spawned?: boolean
	verify: () => void
	files: {
		name: string
		path: string
		fd: number
		info: fs.Stats
		closed: boolean
	}[]
}
interface State {
	cap: number
	read: number
	stored: number
	discarded: number
	truncated: boolean
	failed: boolean
	hash: ReturnType<typeof createHash>
}
interface StreamResult extends Omit<State, "hash"> {
	name: string
	closed: boolean
	eof: boolean
	busy: boolean
	sha256: string | null
}
interface Supervision {
	reason: string | null
	joined: boolean
	writersSettled: boolean
	exitCode: number | null
	childElapsedMs: number
	terminationMs: number
	streams: StreamResult[]
	metrics: Record<string, unknown>
}
interface Summary {
	outcome: string
	reason: string | null
	path: string | null
	finalManifestPersisted: boolean
	joined: boolean
	qualificationClaim: boolean
	accounting: {
		totalBytes: number | null
		captureReservedBytes: number
		settled: boolean
	} | null
}
class Child extends EventEmitter {
	pid = 4242
	stdout = new PassThrough({ highWaterMark: 16384 })
	stderr = new PassThrough({ highWaterMark: 16384 })
	finish(code = 0) {
		this.stdout.end()
		this.stderr.end()
		this.emit("exit", code, null)
		let remaining = 2
		const closed = () => {
			if (--remaining === 0) this.emit("close", code, null)
		}
		this.stdout.once("close", closed)
		this.stderr.once("close", closed)
	}
}
type Writer = (
	buffer: Buffer,
	offset: number,
	length: number,
) => number | Promise<number>
interface Options {
	now?: () => number
	signal?: AbortSignal
	kill?: (pid: number, signal: string) => void
	sample?: () => {
		captureRss: number
		captureCpu?: { user: number; system: number }
		driverRss?: number | null
		driverCpu?: number | null
	}
}
const consumer = (await import(
	pathToFileURL(join(source, "capture.mjs")).href
)) as {
	emitSummary: (
		summary: Record<string, unknown>,
		options: { write: (text: string) => boolean; exit: (code: number) => void },
	) => void
	CAPS: Record<string, number>
	lexicalJSON: (
		bytes: Buffer,
		check?: () => void,
	) => {
		text: string
		values: number
		properties: number
		keyUnits: number
		stringUnits: number
	}
	parseBoundedJSON: (
		bytes: Buffer,
		check?: () => void,
	) => { report: unknown; accounting: Record<string, unknown> }
	terminalLatch: () => {
		assign: (value: string) => boolean
		value: () => string | null
	}
	writeChunk: (
		state: State,
		bytes: Buffer,
		write: Writer,
		abort: (reason: string) => void,
	) => Promise<void>
	superviseChild: (
		factory: () => Child,
		writers: Record<string, Writer>,
		options?: Options,
	) => Promise<Supervision>
	prepareCapture: (
		config: Config,
		root: string,
		statfs: () => unknown,
		check?: () => void,
		runId?: string,
	) => Owned
	closeOwned: (owned: Owned) => void
	cleanupPreSpawn: (owned: Owned) => void
	writeManifest: (owned: Owned, manifest: unknown, check?: () => void) => number
	hashOwned: (
		path: string,
		expected: fs.Stats,
		cap: number,
		check?: () => void,
		collect?: boolean,
	) => { size: number; sha256: string }
	inspectDriver: (
		owned: Owned,
		check?: () => void,
	) => { bytes: number; files: unknown[] }
	unionAccounting: (
		capture: number,
		driver: number | null,
		settled: boolean,
	) => {
		totalBytes: number | null
		captureReservedBytes: number
		settled: boolean
	}
	fixedLaunch: (config: Config) => {
		executable: string
		args: string[]
		options: Record<string, unknown>
	}
	captureArgs: (args: string[]) => Config
	validateReport: (
		report: unknown,
		config: Config,
		reservation: Record<string, unknown>,
		exit: number,
		hashes: Record<string, string>,
	) => string
	capture: (
		config: Config,
		options: Options & {
			root: string
			statfs: () => unknown
			spawnChild: (
				exec: string,
				args: string[],
				options: Record<string, unknown>,
			) => Child
			hashSource: (path: string) => string
			write?: typeof fs.writeSync
			manifestWriter?: (
				owned: Owned,
				manifest: unknown,
				check?: () => void,
			) => number
		},
	) => Promise<Summary>
}
const driver = (await import(pathToFileURL(join(source, "run.mjs")).href)) as {
	parseArgs: (args: string[]) => Config
	verifyCaptureReservation: (
		config: Config,
		root: string,
	) => Record<string, unknown> | null
	run: (
		config: Config,
		options?: {
			root?: string
			statfs?: () => unknown
			workerFactory?: () => unknown
		},
	) => Promise<Record<string, unknown>>
}
const GiB = 1024 ** 3
const free = () => ({ bavail: BigInt(100 * GiB), bsize: 1n })
const roots: string[] = []
const ownedFiles: Owned[] = []
function root() {
	const path = fs.realpathSync(
		fs.mkdtempSync(join(tmpdir(), "activity-capture-test-")),
	)
	roots.push(path)
	return path
}
function owned(config: Config = { scenario: "disabled", reserveBytes: GiB }) {
	const path = root()
	const value = consumer.prepareCapture(config, path, free)
	ownedFiles.push(value)
	return { value, root: path }
}
function state(cap: number): State {
	return {
		cap,
		read: 0,
		stored: 0,
		discarded: 0,
		truncated: false,
		failed: false,
		hash: createHash("sha256"),
	}
}
const normalSample = () => ({
	captureRss: 1,
	captureCpu: { user: 0, system: 0 },
	driverRss: null,
	driverCpu: null,
})
const writers = () => ({
	stdout: vi.fn<Writer>((_buffer, _offset, length) => length),
	stderr: vi.fn<Writer>((_buffer, _offset, length) => length),
})
const flush = async () => {
	for (let i = 0; i < 8; i++)
		await new Promise<void>(resolveResult => setImmediate(resolveResult))
}
function readManifest(path: string) {
	return JSON.parse(
		fs.readFileSync(join(path, "manifest.json"), "utf8"),
	) as Record<string, unknown>
}
afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	syncBuiltinESMExports()
	for (const value of ownedFiles.splice(0)) consumer.closeOwned(value)
	// Test-owned temp roots only; consumer itself never recursively deletes.
	for (const path of roots.splice(0))
		fs.rmSync(path, { recursive: true, force: true })
})

describe("bounded lexical admission before one JSON parse", () => {
	it("accepts legal primitives, escapes, multibyte strings and surrogate pairs", () => {
		const text =
			'{"x":[true,false,null,-0,1e+20,"é😀\\n\\uD83D\\uDE00"],"\\u0061":{}}\n'
		expect(consumer.parseBoundedJSON(Buffer.from(text)).report).toEqual(
			JSON.parse(text) as unknown,
		)
		expect(consumer.lexicalJSON(Buffer.from(text))).toMatchObject({
			values: 9,
			properties: 2,
		})
		const check = vi.fn()
		consumer.lexicalJSON(Buffer.from('{"x":"' + "é".repeat(4096) + '"}'), check)
		expect(check.mock.calls.length).toBeGreaterThanOrEqual(3)
	})
	it.each([
		"",
		"[]",
		"null",
		"{}{}",
		"{} x",
		"{}\ufeff",
		"\ufeff{}",
		'{"x":01}',
		'{"x":+1}',
		'{"x":.1}',
		'{"x":1.}',
		'{"x":NaN}',
		'{"x":true,}',
		'{"x":[1,]}',
		'{"x":"\\q"}',
		'{"x":"\\u000x"}',
		'{"x":"\\ud800"}',
		'{"x":"\\udc00"}',
		'{"x":"\\ud800a"}',
		'{"x":"\n"}',
		'{"a":1,"a":2}',
		'{"a":1,"\\u0061":2}',
		'{"\\uD83D\\uDE00":1,"😀":2}',
		'{"x":' + "1".repeat(65) + "}",
	])("rejects invalid/duplicate/trailing document %s", text => {
		expect(() => consumer.parseBoundedJSON(Buffer.from(text))).toThrow()
	})
	it.each([
		Buffer.from([123, 34, 120, 34, 58, 34, 0xc0, 0xaf, 34, 125]),
		Buffer.from([123, 34, 120, 34, 58, 34, 0xed, 0xa0, 0x80, 34, 125]),
		Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125]),
	])("denies invalid UTF-8 without replacement", bytes => {
		expect(() => consumer.lexicalJSON(bytes)).toThrow()
	})
	it("checks exact depth, array, object, string and number boundaries", () => {
		const nested = (n: number) =>
			'{"x":'.repeat(n - 1) + "{}" + "}".repeat(n - 1)
		expect(() => consumer.lexicalJSON(Buffer.from(nested(16)))).not.toThrow()
		expect(() => consumer.lexicalJSON(Buffer.from(nested(17)))).toThrow()
		const array = (n: number) =>
			'{"x":[' + Array<string>(n).fill("0").join() + "]}"
		expect(() => consumer.lexicalJSON(Buffer.from(array(2048)))).not.toThrow()
		expect(() => consumer.lexicalJSON(Buffer.from(array(2049)))).toThrow()
		const props = (n: number) =>
			"{" + Array.from({ length: n }, (_, i) => `"k${i}":0`).join() + "}"
		expect(() => consumer.lexicalJSON(Buffer.from(props(256)))).not.toThrow()
		expect(() => consumer.lexicalJSON(Buffer.from(props(257)))).toThrow()
		expect(() =>
			consumer.lexicalJSON(Buffer.from('{"x":"' + "x".repeat(4096) + '"}')),
		).not.toThrow()
		expect(() =>
			consumer.lexicalJSON(Buffer.from('{"x":"' + "x".repeat(4097) + '"}')),
		).toThrow()
		expect(() =>
			consumer.lexicalJSON(Buffer.from('{"x":' + "1".repeat(64) + "}")),
		).not.toThrow()
	})
	it("rejects raw/aggregate allocation caps before JSON.parse", () => {
		const parse = vi.spyOn(JSON, "parse")
		const many = '{"x":[' + "{},".repeat(349000).slice(0, -1) + "]}"
		const under = '{"x":[' + "{},".repeat(300000).slice(0, -1) + "]}"
		const aggregate =
			'{"x":[' +
			Array<string>(65)
				.fill('"' + "x".repeat(4096) + '"')
				.join() +
			"]}"
		for (const text of [many, under, aggregate, " ".repeat(1024 ** 2 + 1)])
			expect(() => consumer.parseBoundedJSON(Buffer.from(text))).toThrow()
		expect(parse).not.toHaveBeenCalled()
		consumer.parseBoundedJSON(Buffer.from("{}"))
		expect(parse).toHaveBeenCalledTimes(1)
	})
	it("bounds total values and properties across individually legal containers", () => {
		const props = (n: number) =>
			"{" + Array.from({ length: n }, (_, i) => `"k${i}":0`).join() + "}"
		// 1 top-level property plus 4095 inner properties fits exactly 4096.
		const exact =
			'{"x":[' +
			[...Array<string>(15).fill(props(256)), props(255)].join() +
			"]}"
		expect(consumer.lexicalJSON(Buffer.from(exact)).properties).toBe(4096)
		expect(() =>
			consumer.lexicalJSON(Buffer.from(exact.replace(props(255), props(256)))),
		).toThrow()
		const values = (n: number) =>
			'{"x":[' +
			Array.from(
				{ length: 4 },
				(_, i) =>
					"[" +
					Array<string>(i === 3 ? n : 2048)
						.fill("0")
						.join() +
					"]",
			).join() +
			"]}"
		// root, outer array, four inner arrays + 8186 scalars = 8192.
		expect(consumer.lexicalJSON(Buffer.from(values(2042))).values).toBe(8192)
		expect(() => consumer.lexicalJSON(Buffer.from(values(2043)))).toThrow()
	})
	it("bounds aggregate decoded keys and string values at limit and limit+1", () => {
		const keys = Array.from({ length: 32 }, (_, i) =>
			String(i).padEnd(4096, "x"),
		)
		const text = "{" + keys.map(key => JSON.stringify(key) + ":0").join() + "}"
		expect(consumer.lexicalJSON(Buffer.from(text)).keyUnits).toBe(131072)
		expect(() =>
			consumer.lexicalJSON(Buffer.from(text.slice(0, -1) + ',"z":0}')),
		).toThrow()
		const strings =
			'{"x":[' +
			Array<string>(64)
				.fill('"' + "x".repeat(4096) + '"')
				.join() +
			"]}"
		expect(consumer.lexicalJSON(Buffer.from(strings)).stringUnits).toBe(262144)
		expect(() =>
			consumer.lexicalJSON(Buffer.from(strings.replace("]}", ',"x"]}'))),
		).toThrow()
	})
	it("honors a verification deadline during a long bounded string scan", () => {
		let checks = 0
		expect(() =>
			consumer.lexicalJSON(
				Buffer.from(
					'{"x":[' +
						Array<string>(32)
							.fill('"' + "x".repeat(4096) + '"')
							.join() +
						"]}",
				),
				() => {
					if (++checks === 3) throw new Error("deadline")
				},
			),
		).toThrow("deadline")
	})
})

describe("partial byte writes and independent conservation", () => {
	it("stores exactly cap, rejects cap+1 before write and counts raw multibyte bytes", async () => {
		const value = state(5)
		const bytes = Buffer.from("é😀")
		const output: Buffer[] = []
		const abort = vi.fn()
		await consumer.writeChunk(
			value,
			bytes,
			(chunk, offset, length) => {
				const n = Math.min(2, length)
				output.push(Buffer.from(chunk.subarray(offset, offset + n)))
				return n
			},
			abort,
		)
		expect(value).toMatchObject({
			read: 6,
			stored: 5,
			discarded: 1,
			truncated: true,
		})
		expect(Buffer.concat(output)).toEqual(bytes.subarray(0, 5))
		expect(abort).toHaveBeenCalledTimes(1)
		const write = vi.fn<Writer>((_chunk, _offset, length) => length)
		await consumer.writeChunk(value, Buffer.from("extra"), write, abort)
		expect(write).not.toHaveBeenCalled()
		const exact = state(6)
		await consumer.writeChunk(exact, bytes, write, abort)
		expect(exact.truncated).toBe(false)
	})
	it.each(["zero", "ENOSPC", "invalid"])(
		"aborts on %s without retry/busy-loop",
		async kind => {
			const value = state(100)
			let calls = 0
			const abort = vi.fn()
			await consumer.writeChunk(
				value,
				Buffer.from("abcdef"),
				(_chunk, _offset, length) => {
					if (++calls === 1) return 2
					if (kind === "ENOSPC")
						throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })
					return kind === "zero" ? 0 : length + 1
				},
				abort,
			)
			expect(calls).toBe(2)
			expect(value).toMatchObject({
				read: 6,
				stored: 2,
				discarded: 4,
				failed: true,
			})
			expect(abort).toHaveBeenCalledTimes(1)
		},
	)
	it("conserves generated bytes over 100 bounded short-write/cap traces", async () => {
		// Feature: activity-recording-catalog, Property 8: Accounting conservation
		// Validates: Requirements 5.4, 5.5, 7.2
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.uint8Array({ maxLength: 1024 }), { maxLength: 20 }),
				fc.integer({ min: 0, max: 8192 }),
				fc.integer({ min: 1, max: 256 }),
				async (chunks, cap, partial) => {
					const value = state(cap)
					const output: Buffer[] = []
					const input = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
					for (const bytes of chunks)
						await consumer.writeChunk(
							value,
							Buffer.from(bytes),
							(chunk, offset, length) => {
								const n = Math.min(length, partial)
								output.push(Buffer.from(chunk.subarray(offset, offset + n)))
								return n
							},
							() => {},
						)
					expect(value.stored + value.discarded).toBe(input.length)
					expect(value.read).toBe(input.length)
					expect(value.stored).toBeLessThanOrEqual(cap)
					expect(Buffer.concat(output)).toEqual(input.subarray(0, cap))
				},
			),
			{ numRuns: 100, seed: 42 },
		)
	})
	it("assigns only the independent first terminal across 100 racing event schedules", () => {
		// Feature: activity-recording-catalog, Property 5: Bounded failure
		// Validates: Requirements 2.3, 7.2
		fc.assert(
			fc.property(
				fc.array(
					fc.constantFrom("cap", "cancel", "timeout", "exit", "ENOSPC"),
					{ minLength: 1, maxLength: 30 },
				),
				events => {
					const latch = consumer.terminalLatch()
					let assignments = 0
					for (const event of events) if (latch.assign(event)) assignments++
					expect(assignments).toBe(1)
					expect(latch.value()).toBe(events[0])
				},
			),
			{ numRuns: 100, seed: 42 },
		)
	})
})

describe("POSIX root and pipe ownership under virtual deadlines", () => {
	it("keeps root-exit buffered output until EOF and completes only after pipes close", async () => {
		const child = new Child()
		const sink = writers()
		let resolved = false
		const pending = consumer
			.superviseChild(() => child, sink, { sample: normalSample })
			.then(value => {
				resolved = true
				return value
			})
		child.stdout.write(Buffer.from("final"))
		child.emit("exit", 0, null)
		await flush()
		expect(resolved).toBe(false)
		expect(sink.stdout).toHaveBeenCalled()
		child.finish()
		const result = await pending
		expect(result).toMatchObject({
			reason: null,
			joined: true,
			writersSettled: true,
			exitCode: 0,
		})
		expect(result.streams[0]).toMatchObject({
			stored: 5,
			eof: true,
			closed: true,
		})
	})
	it.each(["cancel", "deadline", "write"])(
		"sends TERM once/KILL after 100ms on %s and never equates signals with join",
		async kind => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
			const child = new Child()
			const controller = new AbortController()
			const kill = vi.fn()
			const sink = writers()
			if (kind === "write") sink.stdout.mockImplementation(() => 0)
			const pending = consumer.superviseChild(() => child, sink, {
				now: Date.now,
				signal: controller.signal,
				kill,
				sample: normalSample,
			})
			if (kind === "cancel") controller.abort()
			else if (kind === "deadline") await vi.advanceTimersByTimeAsync(1200000)
			else {
				child.stdout.write(Buffer.from("fail"))
				await flush()
			}
			expect(kill.mock.calls).toEqual([[4242, "SIGTERM"]])
			await vi.advanceTimersByTimeAsync(99)
			expect(kill).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(1)
			expect(kill.mock.calls[1]).toEqual([4242, "SIGKILL"])
			await vi.advanceTimersByTimeAsync(900)
			const result = await pending
			expect(result.joined).toBe(false)
			expect(result.terminationMs).toBe(1000)
			expect(result.reason).toContain(
				kind === "write"
					? "write"
					: kind === "deadline"
						? "deadline"
						: "cancel",
			)
			expect(vi.getTimerCount()).toBe(0)
		},
	)
	it("never signals the reaped group and bounds an exit-before-EOF pipe hold to 1s", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const child = new Child()
		const controller = new AbortController()
		const kill = vi.fn()
		const pending = consumer.superviseChild(() => child, writers(), {
			now: Date.now,
			kill,
			signal: controller.signal,
			sample: normalSample,
		})
		child.emit("exit", 0, null)
		await vi.advanceTimersByTimeAsync(500)
		controller.abort()
		await vi.advanceTimersByTimeAsync(500)
		const result = await pending
		expect(result.joined).toBe(false)
		expect(result.childElapsedMs).toBe(1000)
		expect(kill).not.toHaveBeenCalled()
	})
	it("allows at most one retained partial-write loop per stream and backpressures a slow sink", async () => {
		const child = new Child()
		let release: ((n: number) => void) | undefined
		let calls = 0
		const sink = {
			stdout: vi.fn<Writer>((_buffer, _offset, length) =>
				++calls === 1
					? new Promise<number>(resolveResult => {
							release = resolveResult
						})
					: length,
			),
			stderr: writers().stderr,
		}
		const pending = consumer.superviseChild(() => child, sink, {
			sample: normalSample,
		})
		child.stdout.write(Buffer.alloc(16384))
		child.stdout.write(Buffer.alloc(16384))
		await flush()
		expect(sink.stdout).toHaveBeenCalledTimes(1)
		expect(child.stdout.readableLength).toBeGreaterThan(0)
		release!(16384)
		child.finish()
		const result = await pending
		expect(result.streams[0]?.stored).toBe(32768)
		expect(sink.stdout.mock.calls.every(call => call[2] <= 16384)).toBe(true)
	})
	it("retains uncertain outstanding writes and returns without waiting forever", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const child = new Child()
		const controller = new AbortController()
		const pending = consumer.superviseChild(
			() => child,
			{ stdout: () => new Promise<number>(() => {}), stderr: writers().stderr },
			{
				now: Date.now,
				signal: controller.signal,
				kill: () => {},
				sample: normalSample,
			},
		)
		child.stdout.write(Buffer.alloc(16384))
		await flush()
		controller.abort()
		await vi.advanceTimersByTimeAsync(1000)
		expect(await pending).toMatchObject({
			joined: false,
			writersSettled: false,
		})
	})
	it("stores at most stdout cap and drains/discards at most 256KiB after breach", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const child = new Child()
		const kill = vi.fn()
		const pending = consumer.superviseChild(() => child, writers(), {
			now: Date.now,
			kill,
			sample: normalSample,
		})
		child.stdout.write(Buffer.alloc(1024 ** 2 + 512 * 1024 + 1))
		await flush()
		await vi.advanceTimersByTimeAsync(1000)
		const result = await pending
		expect(result.streams[0]).toMatchObject({
			stored: 1024 ** 2,
			truncated: true,
		})
		expect(
			result.streams.reduce((sum, value) => sum + value.discarded, 0),
		).toBeLessThanOrEqual(256 * 1024)
		expect(kill).toHaveBeenCalledTimes(2)
	})
	it("rejects failed spawn, a pre-cancelled launch and early pipe failure", async () => {
		const controller = new AbortController()
		controller.abort()
		const factory = vi.fn(() => new Child())
		await expect(
			consumer.superviseChild(factory, writers(), {
				signal: controller.signal,
			}),
		).rejects.toThrow("before spawn")
		expect(factory).not.toHaveBeenCalled()
		const child = new Child()
		child.pid = 0
		const pending = consumer.superviseChild(() => child, writers(), {
			sample: normalSample,
		})
		child.emit("error", new Error("spawn refused"))
		child.stdout.destroy()
		child.stderr.destroy()
		child.emit("close", -2, null)
		expect(await pending).toMatchObject({
			reason: expect.stringContaining("spawn refused"),
			joined: true,
		})
	})
	it("bounds sampled metrics and aborts observed RSS/combined sustained CPU", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const child = new Child()
		let cpu = 0
		const kill = vi.fn()
		const pending = consumer.superviseChild(() => child, writers(), {
			now: Date.now,
			kill,
			sample: () => ({
				captureRss: 1,
				captureCpu: { user: 0, system: 0 },
				driverRss: 1,
				driverCpu: (cpu += 2000000),
			}),
		})
		await vi.advanceTimersByTimeAsync(11000)
		expect((await pending).reason).toBe("combined CPU stop objective")
		const high = new Child()
		const rss = consumer.superviseChild(() => high, writers(), {
			now: Date.now,
			kill,
			sample: () => ({ captureRss: 96 * 1024 ** 2 + 1 }),
		})
		await vi.advanceTimersByTimeAsync(1000)
		expect((await rss).reason).toBe("capture RSS stop objective")
	})
})

describe("exclusive files, narrow reservation and identity-safe verification", () => {
	it("closes capture options and removes command/env preload channels", () => {
		for (const args of [
			["--command", "echo"],
			["--output", "/tmp/x"],
			["--capture-reservation", "x"],
			["--scenario", "tiny"],
			["--reserve-gib", "64"],
		])
			expect(() => consumer.captureArgs(args)).toThrow()
		const launch = consumer.fixedLaunch({ scenario: "disabled", seed: 42 })
		expect(launch.executable).toBe(process.execPath)
		expect(launch.args[1]).toBe(join(source, "run.mjs"))
		expect(launch.options).toMatchObject({
			detached: true,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { LANG: "C", TZ: "UTC" },
		})
		expect(launch.args).not.toContain("--eval")
		expect(() =>
			consumer.fixedLaunch({ scenario: "disabled", command: "evil" } as Config),
		).toThrow()
	})
	it("creates exclusively with restrictive modes and validates a disjoint 4MiB reservation", () => {
		const { value, root: path } = owned()
		expect(driver.verifyCaptureReservation(value.config, path)).toEqual(
			value.reservation,
		)
		expect(value.reservation["bytes"]).toBe(4 * 1024 ** 2)
		for (const file of value.files)
			expect(fs.statSync(file.path).mode & 0o777).toBe(0o600)
		expect(fs.readdirSync(value.output)).toEqual([])
		const token = value.config.captureReservation!
		expect(() =>
			driver.verifyCaptureReservation(
				{
					...value.config,
					captureReservation: token.replace(/:[0-9]+$/, ":9999999"),
				},
				path,
			),
		).toThrow("identity")
		expect(() =>
			driver.verifyCaptureReservation(
				{ ...value.config, output: "../escape" },
				path,
			),
		).toThrow("binding")
		fs.writeFileSync(join(value.path, "extra"), "x")
		expect(() => driver.verifyCaptureReservation(value.config, path)).toThrow(
			"entry",
		)
	})
	it("denies unknown/low space before files and conservatively fences previous residue", () => {
		const path = root()
		for (const statfs of [
			() => undefined,
			() => ({ bavail: BigInt(9 * GiB), bsize: 1n }),
		])
			expect(() =>
				consumer.prepareCapture(
					{ scenario: "disabled", reserveBytes: GiB },
					path,
					statfs,
				),
			).toThrow()
		expect(fs.readdirSync(path)).toEqual([])
		const first = consumer.prepareCapture(
			{ scenario: "disabled", reserveBytes: GiB },
			path,
			free,
		)
		ownedFiles.push(first)
		expect(() =>
			consumer.prepareCapture(
				{ scenario: "disabled", reserveBytes: GiB },
				path,
				free,
			),
		).toThrow("residue")
	})
	it("rejects symlink ancestors, preexisting UUID and replaced directories", () => {
		const path = root()
		fs.symlinkSync(root(), join(path, "output"))
		expect(() =>
			consumer.prepareCapture(
				{ scenario: "disabled", reserveBytes: GiB },
				path,
				free,
			),
		).toThrow("Unsafe")
		const { value } = owned()
		fs.renameSync(value.output, value.output + "-saved")
		fs.mkdirSync(value.output)
		expect(value.verify).toThrow("identity")
	})
	it("does safe known-file pre-spawn cleanup despite statfs failure and preserves inode replacement", () => {
		const { value } = owned()
		const stdout = value.files[0]!
		fs.renameSync(stdout.path, stdout.path + "-old")
		fs.writeFileSync(stdout.path, "replacement", { mode: 0o600 })
		consumer.closeOwned(value)
		consumer.cleanupPreSpawn(value)
		expect(fs.readFileSync(stdout.path, "utf8")).toBe("replacement")
		expect(fs.existsSync(value.files[1]!.path)).toBe(false)
		expect(fs.existsSync(value.files[2]!.path)).toBe(false)
	})
	it("never cleans post-spawn files and inventories known driver residue without deletion", () => {
		const { value } = owned()
		value.spawned = true
		consumer.closeOwned(value)
		consumer.cleanupPreSpawn(value)
		expect(value.files.every(file => fs.existsSync(file.path))).toBe(true)
		fs.writeFileSync(join(value.output, "fixture.db"), "residue", {
			mode: 0o600,
		})
		expect(consumer.inspectDriver(value).bytes).toBe(7)
		expect(fs.readFileSync(join(value.output, "fixture.db"), "utf8")).toBe(
			"residue",
		)
		fs.symlinkSync(value.files[0]!.path, join(value.output, "report.json"))
		expect(() => consumer.inspectDriver(value)).toThrow("identity")
	})
	it("hashes only bounded blocks with identity and deadline checks", () => {
		const { value } = owned()
		const file = value.files[0]!
		fs.writeSync(file.fd, Buffer.alloc(150000, 42))
		const info = fs.lstatSync(file.path)
		const read = vi.spyOn(nodeFs, "readSync")
		syncBuiltinESMExports()
		const hash = consumer.hashOwned(file.path, info, 1024 ** 2)
		expect(read).toHaveBeenCalledTimes(3)
		expect(hash.sha256).toBe(
			createHash("sha256").update(Buffer.alloc(150000, 42)).digest("hex"),
		)
		expect(
			read.mock.calls.every(
				call => (Array.from<unknown>(call)[3] as number) <= 65536,
			),
		).toBe(true)
		expect(() => consumer.hashOwned(file.path, info, 100)).toThrow("cap")
		let blocks = 0
		expect(() =>
			consumer.hashOwned(file.path, info, 1024 ** 2, () => {
				if (++blocks === 2) throw new Error("deadline")
			}),
		).toThrow("deadline")
		fs.renameSync(file.path, file.path + "-old")
		fs.writeFileSync(file.path, "replace", { mode: 0o600 })
		expect(() => consumer.hashOwned(file.path, info, 1024 ** 2)).toThrow(
			"identity",
		)
	})
	it("rewrites only the owned manifest and conserves reservation/actual/residue once", () => {
		const { value } = owned()
		consumer.writeManifest(value, {
			completion: "pending",
			text: "x".repeat(1000),
		})
		const size = consumer.writeManifest(value, { completion: "observed" })
		expect(fs.statSync(join(value.path, "manifest.json")).size).toBe(size)
		expect(fs.readdirSync(value.path)).toEqual([
			"manifest.json",
			"stderr.bin",
			"stdout.bin",
		])
		expect(() =>
			consumer.writeManifest(value, { x: "x".repeat(1024 ** 2) }),
		).toThrow("cap")
		expect(consumer.unionAccounting(100, 700, false)).toMatchObject({
			totalBytes: 4 * 1024 ** 2 + 700,
			captureReservedBytes: 4 * 1024 ** 2 - 100,
			settled: false,
		})
		expect(consumer.unionAccounting(100, 700, true)).toMatchObject({
			totalBytes: 800,
			captureReservedBytes: 0,
			settled: true,
		})
		expect(consumer.unionAccounting(100, null, false).totalBytes).toBeNull()
		expect(() => consumer.unionAccounting(4 * 1024 ** 2 + 1, 0, true)).toThrow()
	})
})

function mockLaunch(
	path: string,
	transform: (report: Record<string, unknown>) => string = report =>
		JSON.stringify(report),
) {
	return vi.fn((_exec: string, args: string[]) => {
		const child = new Child()
		void driver
			.run(driver.parseArgs(args.slice(2)), { root: path })
			.then(report => {
				child.stdout.write(Buffer.from(transform(report)))
				child.finish()
			})
			.catch(error => {
				child.stderr.write(String(error))
				child.finish(1)
			})
		return child
	})
}
const fakeHash = () => "a".repeat(64)
describe("closed mock consumer finalization (no SQLite or subprocess probes)", () => {
	it("captures actual disabled report shape and closes accounting including final manifest", async () => {
		const path = root()
		const spawnChild = mockLaunch(path)
		const summary = await consumer.capture(
			{ scenario: "disabled" },
			{
				root: path,
				statfs: free,
				spawnChild,
				hashSource: fakeHash,
				sample: normalSample,
			},
		)
		expect(summary).toMatchObject({
			outcome: "captured",
			joined: true,
			finalManifestPersisted: true,
			qualificationClaim: false,
		})
		const manifest = readManifest(summary.path!)
		expect(manifest["driverOutcome"]).toBe("disabled")
		expect(manifest).not.toHaveProperty("report")
		const actual = fs
			.readdirSync(summary.path!)
			.reduce(
				(sum, name) => sum + fs.lstatSync(join(summary.path!, name)).size,
				0,
			)
		expect(summary.accounting?.totalBytes).toBe(actual)
		expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(4096)
	})
	it("keeps long proof unsupported before any worker/persistent setup, in both phases", async () => {
		for (const phase of ["baseline", "storage"]) {
			const path = root()
			const summary = await consumer.capture(
				{
					scenario: "steady",
					phase,
					resourceWindow: "no execution authorized",
				},
				{
					root: path,
					statfs: free,
					spawnChild: mockLaunch(path),
					hashSource: fakeHash,
					sample: normalSample,
				},
			)
			expect(summary).toMatchObject({ outcome: "captured", joined: true })
			const manifest = readManifest(summary.path!)
			expect(manifest["driverOutcome"]).toBe("not-run")
			expect(
				fs.readdirSync(
					join(
						summary.path!,
						"..",
						basename(summary.path!).replace("activity-capture-", "activity-"),
					),
				),
			).toEqual([])
		}
	})
	it.each(["missing", "duplicate", "generic", "identity", "unknown-field"])(
		"rejects %s final stdout and persists explicit incomplete reservation",
		async kind => {
			const path = root()
			const summary = await consumer.capture(
				{ scenario: "disabled" },
				{
					root: path,
					statfs: free,
					spawnChild: mockLaunch(path, report => {
						if (kind === "missing") return ""
						if (kind === "duplicate")
							return JSON.stringify(report) + JSON.stringify(report)
						if (kind === "generic") return '{"status":"ok"}'
						return JSON.stringify({
							...report,
							...(kind === "identity" ? { seed: 9 } : { extra: true }),
						})
					}),
					hashSource: fakeHash,
					sample: normalSample,
				},
			)
			expect(summary).toMatchObject({
				outcome: "incomplete",
				finalManifestPersisted: true,
				joined: true,
			})
			expect(readManifest(summary.path!)["outcome"]).toBe("incomplete")
			expect(summary.accounting?.settled).toBe(false)
		},
	)
	it("fails final statfs while still closing pipes/files and preserves bounded capture", async () => {
		const path = root()
		let calls = 0
		const summary = await consumer.capture(
			{ scenario: "disabled" },
			{
				root: path,
				statfs: () => (++calls > 2 ? undefined : free()),
				spawnChild: mockLaunch(path),
				hashSource: fakeHash,
				sample: normalSample,
			},
		)
		expect(summary).toMatchObject({
			outcome: "incomplete",
			joined: true,
			finalManifestPersisted: true,
		})
		expect(summary.reason).toContain("disk")
		expect(fs.readdirSync(summary.path!)).toEqual([
			"manifest.json",
			"stderr.bin",
			"stdout.bin",
		])
	})
	it("reports final manifest failure and preserves pending manifest without a success summary", async () => {
		const path = root()
		let writes = 0
		const summary = await consumer.capture(
			{ scenario: "disabled" },
			{
				root: path,
				statfs: free,
				spawnChild: mockLaunch(path),
				hashSource: fakeHash,
				sample: normalSample,
				manifestWriter: (value, manifest, check) => {
					if (++writes === 2) throw new Error("ENOSPC final manifest")
					return consumer.writeManifest(value, manifest, check)
				},
			},
		)
		expect(summary).toMatchObject({
			outcome: "incomplete",
			finalManifestPersisted: false,
			joined: true,
			accounting: null,
		})
		expect(summary.reason).toContain("ENOSPC")
		expect(readManifest(summary.path!)["completion"]).toBe("pending")
		expect(writes).toBe(2)
	})
	it("does not inspect/delete driver artifacts if root termination never joins", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const path = root()
		const controller = new AbortController()
		let output = ""
		const pending = consumer.capture(
			{ scenario: "disabled" },
			{
				root: path,
				statfs: free,
				now: Date.now,
				signal: controller.signal,
				kill: () => {},
				sample: normalSample,
				hashSource: fakeHash,
				spawnChild: (_exec, args) => {
					output = driver.parseArgs(args.slice(2)).output!
					fs.writeFileSync(join(output, "unknown-live-artifact"), "live", {
						mode: 0o600,
					})
					queueMicrotask(() => controller.abort())
					return new Child()
				},
			},
		)
		await vi.advanceTimersByTimeAsync(1000)
		const summary = await pending
		expect(summary).toMatchObject({
			outcome: "incomplete",
			joined: false,
			finalManifestPersisted: true,
		})
		expect(fs.readFileSync(join(output, "unknown-live-artifact"), "utf8")).toBe(
			"live",
		)
		expect(summary.accounting?.totalBytes).toBeNull()
	})
	it("holds one absolute preflight/post budget including final writes", async () => {
		const path = root()
		let clock = 0
		const spawnChild = mockLaunch(path)
		const summary = await consumer.capture(
			{ scenario: "disabled" },
			{
				root: path,
				statfs: free,
				now: () => clock,
				spawnChild,
				hashSource: () => {
					clock = 5000
					return fakeHash()
				},
				sample: normalSample,
			},
		)
		expect(summary.outcome).toBe("incomplete")
		expect(spawnChild).not.toHaveBeenCalled()
		const second = root()
		clock = 0
		let writes = 0
		const delayed = await consumer.capture(
			{ scenario: "disabled" },
			{
				root: second,
				statfs: free,
				now: () => clock,
				spawnChild: mockLaunch(second),
				hashSource: fakeHash,
				sample: normalSample,
				manifestWriter: (value, manifest, check) => {
					const size = consumer.writeManifest(value, manifest, check)
					if (++writes === 2) clock += 60000
					return size
				},
			},
		)
		expect(delayed).toMatchObject({
			outcome: "incomplete",
			finalManifestPersisted: false,
		})
	})
})

function microResult() {
	const pragmas = {
		journalMode: "wal",
		synchronous: 2,
		pageSize: 4096,
		maxPageCount: 128,
		cacheSpill: 0,
		busyTimeout: 50,
		walAutocheckpoint: 32,
	}
	return {
		status: "ok",
		warnings: [],
		sqlite: "3.50.4",
		provenance: {
			version: "3.50.4",
			sourceId:
				"2025-07-30 19:33:53 4d8adfb30e03f9cf27f800a2c1ba3c48fb4ca1b08b0f5ed59a4d5ecbf45e20a3",
		},
		growthReservation: {
			pageSize: 4096,
			pages: 128,
			dbBytes: 524288,
			walBytes: 597048,
			totalBytes: 1223744,
			proof: "exact-source no-spill tiny fixture; unsupported for long storage",
		},
		compileOptions: [{ compile_options: "DEFAULT_MEMSTATUS=0" }],
		initialPragmas: pragmas,
		finalPragmas: pragmas,
		primitives: {
			ftsAvailable: true,
			rollback: true,
			retentionBeforeRetry: true,
			originalReceiptAfterPrune: true,
			explicitExpiry: true,
			cleanRestart: true,
			queryPlan: [
				{ id: 1, parent: 0, notused: 0, detail: "USING INTEGER PRIMARY KEY" },
			],
		},
		counts: { offered: 10, admitted: 10, rejected: 0, committed: 10 },
		processRssBytes: 1,
		memoryMetric: "RSS of shared process, not isolated worker RSS",
		queueMaxRows: 10,
		unverified: [],
	}
}
describe("postparse validation bound to current final driver format", () => {
	it("accepts the actual driver report generated with a closed mocked worker and rejects malformed completion/PRAGMA/count/page facts", async () => {
		const { value, root: path } = owned({
			scenario: "micro",
			reserveBytes: GiB,
			seed: 42,
			deadlineMs: 10000,
		})
		const report = await driver.run(value.config, {
			root: path,
			statfs: free,
			workerFactory: () => {
				const worker = Object.assign(new EventEmitter(), {
					terminate: async () => 0,
				})
				queueMicrotask(() => {
					worker.emit("message", microResult())
					worker.emit("exit", 0)
				})
				return worker
			},
		})
		const hashes = report["sourceHashes"] as Record<string, string>
		expect(
			consumer.validateReport(
				report,
				value.config,
				value.reservation,
				0,
				hashes,
			),
		).toBe("micro-only")
		const result = report["result"] as ReturnType<typeof microResult>
		const invalid = [
			{ ...report, status: "ok" },
			{ ...report, completion: "pending" },
			{ ...report, reportPersisted: false },
			{ ...report, result: { status: "ok" } },
			{
				...report,
				result: {
					...result,
					initialPragmas: { ...result.initialPragmas, maxPageCount: 524288 },
				},
			},
			{
				...report,
				result: { ...result, counts: { ...result.counts, committed: 9 } },
			},
			{
				...report,
				result: {
					...result,
					pages: [{ scannedThrough: -1, sequences: [4, 1] }],
				},
			},
			{ ...report, residue: { bytes: 0, files: [] } },
			{ ...report, sourceHashes: { ...hashes, "worker.mjs": "b".repeat(64) } },
		]
		for (const bad of invalid)
			expect(() =>
				consumer.validateReport(
					bad,
					value.config,
					value.reservation,
					0,
					hashes,
				),
			).toThrow()
		expect(() =>
			consumer.validateReport(
				report,
				value.config,
				value.reservation,
				1,
				hashes,
			),
		).toThrow("exit")
	})
	it("accepts only the current closed pretransaction unsupported reason, without arbitrary ok/status promotion", async () => {
		const { value, root: path } = owned({
			scenario: "runtime",
			reserveBytes: GiB,
			seed: 42,
			deadlineMs: 10000,
		})
		const report = await driver.run(value.config, {
			root: path,
			statfs: free,
			workerFactory: () => {
				const worker = Object.assign(new EventEmitter(), {
					terminate: async () => 0,
				})
				queueMicrotask(() => {
					worker.emit("message", {
						status: "unsupported",
						error: "Unsupported pretransaction SQLite growth proof",
						provenance: { version: "3.47.2", sourceId: "unproved" },
						counts: { offered: 0, admitted: 0, rejected: 0, committed: 0 },
					})
					worker.emit("exit", 0)
				})
				return worker
			},
		})
		const hashes = report["sourceHashes"] as Record<string, string>
		expect(
			consumer.validateReport(
				report,
				value.config,
				value.reservation,
				0,
				hashes,
			),
		).toBe("unsupported")
		expect(() =>
			consumer.validateReport(
				{
					...report,
					result: {
						...(report["result"] as Record<string, unknown>),
						error: "fine",
					},
				},
				value.config,
				value.reservation,
				0,
				hashes,
			),
		).toThrow("reason")
	})
})

describe("remaining closure and quota edges", () => {
	it("accepts exactly the stdout cap without truncation and rejects stderr cap+1", async () => {
		const exact = new Child()
		const pending = consumer.superviseChild(() => exact, writers(), {
			sample: normalSample,
		})
		exact.stdout.write(Buffer.alloc(1024 ** 2))
		exact.finish()
		expect((await pending).streams[0]).toMatchObject({
			stored: 1024 ** 2,
			truncated: false,
			discarded: 0,
		})
		const over = new Child()
		const capped = consumer.superviseChild(() => over, writers(), {
			sample: normalSample,
			kill: () => {},
		})
		over.stderr.write(Buffer.alloc(2 * 1024 ** 2 + 1))
		over.finish()
		const result = await capped
		expect(result.streams[1]).toMatchObject({
			stored: 2 * 1024 ** 2,
			truncated: true,
			discarded: 1,
		})
		expect(result.reason).toContain("cap")
	})
	it("suppresses KILL after a matching root reap and rejects nonzero joined exits", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const child = new Child()
		const controller = new AbortController()
		const kill = vi.fn()
		const pending = consumer.superviseChild(() => child, writers(), {
			now: Date.now,
			signal: controller.signal,
			kill,
			sample: normalSample,
		})
		controller.abort()
		await vi.advanceTimersByTimeAsync(50)
		child.finish(1)
		const result = await pending
		await vi.advanceTimersByTimeAsync(1000)
		expect(result).toMatchObject({
			joined: true,
			exitCode: 1,
			reason: "cancelled",
		})
		expect(kill.mock.calls).toEqual([[4242, "SIGTERM"]])
		expect(vi.getTimerCount()).toBe(0)
	})
	it("closes and cleans only its known pre-spawn files when the final admission statfs is unknown", () => {
		const path = root()
		let calls = 0
		expect(() =>
			consumer.prepareCapture(
				{ scenario: "disabled", reserveBytes: GiB },
				path,
				() => (++calls === 2 ? undefined : free()),
			),
		).toThrow("Unknown")
		const base = join(path, "output", "qualification")
		for (const name of fs.readdirSync(base))
			expect(fs.readdirSync(join(base, name))).toEqual([])
	})
})

it("preserves evidence and fails the summary when capture-file close is uncertain", async () => {
	const path = root()
	const close = nodeFs.closeSync
	let failedFd: number | null = null
	const calls: number[] = []
	vi.spyOn(nodeFs, "closeSync").mockImplementation(fd => {
		calls.push(fd)
		if (failedFd === null) {
			failedFd = fd
			close(fd) // Model an ambiguous close that physically completed.
			throw new Error("close settlement uncertain")
		}
		close(fd)
	})
	syncBuiltinESMExports()
	const summary = await consumer.capture(
		{ scenario: "disabled" },
		{
			root: path,
			statfs: free,
			spawnChild: mockLaunch(path),
			hashSource: fakeHash,
			sample: normalSample,
		},
	)
	expect(summary).toMatchObject({
		outcome: "incomplete",
		filesClosed: false,
		joined: true,
	})
	expect(summary.reason).toContain("close")
	expect(calls.filter(fd => fd === failedFd)).toHaveLength(1)
	expect(fs.existsSync(join(summary.path!, "stdout.bin"))).toBe(true)
})

it("enforces capture RSS in preflight and after parsing, with unknown driver measurements retained", async () => {
	const path = root()
	const spawnChild = mockLaunch(path)
	const startup = await consumer.capture(
		{ scenario: "disabled" },
		{
			root: path,
			statfs: free,
			spawnChild,
			hashSource: fakeHash,
			sample: () => ({ captureRss: 96 * 1024 ** 2 + 1 }),
		},
	)
	expect(startup).toMatchObject({ outcome: "incomplete", path: null })
	expect(spawnChild).not.toHaveBeenCalled()
	const second = root()
	let samples = 0
	const parsed = await consumer.capture(
		{ scenario: "disabled" },
		{
			root: second,
			statfs: free,
			spawnChild: mockLaunch(second),
			hashSource: fakeHash,
			sample: () => ({ captureRss: ++samples >= 3 ? 96 * 1024 ** 2 + 1 : 1 }),
		},
	)
	expect(parsed).toMatchObject({
		outcome: "incomplete",
		joined: true,
		qualificationClaim: false,
	})
	expect(parsed.reason).toContain("RSS")
})

it("includes a delayed physical manifest close in the same post-exit deadline", async () => {
	const path = root()
	let clock = 0
	const close = nodeFs.closeSync
	vi.spyOn(nodeFs, "closeSync").mockImplementation(fd => {
		const prefix = Buffer.alloc(32)
		fs.readSync(fd, prefix, 0, prefix.length, 0)
		close(fd)
		if (prefix.toString().startsWith('{"version":1,"runId":')) clock += 60000
	})
	syncBuiltinESMExports()
	const summary = await consumer.capture(
		{ scenario: "disabled" },
		{
			root: path,
			statfs: free,
			now: () => clock,
			spawnChild: mockLaunch(path),
			hashSource: fakeHash,
			sample: normalSample,
		},
	)
	expect(summary).toMatchObject({
		outcome: "incomplete",
		joined: true,
		filesClosed: true,
	})
	expect(summary.reason).toContain("deadline")
})

it("does not await a blocked summary sink before exiting uncertain containment", () => {
	const write = vi.fn((_text: string) => false)
	const exit = vi.fn()
	consumer.emitSummary(
		{
			outcome: "incomplete",
			joined: false,
			writersSettled: true,
			filesClosed: true,
		},
		{ write, exit },
	)
	expect(write).toHaveBeenCalledTimes(1)
	expect(
		Buffer.byteLength(write.mock.calls[0]![0] as string),
	).toBeLessThanOrEqual(4096)
	expect(exit).toHaveBeenCalledWith(1)
	consumer.emitSummary(
		{
			outcome: "captured",
			joined: true,
			writersSettled: true,
			filesClosed: true,
		},
		{ write, exit },
	)
	expect(exit).toHaveBeenCalledTimes(1)
})

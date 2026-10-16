// Feature: web-gaps-8, Property 2: Store round trip and fail closed
// Validates: Requirements 1.2, 1.3
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import * as nodeFs from "node:fs/promises"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DecoderSettingValue } from "@wavekit/api-types"
import type {
	DecoderOverride,
	DecoderSettingsFile,
} from "../../../../src/decoders/settings/contract.js"
import type { DecoderSettingsFs } from "../../../../src/decoders/settings/store.js"
import {
	openDecoderSettingsStore,
	parseDecoderSettingsFile,
	serializeDecoderSettingsFile,
} from "../../../../src/decoders/settings/store.js"
import type { Logger } from "../../../../src/utils/logger.js"

const FILE = "decoder-settings.json"

// Real fs with fsync skipped: durability is covered by store.test.ts; this keeps 100 runs
// of real reads, writes, renames and quarantines under the test timeout.
const noSyncFs: DecoderSettingsFs = {
	open: (async (...args: Parameters<typeof nodeFs.open>) => {
		const handle = await nodeFs.open(...args)
		handle.sync = () => Promise.resolve()
		return handle
	}) as typeof nodeFs.open,
	rename: nodeFs.rename,
	unlink: nodeFs.unlink,
	readdir: (path: string) => nodeFs.readdir(path),
	lstat: nodeFs.lstat,
	mkdir: nodeFs.mkdir,
}
const NOW = 1_700_000_000_000

function silentLogger(): Logger {
	const noop = vi.fn()
	const logger: Record<string, unknown> = {
		warn: noop,
		error: noop,
		info: noop,
		debug: noop,
		trace: noop,
		fatal: noop,
	}
	logger["child"] = () => logger
	return logger as unknown as Logger
}

const name = fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/)
const finite = fc
	.double({ noNaN: true, noDefaultInfinity: true })
	.map(n => n + 0)
const value: fc.Arbitrary<DecoderSettingValue> = fc.oneof(
	fc.boolean(),
	finite,
	fc.string({ maxLength: 40 }),
	fc.array(fc.string({ maxLength: 20 }), { maxLength: 8 }),
	fc.array(finite, { maxLength: 8 }),
)
const iso = fc
	.integer({ min: 0, max: 4_000_000_000_000 })
	.map(ms => new Date(ms).toISOString())
const override: fc.Arbitrary<DecoderOverride> = fc
	.record(
		{
			type: name,
			enabled: fc.boolean(),
			options: fc.dictionary(name, value, { maxKeys: 8 }),
			updatedAt: iso,
		},
		{ requiredKeys: ["type", "options", "updatedAt"] },
	)
	.map(entry => entry as DecoderOverride)
const validFile: fc.Arbitrary<DecoderSettingsFile> = fc.record({
	schemaVersion: fc.constant(1 as const),
	revision: fc.nat({ max: Number.MAX_SAFE_INTEGER }),
	decoders: fc.dictionary(name, override, { maxKeys: 6 }),
})

/** Corruptions of a valid file's text; each must make the whole file corrupt. */
const corruption = fc.oneof(
	fc.constant((t: string) => t.slice(0, Math.max(0, t.length - 2))),
	fc.constant((t: string) =>
		t.replace('"schemaVersion": 1', '"schemaVersion": "1"'),
	),
	fc.constant((t: string) => t.replace(/^\{/, '{"extra": 1,')),
	fc.constant((t: string) => t.replace(/"revision": \d+/, '"revision": -1')),
	fc.constant((t: string) =>
		t.replace(
			'"decoders": {',
			'"decoders": {"Z!": {"type": 5, "options": {}, "updatedAt": "2026-01-01T00:00:00.000Z"},',
		),
	),
	fc.constant((t: string) =>
		t.replace(
			'"decoders": {',
			'"decoders": {"Z!": {"type": "t", "options": {"k": {"a": 1}}, "updatedAt": "2026-01-01T00:00:00.000Z"},',
		),
	),
	fc.constant((t: string) =>
		t.replace(
			'"decoders": {',
			'"decoders": {"__proto__": {"type": "t", "options": {}, "updatedAt": "2026-01-01T00:00:00.000Z"},',
		),
	),
	fc.constant((t: string) => t + " ".repeat(256 * 1024)),
)

describe("Property 2: store round trip and fail closed (pure parse)", () => {
	it("parse(serialize(x)) deep-equals x", () => {
		fc.assert(
			fc.property(validFile, file => {
				const parsed = parseDecoderSettingsFile(
					serializeDecoderSettingsFile(file),
				)
				expect(parsed).toEqual({ corrupt: false, file })
			}),
			{ numRuns: 200 },
		)
	})

	it("corruptions are refused whole", () => {
		fc.assert(
			fc.property(validFile, corruption, (file, corrupt) => {
				const parsed = parseDecoderSettingsFile(
					corrupt(serializeDecoderSettingsFile(file)),
				)
				expect(parsed.corrupt).toBe(true)
			}),
			{ numRuns: 200 },
		)
	})
})

describe("Property 2: store round trip and fail closed (real fs)", () => {
	let dir: string
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "wavekit-decset-prop-"))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it("load(write(x)) deep-equals x; a corrupted file loads empty, seeded above it, quarantined", async () => {
		await fc.assert(
			fc.asyncProperty(validFile, corruption, async (file, corrupt) => {
				const runDir = await mkdtemp(join(dir, "r-"))
				const opts = {
					stateDir: runDir,
					logger: silentLogger(),
					now: () => NOW,
					fs: noSyncFs,
				}
				const store = await openDecoderSettingsStore(opts)
				await store.write(file)
				const reloaded = await openDecoderSettingsStore(opts)
				expect(reloaded.snapshot()).toEqual(file)
				await writeFile(
					join(runDir, FILE),
					corrupt(serializeDecoderSettingsFile(file)),
				)
				const lost = await openDecoderSettingsStore(opts)
				expect(lost.snapshot().decoders).toEqual({})
				expect(lost.revision()).toBeGreaterThan(
					Math.min(file.revision, NOW * 1000 - 1),
				)
				expect(lost.revision()).toBeGreaterThanOrEqual(NOW * 1000)
				const names = await readdir(runDir)
				expect(
					names.filter(n => n.startsWith(`${FILE}.corrupt-`)),
				).toHaveLength(1)
				expect(names).not.toContain(FILE)
				await rm(runDir, { recursive: true, force: true })
			}),
			{ numRuns: 100 },
		)
	})
})

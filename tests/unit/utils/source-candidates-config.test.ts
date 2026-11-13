/**
 * `sources[i].candidates`: bounded list, bounded printable labels, strict entries, and
 * environment overrides of existing entries in both the nested and the indexed form.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	loadConfig,
	SOURCE_CANDIDATE_LABEL_MAX_LENGTH,
	SOURCE_CANDIDATES_MAX,
	SourceConfigSchema,
} from "../../../src/config.js"

const base = {
	id: "rx",
	type: "rtl_tcp",
	host: "rx-main.invalid",
	port: 1234,
	caps: { kind: "iq", format: "U8_IQ", sampleRate: 2048000 },
}
const candidate = (i: number) => ({ host: `rx-${i}.invalid`, port: 1234 })

describe("SourceConfigSchema candidates", () => {
	it(`accepts ${SOURCE_CANDIDATES_MAX} candidates and refuses ${SOURCE_CANDIDATES_MAX + 1}`, () => {
		const list = (n: number) =>
			Array.from({ length: n }, (_, i) => candidate(i))
		expect(
			SourceConfigSchema.safeParse({
				...base,
				candidates: list(SOURCE_CANDIDATES_MAX),
			}).success,
		).toBe(true)
		expect(
			SourceConfigSchema.safeParse({
				...base,
				candidates: list(SOURCE_CANDIDATES_MAX + 1),
			}).success,
		).toBe(false)
	})

	it(`a label of ${SOURCE_CANDIDATE_LABEL_MAX_LENGTH} printable characters is fine; longer, empty or with control characters is refused`, () => {
		const withLabel = (label: string) =>
			SourceConfigSchema.safeParse({
				...base,
				candidates: [{ ...candidate(0), label }],
			}).success
		expect(withLabel("a".repeat(SOURCE_CANDIDATE_LABEL_MAX_LENGTH))).toBe(true)
		expect(withLabel("a".repeat(SOURCE_CANDIDATE_LABEL_MAX_LENGTH + 1))).toBe(
			false,
		)
		expect(withLabel("")).toBe(false)
		expect(withLabel("usb\nINJECTED")).toBe(false)
		expect(withLabel("café")).toBe(false)
	})

	it("entries are strict and need a valid port", () => {
		const one = (c: unknown) =>
			SourceConfigSchema.safeParse({ ...base, candidates: [c] }).success
		expect(one({ host: "a.invalid", port: 0 })).toBe(false)
		expect(one({ host: "a.invalid", port: 65_536 })).toBe(false)
		expect(one({ host: "", port: 1 })).toBe(false)
		expect(one({ host: "a.invalid", port: 1, extra: true })).toBe(false)
		expect(one({ host: "a.invalid", port: 65_535 })).toBe(true)
	})
})

describe("candidates environment overrides", () => {
	let tempDir: string
	let originalEnv: NodeJS.ProcessEnv
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wavekit-candidates-"))
		originalEnv = { ...process.env }
	})
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true })
		process.env = originalEnv
	})

	const write = () => {
		const file = path.join(tempDir, "config.yaml")
		fs.writeFileSync(
			file,
			JSON.stringify({
				sources: [{ ...base, candidates: [candidate(0), candidate(1)] }],
			}),
		)
		return file
	}

	it.each([
		[
			"WAVEKIT_SOURCES_0_CANDIDATES_1_HOST",
			"WAVEKIT_SOURCES_0_CANDIDATES_1_PORT",
		],
		[
			"WAVEKIT_SOURCES__0__CANDIDATES__1__HOST",
			"WAVEKIT_SOURCES__0__CANDIDATES__1__PORT",
		],
	])("%s overrides an existing candidate in place", (hostVar, portVar) => {
		const file = write()
		process.env[hostVar] = "rx-usb.invalid"
		process.env[portVar] = "4321"
		const config = loadConfig(file)
		expect(config.sources[0]?.candidates).toEqual([
			candidate(0),
			{ host: "rx-usb.invalid", port: 4321 },
		])
	})

	it("a candidate index the YAML does not have is refused (no sparse arrays)", () => {
		const file = write()
		process.env["WAVEKIT_SOURCES_0_CANDIDATES_5_HOST"] = "rx-usb.invalid"
		expect(() => loadConfig(file)).toThrow("existing numeric index")
	})
})

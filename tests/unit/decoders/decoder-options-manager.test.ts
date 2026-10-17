/**
 * WG6 req 3.2-3.3: the manager validates configured options once at creation,
 * reports issues on the status, and never changes the lifecycle.
 */
import { PassThrough } from "node:stream"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DecoderOptionIssue } from "@wavekit/api-types"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderCaps, DecoderConfig } from "../../../src/decoders/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

const validate = vi.hoisted(() =>
	vi.fn<(type: string, options: unknown) => DecoderOptionIssue[] | undefined>(),
)
vi.mock("../../../src/decoders/options/index.js", () => ({
	validateDecoderOptions: validate,
	decoderOptionDescriptors: () => undefined,
}))

const SECRET = "s3cr3t-token-value"
const decoderCaps: DecoderCaps = {
	input: "iq",
	output: "text",
	integrationPattern: "pure_consumer",
}
const warn = vi.fn()
const logger = Object.assign(pino({ level: "silent" }), {
	child: () => logger,
	warn,
}) as unknown as pino.Logger

let manager: DecoderManager
let factory: ReturnType<typeof vi.fn>

function cfg(id: string, type = "rate-test", options = {}): DecoderConfig {
	return { id, type, enabled: true, sourceId: "rtl", options }
}

beforeEach(() => {
	validate.mockReset()
	warn.mockReset()
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: 446_000_000 })
	const registry = new DecoderRegistry()
	factory = vi.fn(
		(config: DecoderConfig) => new RateDecoder(config.id, decoderCaps),
	)
	registry.register("rate-test", factory, decoderCaps)
	manager = new DecoderManager(registry, new FanoutManager(logger), logger, {
		validateVersions: false,
	})
	manager.setSourceManager(sources as unknown as SourceManager)
})

afterEach(async () => {
	await manager.destroy()
})

describe("decoder option validation in the manager", () => {
	it("creates exactly as before with bad options and reports the issue", () => {
		validate.mockReturnValue([
			{ path: "bogus", code: "unknown-key", message: `x ${SECRET}` },
		])
		const config = cfg("a", "rate-test", { bogus: SECRET })
		const decoder = manager.createDecoder(config)
		expect(decoder).toBeDefined()
		expect(factory).toHaveBeenCalledTimes(1)
		expect(factory.mock.calls[0]![0]).toBe(config)
		expect(validate).toHaveBeenCalledTimes(1)
		expect(manager.getStatus("a")?.optionIssues).toEqual([
			{ path: "bogus", code: "unknown-key", message: `x ${SECRET}` },
		])
	})

	it("omits optionIssues for a type without a schema", () => {
		validate.mockReturnValue(undefined)
		manager.createDecoder(cfg("a"))
		expect(manager.getStatus("a")).not.toHaveProperty("optionIssues")
	})

	it("reports [] for valid options", () => {
		validate.mockReturnValue([])
		manager.createDecoder(cfg("a"))
		expect(manager.getStatus("a")?.optionIssues).toEqual([])
		expect(warn).not.toHaveBeenCalled()
	})

	it("a throwing validator yields no optionIssues, one warn, and still creates", () => {
		validate.mockImplementation(() => {
			throw new Error("boom")
		})
		manager.createDecoder(cfg("a"))
		expect(factory).toHaveBeenCalledTimes(1)
		expect(manager.getStatus("a")).not.toHaveProperty("optionIssues")
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it("warns once per decoder with paths only, never values", () => {
		validate.mockReturnValue([
			{ path: "a.b", code: "invalid-value", message: SECRET },
			{ path: "c", code: "unknown-key", message: SECRET },
		])
		manager.createDecoder(cfg("a", "rate-test", { key: SECRET }))
		manager.getStatus("a")
		manager.getStatus("a")
		expect(warn).toHaveBeenCalledTimes(1)
		const logged = JSON.stringify(warn.mock.calls)
		// "rate-test" documents no keys: both paths are counted, never named.
		expect(warn.mock.calls[0]?.[0]).toMatchObject({
			issueCount: 2,
			paths: [],
			unknownKeyCount: 2,
		})
		expect(logged).not.toContain("a.b")
		expect(logged).not.toContain(SECRET)
	})

	it("returns a copy so callers cannot mutate the cached issues", () => {
		validate.mockReturnValue([{ path: "x", code: "unknown-key", message: "m" }])
		manager.createDecoder(cfg("a"))
		manager.getStatus("a")!.optionIssues![0]!.path = "changed"
		expect(manager.getStatus("a")?.optionIssues?.[0]?.path).toBe("x")
	})

	it("validates scanner probe creation too", async () => {
		validate.mockReturnValue([{ path: "p", code: "unknown-key", message: "m" }])
		await manager.createEphemeralDecoder(cfg("probe"), {
			owner: "scanner",
			jobId: "j1",
			input: new PassThrough(),
		})
		expect(validate).toHaveBeenCalledWith("rate-test", {})
		expect(manager.getStatus("probe")?.optionIssues).toHaveLength(1)
	})
})

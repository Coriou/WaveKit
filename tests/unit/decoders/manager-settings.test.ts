/**
 * WG8 (web-gaps-8 req 3.1, 3.2): a manager that stages options and starts
 * equals a fresh manager created with the effective configuration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import pino from "pino"
import type { DecoderSettingValue } from "@wavekit/api-types"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderCaps, DecoderConfig } from "../../../src/decoders/types.js"
import { FakeSources, RateDecoder, iqCaps } from "../../mocks/rate-fakes.js"

const logger = pino({ level: "silent" })
const POCSAG = 466_075_000
const ELSEWHERE = 1_090_000_000

/** A fake whose argv is derived from its config, as real adapters do. */
class ArgvDecoder extends RateDecoder {
	readonly argv: string[]
	constructor(config: DecoderConfig) {
		const input = config.options["input"]
		super(config.id, {
			input: input === "external" ? "external" : "iq",
			output: "text",
			integrationPattern: "pure_consumer",
		} satisfies DecoderCaps)
		const targets = config.options["targets"]
		if (Array.isArray(targets))
			this.band = { targetsHz: targets as number[], basis: "configured" }
		this.argv = Object.keys(config.options)
			.sort()
			.map(k => `--${k}=${JSON.stringify(config.options[k])}`)
	}
}

interface Harness {
	manager: DecoderManager
	configs: DecoderConfig[]
}

function harness(): Harness {
	const configs: DecoderConfig[] = []
	const registry = new DecoderRegistry()
	registry.register(
		"rt",
		config => {
			configs.push(structuredClone(config))
			return new ArgvDecoder(config)
		},
		{ input: "iq", output: "text", integrationPattern: "pure_consumer" },
	)
	const sources = new FakeSources()
	sources.caps.set("rtl", { ...iqCaps(2_400_000), centerFreq: POCSAG })
	const manager = new DecoderManager(
		registry,
		new FanoutManager(logger),
		logger,
		{ validateVersions: false },
	)
	manager.setSourceManager(sources as unknown as SourceManager)
	return { manager, configs }
}

/** Status minus run-time clocks. */
function view(h: Harness) {
	const status = structuredClone(
		h.manager.getStatus("dec")!,
	) as unknown as Record<string, unknown>
	delete status["uptime"]
	delete status["startedAt"]
	const decoder = h.manager.getDecoder("dec") as ArgvDecoder
	return {
		status,
		caps: decoder.caps,
		argv: decoder.argv,
		band: h.manager.getBandSettings("dec"),
		config: h.configs.at(-1),
	}
}

const value: fc.Arbitrary<DecoderSettingValue> = fc.oneof(
	fc.boolean(),
	fc.integer({ min: -5, max: 5 }),
	fc.constantFrom("a", "b", ""),
	fc.array(fc.constantFrom("x", "y"), { maxLength: 3 }),
	fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 3 }),
)
const targets = fc.constantFrom([POCSAG], [ELSEWHERE], [POCSAG, ELSEWHERE])
const key = fc.constantFrom("k1", "k2", "k3")
const configOptions = fc.record(
	{
		targets,
		input: fc.constantFrom("iq", "external"),
		k1: value,
		k2: value,
	},
	{ requiredKeys: ["targets"] },
)
const staged = fc.dictionary(
	fc.oneof(key, fc.constant("targets"), fc.constant("input")),
	fc.option(value, { nil: null }),
	{ maxKeys: 4 },
)

function applyStaged(
	options: Record<string, unknown>,
	stage: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...options }
	for (const [k, v] of Object.entries(stage))
		if (v === null) delete out[k]
		else out[k] = v
	return out
}

describe("Property 6", () => {
	// One frozen clock: suspension `since` and similar stamps compare equal.
	beforeEach(() => {
		vi.useFakeTimers({ now: new Date("2026-10-16T12:00:00Z") })
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	// Feature: web-gaps-8, Property 6: Rebuild equals fresh create
	// Validates: Requirements 3.1, 3.2, 3.4
	it("stage + start equals a fresh create with C ⊕ S", async () => {
		await fc.assert(
			fc.asyncProperty(configOptions, staged, async (options, stage) => {
				// The fake reads targets as numbers; keep staged targets meaningful.
				const s = { ...stage }
				if (s["targets"] !== undefined && s["targets"] !== null)
					s["targets"] = [POCSAG]
				const base: DecoderConfig = {
					id: "dec",
					type: "rt",
					enabled: true,
					options,
				}
				const effective = applyStaged(options, s)
				const a = harness()
				const b = harness()
				try {
					a.manager.createDecoder(base)
					const pending = a.manager.stageDecoderOptions("dec", s)
					expect(pending).toBe(
						JSON.stringify(Object.entries(effective).sort()) !==
							JSON.stringify(Object.entries(options).sort()),
					)
					expect(a.manager.isRestartPending("dec")).toBe(pending)
					await a.manager.startDecoder("dec")
					expect(a.manager.isRestartPending("dec")).toBe(false)
					expect(a.configs).toHaveLength(pending ? 2 : 1)

					b.manager.createDecoder({ ...base, options: effective })
					await b.manager.startDecoder("dec")
					const va = view(a)
					const vb = view(b)
					// Key order of the rebuilt options is not observable state.
					expect(va.config?.options).toEqual(vb.config?.options)
					expect({ ...va, config: undefined }).toEqual({
						...vb,
						config: undefined,
					})
				} finally {
					await a.manager.destroy()
					await b.manager.destroy()
				}
			}),
			{ numRuns: 120 },
		)
	})
})

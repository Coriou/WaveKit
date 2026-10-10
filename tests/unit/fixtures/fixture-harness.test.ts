import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { ConfigSchema } from "../../../src/config.js"
import { FixtureSchema } from "../../integration/fixtures/manifest.js"
import {
	buildFixtureConfig,
	fixtureApiPort,
	isSubset,
	keySet,
	matchExpected,
	fixturePaths,
	padCommand,
	runSeconds,
	selectFixtures,
	stopCommand,
} from "../../integration/fixtures/harness.js"

const fixture = FixtureSchema.parse({
	id: "own_ais_162m_2048k",
	role: "channelizer-golden",
	decoder: "ais-catcher",
	license: "private",
	provenance: { notes: "own" },
	fetch: { kind: "private" },
	file: "raw/own_ais_162m_2048k.cu8",
	sha256: "a".repeat(64),
	format: "cu8",
	sample_rate: 2_048_000,
	center_hz: 162_100_000, // capture tuned off the AIS pair; the channel request moves back onto it
	duration_s: 20,
	expected: {
		min_count: 2,
		payloads: [{ mmsi: "211234560" }],
		key_fields: ["mmsi", "messageType"],
	},
	channel: { center_hz: 162_000_000 }, // AIS A/B pair centre: AIS-catcher expects ±25 kHz around its input centre
})

describe("fixture harness helpers", () => {
	it("builds a recording-source config with the channel request on the channelizer path", () => {
		const raw = parse(
			buildFixtureConfig({
				fixture,
				path: "raw",
				apiPort: 19100,
				paddedPath: "/tmp/p.cu8",
			}),
		)
		expect(raw.sources[0]).toMatchObject({
			type: "recording",
			filePath: "/tmp/p.cu8",
			loop: false,
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: 2_048_000,
				centerFreq: 162_100_000,
			},
		})
		expect(raw.decoders[0]).toMatchObject({
			type: "ais-catcher",
			useChannelizer: false,
			options: { channelHz: 162_000_000 },
		})
		expect(raw.channelizer).toEqual({ enabled: false })
		const chan = parse(
			buildFixtureConfig({
				fixture,
				path: "channelizer",
				apiPort: 19102,
				paddedPath: "/tmp/p.cu8",
			}),
		)
		expect(chan.decoders[0].useChannelizer).toBe(true)
		expect(chan.channelizer).toEqual({ enabled: true })
		expect(chan.api.port).toBe(19102)
	})
	it("disables band suspension, keeps production digital voice and isolates state per port (delta E1)", () => {
		const config = parse(
			buildFixtureConfig({
				fixture,
				path: "channelizer",
				apiPort: 19104,
				paddedPath: "/tmp/p.cu8",
			}),
		)
		expect(config.health).toEqual({ bandSuspension: false })
		expect(config.digitalVoice).toEqual({ enabled: true, httpPort: 19106 })
		expect(config.stateDir).toBe("/tmp/wk-state-19104")
		expect(config.liveDemod).toEqual({ enabled: false })
		expect(config.audio.tcpPort).toBe(19105)
	})
	it("strides api ports by 8 so api, audio and digital voice never collide (delta E2)", () => {
		expect(fixtureApiPort(0, "raw")).toBe(19100)
		expect(fixtureApiPort(0, "channelizer")).toBe(19104)
		expect(fixtureApiPort(1, "raw")).toBe(19108)
		const used = new Set<number>()
		for (let index = 0; index < 50; index++) {
			for (const path of ["raw", "channelizer"] as const) {
				const api = fixtureApiPort(index, path)
				for (const port of [api, api + 1, api + 2]) {
					expect(used.has(port), `port ${port}`).toBe(false)
					used.add(port)
				}
			}
		}
	})
	it("passes the app config schema on both paths", () => {
		for (const path of ["raw", "channelizer"] as const) {
			const config = ConfigSchema.parse(
				parse(
					buildFixtureConfig({
						fixture,
						path,
						apiPort: 19100,
						paddedPath: "/tmp/p.cu8",
					}),
				),
			)
			expect(config.health?.bandSuspension).toBe(false)
			expect(config.digitalVoice).toMatchObject({
				enabled: true,
				httpPort: 19102,
			})
			expect(config.stateDir).toBe("/tmp/wk-state-19100")
			expect(config.sources[0]?.caps.centerFreq).toBe(162_100_000)
			// The channelizer keys survive the parse (channelizer T19, addendum §6, §7)
			const channelised = path === "channelizer"
			expect(config.channelizer.enabled).toBe(channelised)
			expect(config.decoders[0]?.useChannelizer).toBe(channelised)
		}
	})
	it("pads lead and tail with 0x7f bytes sized by the fixture rate", () => {
		const cmd = padCommand(fixture, "/fixtures/raw/x.cu8", "/tmp/p.cu8")
		expect(cmd).toContain(`head -c ${5 * 2_048_000 * 2} /dev/zero`)
		expect(cmd).toContain(`head -c ${3 * 2_048_000 * 2} /dev/zero`)
		expect(runSeconds(fixture)).toBe(5 + 20 + 3 + 10)
	})
	it("stops the app by pid and KILLs its whole process group as the fallback (final review infra M3)", () => {
		const cmd = stopCommand("/tmp/x.pid", "/tmp/x.cu8")
		expect(cmd).toContain(`kill -TERM "$pid"`)
		// GNU timeout leads its own process group; node is in it.
		expect(cmd).toContain(`kill -KILL -"$pid"`)
		expect(cmd).toMatch(/KILL fallback.*>&2/)
		expect(cmd.indexOf(`kill -KILL -"$pid"`)).toBeLessThan(
			cmd.indexOf("rm -f '/tmp/x.cu8' '/tmp/x.pid'"),
		)
	})
	it("matches partial payloads and counts outputs", () => {
		const observed = [
			{ type: "ship", data: { mmsi: "211234560", messageType: 1, lat: 1 } },
			{ type: "ship", data: { mmsi: "999", messageType: 3 } },
			{ type: "stats", data: {} },
		]
		expect(isSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(true)
		expect(isSubset({ a: [1] }, { a: [1, 2] })).toBe(false)
		expect(matchExpected(fixture, observed)).toEqual({
			ok: true,
			count: 2,
			missing: [],
		})
		expect(keySet(fixture, observed)).toEqual(['["211234560",1]', '["999",3]'])
	})
})

// Final review infra I1: the golden gate never passes vacuously.
describe("fixture selection", () => {
	const negative = FixtureSchema.parse({
		...fixture,
		id: "own_ais_162m_2048k_outside",
		role: "negative",
		expected: {
			min_count: 0,
			payloads: [],
			suspension: "channel-outside-capture",
		},
		channel: { center_hz: 163_003_520 },
	})
	const tail = FixtureSchema.parse({
		...fixture,
		id: "pocsag_tail",
		role: "tail-golden",
		decoder: "multimon-ng",
		license: "CC0-1.0",
		fetch: { kind: "generated", recipe: "recipes/pocsag_tail.json" },
		file: "raw/pocsag_tail.cu8",
		channel: undefined,
	})
	const wav = FixtureSchema.parse({
		...tail,
		id: "aprs_wav",
		format: "wav",
		file: "raw/aprs_wav.wav",
	})
	const all = [fixture, negative, tail, wav]
	const present = () => true
	const select = (
		env: { paths?: string; ids?: string },
		exists: (file: string) => boolean = present,
	) =>
		selectFixtures({
			fixtures: all,
			pathsEnv: env.paths,
			idsEnv: env.ids,
			exists,
		})
	const ids = (r: ReturnType<typeof selectFixtures>) =>
		r.fixtures.map(f => f.id)

	it("defaults to the raw path and skips negatives and non-cu8 fixtures there", () => {
		const r = select({})
		expect(r.paths).toEqual(["raw"])
		expect(ids(r)).toEqual(["own_ais_162m_2048k", "pocsag_tail"])
	})
	it("trims path entries and runs negatives only with the channelizer path", () => {
		const r = select({ paths: "raw, channelizer" })
		expect(r.paths).toEqual(["raw", "channelizer"])
		expect(ids(r)).toEqual([
			"own_ais_162m_2048k",
			"own_ais_162m_2048k_outside",
			"pocsag_tail",
		])
		expect(fixturePaths(fixture, r.paths)).toEqual(["raw", "channelizer"])
		expect(fixturePaths(negative, r.paths)).toEqual(["channelizer"])
		expect(fixturePaths(tail, r.paths)).toEqual(["raw"])
	})
	it.each(["raw,chan", "raw,", "", "RAW", "raw,raw"])(
		"rejects WAVEKIT_FIXTURE_PATHS=%j",
		paths => {
			expect(() => select({ paths })).toThrow(/WAVEKIT_FIXTURE_PATHS/)
		},
	)
	it("rejects an unknown or typo'd fixture id", () => {
		expect(() => select({ ids: "own_ais_162m_2048k,own_ais_162m" })).toThrow(
			/unknown fixture id.*own_ais_162m\b/,
		)
		expect(() => select({ ids: "" })).toThrow(/WAVEKIT_FIXTURE_IDS/)
	})
	it("rejects a requested fixture whose file is absent", () => {
		expect(() =>
			select({ ids: "pocsag_tail" }, f => f !== "raw/pocsag_tail.cu8"),
		).toThrow(/pocsag_tail.*raw\/pocsag_tail\.cu8.*download\.sh/)
	})
	it("rejects a requested fixture that no selected path would run", () => {
		expect(() => select({ ids: "own_ais_162m_2048k_outside" })).toThrow(
			/own_ais_162m_2048k_outside.*no selected path/,
		)
		expect(() => select({ ids: "pocsag_tail", paths: "channelizer" })).toThrow(
			/pocsag_tail.*no selected path/,
		)
		expect(() => select({ ids: "aprs_wav" })).toThrow(/aprs_wav.*cu8/)
	})
	it("narrows to the requested ids", () => {
		const r = select({
			ids: "own_ais_162m_2048k_outside",
			paths: "channelizer",
		})
		expect(ids(r)).toEqual(["own_ais_162m_2048k_outside"])
	})
	it("fails on an absent public or generated fixture, skips an absent private one", () => {
		expect(() => select({}, f => f !== "raw/pocsag_tail.cu8")).toThrow(
			/pocsag_tail.*absent/,
		)
		const r = select({}, f => f !== fixture.file)
		expect(ids(r)).toEqual(["pocsag_tail"])
		expect(r.skippedPrivate).toEqual(["own_ais_162m_2048k"])
	})
	it("fails on an empty selection", () => {
		const empty = (fixtures: typeof all) => () =>
			selectFixtures({
				fixtures,
				pathsEnv: undefined,
				idsEnv: undefined,
				exists: () => false,
			})
		expect(empty([])).toThrow(/no fixture to replay/)
		expect(empty([fixture, wav])).toThrow(
			/no fixture to replay.*own_ais_162m_2048k/,
		)
	})
})

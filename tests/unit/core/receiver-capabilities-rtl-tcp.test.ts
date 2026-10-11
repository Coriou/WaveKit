import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { createReceiverCapabilitiesProvider } from "../../../src/core/tuner-capabilities/provider.js"
import {
	parseRtlPeerHeader,
	prepareReceiverPolicy,
	projectReceiverControls,
	projectReceiverHeader,
	RECEIVER_CONTROL_METADATA,
} from "../../../src/core/tuner-capabilities/rtl-tcp.js"
import { isDetachedPlainData } from "../../../src/core/tuner-capabilities/types.js"
import type {
	ReceiverRestCommandPolicy,
	SourceReceiverEvidence,
} from "../../../src/core/tuner-capabilities/types.js"

const now = Date.UTC(2026, 0, 2)
const token = (value: number) => value.toString(16).padStart(32, "0")
function header(tunerType = 0, gainCount = 0) {
	const bytes = Buffer.alloc(12)
	bytes.set([0x52, 0x54, 0x4c, 0x30])
	bytes.writeUInt32BE(tunerType, 4)
	bytes.writeUInt32BE(gainCount, 8)
	return bytes
}
function evidence(): SourceReceiverEvidence {
	return {
		sourceId: "test",
		sourceStateToken: {},
		sourceIncarnation: token(1),
		sessionId: token(2),
		snapshotId: token(3),
		capturedAt: now,
		source: { type: "rtl_tcp", kind: "iq", format: "U8_IQ" },
		caps: { sampleRate: 1000000, centerFreq: null },
		connection: "connected",
		delivery: {
			state: "waiting",
			lastSampleAt: null,
			sampleAgeMs: null,
			timeoutMs: 10000,
		},
		header: { capture: "complete", bytes: header(), capturedAt: now },
	}
}

// TEST-only numeric policy, deliberately different from real REST bounds.
function fixturePolicy(): ReceiverRestCommandPolicy {
	return RECEIVER_CONTROL_METADATA.map(({ id, unit, opcode, kind }) => {
		if (kind === "enum")
			return {
				id,
				unit,
				opcode,
				rule: {
					kind,
					values: id === "gainMode" ? ["manual", "agc"] : ["off", "i", "q"],
				},
			}
		if (kind === "boolean" || kind === "uint16-pair")
			return { id, unit, opcode, rule: { kind } }
		if (kind === "integer-ranges")
			return {
				id,
				unit,
				opcode,
				rule: {
					kind,
					ranges: [
						{ min: 100, max: 200 },
						{ min: 300, max: 400 },
					] as const,
				},
			}
		return {
			id,
			unit,
			opcode,
			rule: { kind, min: id === "ppm" ? -100 : 0, max: 1000 },
		}
	})
}

function get(input: SourceReceiverEvidence) {
	return createReceiverCapabilitiesProvider(
		{
			read: () => ({ kind: "present", evidence: input }),
			readPage: () => ({ kind: "unavailable" }),
		},
		fixturePolicy(),
	).get(input.sourceId)
}

describe("literal RTL peer evidence", () => {
	it("requires exactly the literal twelve bytes and retains unknown uint32 claims", () => {
		for (const tunerType of [0, 1, 0x7fffffff, 0xffffffff]) {
			for (const gainCount of [0, 1, 0x7fffffff, 0xffffffff])
				expect(parseRtlPeerHeader(header(tunerType, gainCount))).toEqual({
					tunerType,
					gainCount,
				})
		}
		for (let length = 0; length < 12; length++)
			expect(parseRtlPeerHeader(header().subarray(0, length))).toBeNull()
		expect(
			parseRtlPeerHeader(Buffer.concat([header(), Buffer.from([0])])),
		).toBeNull()
		for (let index = 0; index < 4; index++) {
			const invalid = header()
			invalid[index] = (invalid[index] ?? 0) | 0x80
			expect(parseRtlPeerHeader(invalid)).toBeNull()
		}
	})

	it("distinguishes missing, partial, invalid, format, source and disconnected variants", () => {
		const base = evidence()
		expect(
			projectReceiverHeader({
				...base,
				header: { capture: "missing", bytes: null, capturedAt: null },
			}),
		).toEqual({ state: "unknown", reason: "awaiting-header" })
		expect(
			projectReceiverHeader({
				...base,
				header: { capture: "partial", bytes: null, capturedAt: null },
			}),
		).toEqual({ state: "unknown", reason: "partial-header" })
		expect(
			projectReceiverHeader({
				...base,
				header: {
					capture: "complete",
					bytes: Buffer.alloc(12),
					capturedAt: now,
				},
			}),
		).toEqual({ state: "unknown", reason: "invalid-header" })
		expect(
			projectReceiverHeader({
				...base,
				connection: "disconnected",
				sessionId: null,
			}),
		).toEqual({ state: "unknown", reason: "not-connected" })
		expect(
			projectReceiverHeader({
				...base,
				source: { ...base.source, format: "S16_IQ" },
			}),
		).toEqual({ state: "unknown", reason: "format-not-captured" })
		expect(
			projectReceiverHeader({
				...base,
				source: { type: "rtl_tcp", kind: "audio_pcm", format: "S16LE" },
			}),
		).toEqual({ state: "not-applicable", reason: "non-iq-source" })
		expect(
			projectReceiverHeader({
				...base,
				source: { ...base.source, type: "sdrpp-network" },
			}),
		).toEqual({ state: "not-applicable", reason: "non-rtl-transport" })
		expect(
			projectReceiverHeader({
				...base,
				source: { ...base.source, type: "recording" },
				sessionId: null,
			}),
		).toEqual({ state: "not-applicable", reason: "non-rtl-transport" })
	})

	it("does not retire an advertised session merely because payload is stale or paused", () => {
		for (const state of ["stale", "paused"] as const) {
			const result = get({
				...evidence(),
				delivery: {
					state,
					lastSampleAt: now - 10000,
					sampleAgeMs: 10000,
					timeoutMs: 10000,
				},
			})
			expect(result.ok).toBe(true)
			if (result.ok) expect(result.value.peerHeader.state).toBe("advertised")
		}
	})

	it("projects SDR++ IQ/audio, RTL non-U8/audio and recordings without physical unsupported claims", () => {
		for (const source of [
			{ type: "sdrpp-network", kind: "iq", format: "S16_IQ" },
			{ type: "sdrpp-network", kind: "audio_pcm", format: "FLOAT32LE" },
			{ type: "rtl_tcp", kind: "iq", format: "S16_IQ" },
			{ type: "rtl_tcp", kind: "audio_pcm", format: "S16LE" },
			{ type: "recording", kind: "iq", format: "U8_IQ" },
			{ type: "recording", kind: "audio_pcm", format: "S16LE" },
			{ type: "recording", kind: "recording", format: "auto" },
		] as const) {
			const input = {
				...evidence(),
				source,
				sessionId: source.type === "recording" ? null : token(2),
				header: {
					capture: "not-applicable" as const,
					bytes: null,
					capturedAt: null,
				},
			}
			const result = get(input)
			expect(result.ok).toBe(true)
			if (!result.ok) continue
			expect(
				result.value.controls.every(row => row.physical.state === "unknown"),
			).toBe(true)
			expect(
				result.value.controls.every(
					row =>
						row.transport.state ===
						(source.type === "rtl_tcp" ? "applicable" : "not-applicable"),
				),
			).toBe(true)
		}
	})

	it("rejects contradictory source, connection, timestamp and retained-header fixtures", () => {
		const base = evidence()
		for (const input of [
			{ ...base, source: { ...base.source, kind: "recording" as const } },
			{ ...base, source: { ...base.source, format: "S16LE" as const } },
			{ ...base, connection: "ended" as const, sessionId: null },
			{
				...base,
				connection: "disconnected" as const,
				sessionId: null,
				delivery: { ...base.delivery, state: "disconnected" as const },
			},
			{ ...base, connection: "connecting" as const },
			{ ...base, delivery: { ...base.delivery, state: "streaming" as const } },
			{ ...base, header: { ...base.header, capturedAt: now + 1 } },
		])
			expect(get(input)).toEqual({ ok: false, code: "CONFLICT" })
	})

	it("represents recording EOF and network backoff with no historical sample or header", () => {
		const base = evidence()
		const ended = get({
			...base,
			source: { type: "recording", kind: "iq", format: "U8_IQ" },
			sessionId: null,
			connection: "ended",
			delivery: {
				state: "ended",
				lastSampleAt: null,
				sampleAgeMs: null,
				timeoutMs: 10000,
			},
			header: { capture: "not-applicable", bytes: null, capturedAt: null },
		})
		expect(ended.ok).toBe(true)
		const backoff = get({
			...base,
			sessionId: null,
			connection: "disconnected",
			delivery: {
				state: "disconnected",
				lastSampleAt: null,
				sampleAgeMs: null,
				timeoutMs: 10000,
			},
			header: { capture: "missing", bytes: null, capturedAt: null },
		})
		expect(backoff.ok).toBe(true)
		if (backoff.ok)
			expect(backoff.value.peerHeader).toEqual({
				state: "unknown",
				reason: "not-connected",
			})
	})

	// Feature: receiver-capabilities, Property 2: Header chunk invariance
	// Validates: Requirements 1.3, 2.4
	it("projects arbitrary synthetic capture partitions identically after completion, never before", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 0xffffffff }),
				fc.integer({ min: 0, max: 0xffffffff }),
				fc.array(fc.integer({ min: 0, max: 12 }), { maxLength: 12 }),
				(tunerType, gainCount, cuts) => {
					const bytes = header(tunerType, gainCount)
					const points = [...new Set([0, ...cuts, 12])].sort((a, b) => a - b)
					const chunks = points
						.slice(1)
						.map((point, index) => bytes.subarray(points[index], point))
					let captured = Buffer.alloc(0)
					for (const chunk of chunks) {
						captured = Buffer.concat([captured, chunk])
						const capture =
							captured.length === 12
								? "complete"
								: captured.length
									? "partial"
									: "missing"
						const projected = projectReceiverHeader({
							...evidence(),
							header: {
								capture,
								bytes: capture === "complete" ? captured : null,
								capturedAt: capture === "complete" ? now : null,
							},
						})
						if (capture !== "complete") expect(projected.state).toBe("unknown")
						else
							expect(projected).toEqual({
								state: "advertised",
								provenance: "rtl-peer-header",
								sessionId: token(2),
								observedAt: new Date(now).toISOString(),
								tunerType,
								gainCount,
							})
					}
					expect(parseRtlPeerHeader(captured)).toEqual({ tunerType, gainCount })
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("injected admitted REST policy", () => {
	it("has exactly the fixed fifteen rows, distinct gain/index units and no local numeric fallback", () => {
		const policy = prepareReceiverPolicy(fixturePolicy())
		expect(policy).not.toBeNull()
		if (!policy) return
		const rows = projectReceiverControls(policy, true)
		expect(rows.map(row => [row.id, row.unit, row.command.opcode])).toEqual([
			["frequency", "Hz", 1],
			["sampleRate", "Hz", 2],
			["gainMode", "enum", 3],
			["gain", "tenthsDb", 4],
			["ppm", "ppm", 5],
			["ifGain", "rawInteger", 6],
			["testMode", "boolean", 7],
			["agcMode", "boolean", 8],
			["directSampling", "enum", 9],
			["offsetTuning", "boolean", 10],
			["rtlXtal", "Hz", 11],
			["tunerXtal", "Hz", 12],
			["gainIndex", "index", 13],
			["biasTee", "boolean", 14],
			["tunerIfGain", "stageRawPair", 15],
		])
		expect(rows[0]?.command.validation.rule).toEqual({
			kind: "integer-range",
			min: 0,
			max: 1000,
		})
		expect(
			rows.every(
				row =>
					row.command.validation.authority === "admitted-rest-argument-policy",
			),
		).toBe(true)
		expect(
			rows.every(
				row =>
					row.physical.state === "unknown" &&
					row.currentValue.state === "unknown",
			),
		).toBe(true)
	})

	it("rejects missing/extra/reordered/misunit/mistyped/overlong descriptor rows atomically", () => {
		const policy = fixturePolicy()
		const first = policy[0]
		if (!first) return
		for (const invalid of [
			policy.slice(1),
			[...policy, first],
			[...policy].reverse(),
			policy.map((row, i) =>
				i === 0 ? { ...row, unit: "index" as const } : row,
			),
			policy.map((row, i) =>
				i === 0 ? { ...row, rule: { kind: "boolean" as const } } : row,
			),
			policy.map((row, i) =>
				i === 2
					? { ...row, rule: { kind: "enum" as const, values: ["wrong"] } }
					: row,
			),
			policy.map((row, i) =>
				i === 0
					? { ...row, rule: { kind: "integer-range" as const, min: 2, max: 1 } }
					: row,
			),
		])
			expect(prepareReceiverPolicy(invalid)).toBeNull()
	})

	it("refuses sparse logical lengths at policy/ranges/enum boundaries before Zod expansion", () => {
		for (const length of [33, 4096]) {
			const sparseRows: ReceiverRestCommandPolicy[number][] = []
			sparseRows.length = length
			const sparseValues: string[] = []
			sparseValues.length = length
			const sparseRanges: { min: number; max: number }[] = []
			sparseRanges.length = length
			const inputs = [
				sparseRows,
				fixturePolicy().map(row =>
					row.id === "gainMode"
						? { ...row, rule: { kind: "enum", values: sparseValues } }
						: row,
				),
				fixturePolicy().map(row =>
					row.id === "sampleRate"
						? { ...row, rule: { kind: "integer-ranges", ranges: sparseRanges } }
						: row,
				),
			] as unknown as ReceiverRestCommandPolicy[]
			for (const policy of inputs) {
				expect(isDetachedPlainData(policy)).toBe(false)
				expect(prepareReceiverPolicy(policy)).toBeNull()
				let reads = 0
				const provider = createReceiverCapabilitiesProvider(
					{
						read: () => {
							reads++
							return { kind: "missing" }
						},
						readPage: () => {
							reads++
							return { kind: "unavailable" }
						},
					},
					policy,
				)
				expect(provider.get("test")).toEqual({ ok: false, code: "CONFLICT" })
				expect(provider.list({ after: null, limit: 16 })).toEqual({
					ok: false,
					code: "CONFLICT",
				})
				expect(reads).toBe(0)
			}
		}
	})

	it("rejects short holes and decorated nested arrays while admitting legal maximum shapes", () => {
		const holeRows = [...fixturePolicy()]
		delete holeRows[0]
		const decoratedRows = [...fixturePolicy()]
		Object.defineProperty(decoratedRows, "extra", { value: 1 })
		const holeValues = ["manual", "agc"]
		delete holeValues[1]
		const decoratedRanges = [
			{ min: 100, max: 200 },
			{ min: 300, max: 400 },
		]
		Object.defineProperty(decoratedRanges, "01", {
			value: { min: 500, max: 600 },
		})
		const inputs = [
			holeRows,
			decoratedRows,
			fixturePolicy().map(row =>
				row.id === "gainMode"
					? { ...row, rule: { kind: "enum", values: holeValues } }
					: row,
			),
			fixturePolicy().map(row =>
				row.id === "sampleRate"
					? {
							...row,
							rule: { kind: "integer-ranges", ranges: decoratedRanges },
						}
					: row,
			),
		] as unknown as ReceiverRestCommandPolicy[]
		for (const policy of inputs) {
			expect(isDetachedPlainData(policy)).toBe(false)
			expect(prepareReceiverPolicy(policy)).toBeNull()
		}
		const maximum = fixturePolicy()
		expect(maximum).toHaveLength(15)
		expect(maximum[1]?.rule).toMatchObject({
			kind: "integer-ranges",
			ranges: [
				{ min: 100, max: 200 },
				{ min: 300, max: 400 },
			],
		})
		expect(maximum[8]?.rule).toEqual({
			kind: "enum",
			values: ["off", "i", "q"],
		})
		expect(isDetachedPlainData(maximum)).toBe(true)
		expect(prepareReceiverPolicy(maximum)).not.toBeNull()
	})

	// Feature: receiver-capabilities, Property 3: Authority separation
	// Validates: Requirements 1.2, 1.4, 1.5, 3.4
	it("preserves injected numeric policy without treating it as RF support or gain tables", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: -1000000, max: 0 }),
				fc.integer({ min: 1, max: 1000000 }),
				fc.boolean(),
				(min, max, rtl) => {
					const fixture = fixturePolicy().map(row =>
						row.id === "gain"
							? { ...row, rule: { kind: "integer-range" as const, min, max } }
							: row,
					)
					const policy = prepareReceiverPolicy(fixture)
					expect(policy).not.toBeNull()
					if (!policy) return
					const rows = projectReceiverControls(policy, rtl)
					expect(rows[3]?.command.validation.rule).toEqual({
						kind: "integer-range",
						min,
						max,
					})
					expect(rows[3]?.unit).toBe("tenthsDb")
					expect(rows[12]?.unit).toBe("index")
					for (const row of rows) {
						expect(row.physical).toEqual({
							state: "unknown",
							reason: "no-qualified-readback",
						})
						expect(row.currentValue.state).toBe("unknown")
						expect(row.transport.state).toBe(
							rtl ? "applicable" : "not-applicable",
						)
						expect(row).not.toHaveProperty("gainTable")
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

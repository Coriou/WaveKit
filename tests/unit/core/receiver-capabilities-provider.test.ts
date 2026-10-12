import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import { createReceiverCapabilitiesProvider } from "../../../src/core/tuner-capabilities/provider.js"
import { RECEIVER_CONTROL_METADATA } from "../../../src/core/tuner-capabilities/rtl-tcp.js"
import {
	isDetachedPlainData,
	isReceiverSourceId,
} from "../../../src/core/tuner-capabilities/types.js"
import type {
	ReceiverEvidencePageRead,
	ReceiverEvidenceRead,
	ReceiverEvidenceReader,
	ReceiverRestCommandPolicy,
	SourceReceiverEvidence,
} from "../../../src/core/tuner-capabilities/types.js"

const now = Date.UTC(2026, 0, 2)
const token = (value: number) => value.toString(16).padStart(32, "0")

// TEST-only admitted policy. This is not a production descriptor or RF evidence.
function fixturePolicy(): ReceiverRestCommandPolicy {
	return RECEIVER_CONTROL_METADATA.map(row => {
		if (row.kind === "boolean")
			return { ...row, rule: { kind: "boolean" as const } }
		if (row.kind === "uint16-pair")
			return { ...row, rule: { kind: "uint16-pair" as const } }
		if (row.kind === "enum")
			return {
				...row,
				rule: {
					kind: "enum" as const,
					values: row.id === "gainMode" ? ["manual", "agc"] : ["off", "i", "q"],
				},
			}
		if (row.kind === "integer-ranges")
			return {
				id: row.id,
				unit: row.unit,
				opcode: row.opcode,
				rule: {
					kind: "integer-ranges" as const,
					ranges: [
						{ min: 10, max: 20 },
						{ min: 30, max: 40 },
					] as const,
				},
			}
		return {
			id: row.id,
			unit: row.unit,
			opcode: row.opcode,
			rule: {
				kind: "integer-range" as const,
				min: row.id === "ppm" ? -10 : 1,
				max: 100,
			},
		}
	}).map(({ id, unit, opcode, rule }) => ({ id, unit, opcode, rule }))
}

function evidence(sourceId = "test-source"): SourceReceiverEvidence {
	const bytes = Buffer.alloc(12)
	bytes.set([0x52, 0x54, 0x4c, 0x30])
	bytes.writeUInt32BE(0xffffffff, 4)
	bytes.writeUInt32BE(0xffffffff, 8)
	return {
		sourceId,
		sourceStateToken: {},
		sourceIncarnation: token(1),
		sessionId: token(2),
		snapshotId: token(3),
		capturedAt: now,
		source: { type: "rtl_tcp", kind: "iq", format: "U8_IQ" },
		caps: { sampleRate: 1000000, centerFreq: 100000000 },
		connection: "connected",
		delivery: {
			state: "streaming",
			lastSampleAt: now - 10,
			sampleAgeMs: 10,
			timeoutMs: 10000,
		},
		header: { capture: "complete", bytes, capturedAt: now - 100 },
	}
}

function readerFor(value: SourceReceiverEvidence) {
	return {
		read: vi.fn(
			(_id: string): ReceiverEvidenceRead => ({
				kind: "present",
				evidence: value,
			}),
		),
		readPage: vi.fn(
			(_after: string | null, _limit: number): ReceiverEvidencePageRead => ({
				kind: "candidates",
				candidates: [value],
				capturedAt: now,
				snapshotId: token(3),
			}),
		),
	}
}

function pageReader(candidates: readonly SourceReceiverEvidence[]) {
	return {
		read: vi.fn((_id: string): ReceiverEvidenceRead => ({ kind: "missing" })),
		readPage: vi.fn(
			(_after: string | null, _limit: number): ReceiverEvidencePageRead => ({
				kind: "candidates",
				candidates,
				capturedAt: now,
				snapshotId: candidates.length ? token(3) : null,
			}),
		),
	}
}

function retainedWaiting(
	type: "rtl_tcp" | "recording",
	age: number,
	sourceId = "test-source",
): SourceReceiverEvidence {
	const base = evidence(sourceId)
	return {
		...base,
		source: { ...base.source, type },
		sessionId: type === "recording" ? null : base.sessionId,
		delivery: {
			state: "waiting",
			lastSampleAt: now - age,
			sampleAgeMs: age,
			timeoutMs: 10000,
		},
		header:
			type === "recording"
				? { capture: "not-applicable", bytes: null, capturedAt: null }
				: { ...base.header, capturedAt: now - age - 100 },
	}
}

describe("receiver capabilities pure provider", () => {
	it.each([
		["rtl_tcp", 10000],
		["rtl_tcp", 10001],
		["recording", 10000],
		["recording", 10001],
	] as const)(
		"accepts %s retained waiting sample age %s in get, visible page and lookahead",
		(type, age) => {
			// Synthetic post-drain evidence only; actual expectedSince remains reader-owned.
			const input = retainedWaiting(type, age)
			const r = readerFor(input)
			const result = createReceiverCapabilitiesProvider(r, fixturePolicy()).get(
				input.sourceId,
			)
			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.value.delivery).toEqual({
					state: "waiting",
					lastSampleAt: new Date(now - age).toISOString(),
					sampleAgeMs: age,
					timeoutMs: 10000,
				})
				expect(result.value.sessionId).toBe(
					type === "recording" ? null : token(2),
				)
				expect(result.value.peerHeader.state).toBe(
					type === "recording" ? "not-applicable" : "advertised",
				)
				expect(
					result.value.controls.every(
						row =>
							row.physical.state === "unknown" &&
							row.currentValue.state === "unknown",
					),
				).toBe(true)
			}
			expect(r.read).toHaveBeenCalledTimes(1)
			expect(r.readPage).not.toHaveBeenCalled()
			const visibleReader = pageReader([input])
			const visible = createReceiverCapabilitiesProvider(
				visibleReader,
				fixturePolicy(),
			).list({ after: null, limit: 1 })
			expect(visible.ok).toBe(true)
			if (visible.ok) {
				expect(visible.value.items[0]?.delivery.lastSampleAt).toBe(
					new Date(now - age).toISOString(),
				)
				expect(visible.value.items[0]?.delivery.sampleAgeMs).toBe(age)
				expect(visible.value.nextAfter).toBeNull()
			}
			expect(visibleReader.readPage).toHaveBeenCalledTimes(1)
			expect(visibleReader.read).not.toHaveBeenCalled()
			const lookaheadReader = pageReader([
				evidence("a"),
				retainedWaiting(type, age, "b"),
			])
			const effects = { command: vi.fn(), connect: vi.fn(), on: vi.fn() }
			const lookahead = createReceiverCapabilitiesProvider(
				{ ...lookaheadReader, ...effects },
				fixturePolicy(),
			).list({ after: null, limit: 1 })
			expect(lookahead.ok).toBe(true)
			if (lookahead.ok) {
				expect(lookahead.value.items.map(item => item.sourceId)).toEqual(["a"])
				expect(lookahead.value.nextAfter).toBe("a")
			}
			expect(lookaheadReader.readPage).toHaveBeenCalledTimes(1)
			expect(lookaheadReader.read).not.toHaveBeenCalled()
			for (const effect of Object.values(effects))
				expect(effect).not.toHaveBeenCalled()
		},
	)

	it("rejects fresh waiting samples in get and whole visible/lookahead pages without rereads", () => {
		for (const type of ["rtl_tcp", "recording"] as const) {
			for (const age of [0, 9999]) {
				const input = retainedWaiting(type, age)
				const r = readerFor(input)
				expect(
					createReceiverCapabilitiesProvider(r, fixturePolicy()).get(
						input.sourceId,
					),
				).toEqual({ ok: false, code: "CONFLICT" })
				expect(r.read).toHaveBeenCalledTimes(1)
				for (const candidates of [
					[input],
					[evidence("a"), retainedWaiting(type, age, "b")],
				]) {
					const p = pageReader(candidates)
					expect(
						createReceiverCapabilitiesProvider(p, fixturePolicy()).list({
							after: null,
							limit: 1,
						}),
					).toEqual({ ok: false, code: "CONFLICT" })
					expect(p.readPage).toHaveBeenCalledTimes(1)
					expect(p.read).not.toHaveBeenCalled()
				}
			}
		}
	})

	it("keeps waiting paired-null, timestamp, session, connection and header contradictions closed", () => {
		for (const type of ["rtl_tcp", "recording"] as const) {
			const base = retainedWaiting(type, 10001, "b")
			const invalid: SourceReceiverEvidence[] = [
				{ ...base, delivery: { ...base.delivery, sampleAgeMs: null } },
				{ ...base, delivery: { ...base.delivery, lastSampleAt: null } },
				{ ...base, delivery: { ...base.delivery, sampleAgeMs: 10000 } },
				{
					...base,
					delivery: { ...base.delivery, lastSampleAt: now + 1, sampleAgeMs: 0 },
				},
				{ ...base, sessionId: type === "recording" ? token(2) : null },
				{ ...base, connection: "disconnected", sessionId: null },
				{ ...base, connection: "connecting" },
				{ ...base, connection: "ended", sessionId: null },
				{
					...base,
					header:
						type === "recording"
							? evidence().header
							: { ...base.header, capturedAt: now + 1 },
				},
			]
			for (const input of invalid) {
				const r = readerFor(input)
				expect(
					createReceiverCapabilitiesProvider(r, fixturePolicy()).get(
						input.sourceId,
					),
				).toEqual({ ok: false, code: "CONFLICT" })
				const p = pageReader([evidence("a"), input])
				expect(
					createReceiverCapabilitiesProvider(p, fixturePolicy()).list({
						after: null,
						limit: 1,
					}),
				).toEqual({ ok: false, code: "CONFLICT" })
				expect(r.read).toHaveBeenCalledTimes(1)
				expect(p.readPage).toHaveBeenCalledTimes(1)
				expect(p.read).not.toHaveBeenCalled()
			}
			const nullSample = {
				...base,
				delivery: { ...base.delivery, lastSampleAt: null, sampleAgeMs: null },
			}
			expect(
				createReceiverCapabilitiesProvider(
					readerFor(nullSample),
					fixturePolicy(),
				).get(nullSample.sourceId).ok,
			).toBe(true)
		}
	})

	it("prevalidates and detaches descriptor before the one reader call", () => {
		const r = readerFor(evidence())
		const policy = fixturePolicy()
		const provider = createReceiverCapabilitiesProvider(r, policy)
		const first = provider.get("test-source")
		expect(first.ok).toBe(true)
		expect(r.read).toHaveBeenCalledTimes(1)
		if (!first.ok) return
		expect(first.value.controls[0]?.command.validation.rule).toEqual({
			kind: "integer-range",
			min: 1,
			max: 100,
		})
		expect(first.value.peerHeader).toMatchObject({
			state: "advertised",
			gainCount: 0xffffffff,
		})
		expect(first.value).not.toHaveProperty("sourceStateToken")
		expect(first.value).not.toHaveProperty("header")
		const bad = createReceiverCapabilitiesProvider(r, policy.slice(1))
		expect(bad.get("test-source")).toEqual({ ok: false, code: "CONFLICT" })
		expect(bad.list({ after: null, limit: 8 })).toEqual({
			ok: false,
			code: "CONFLICT",
		})
		expect(r.read).toHaveBeenCalledTimes(1)
		expect(r.readPage).not.toHaveBeenCalled()
	})

	it("rejects descriptor accessors and oversized enum rules before any reader effect", () => {
		const r = readerFor(evidence())
		const getter = vi.fn(() => "frequency")
		const policy = fixturePolicy().map(row => ({ ...row }))
		Object.defineProperty(policy[0], "id", { get: getter, enumerable: true })
		expect(
			createReceiverCapabilitiesProvider(r, policy).get("test-source"),
		).toEqual({ ok: false, code: "CONFLICT" })
		expect(getter).not.toHaveBeenCalled()
		const oversized = fixturePolicy().map(row =>
			row.id === "gainMode"
				? {
						...row,
						rule: { kind: "enum" as const, values: ["x".repeat(20000)] },
					}
				: row,
		)
		expect(
			createReceiverCapabilitiesProvider(r, oversized).list({
				after: null,
				limit: 16,
			}),
		).toEqual({ ok: false, code: "CONFLICT" })
		expect(r.read).not.toHaveBeenCalled()
		expect(r.readPage).not.toHaveBeenCalled()
	})

	it.each(["missing", "unavailable", "conflict", "limit"] as const)(
		"maps reader %s without a fallback",
		kind => {
			const read = vi.fn((): ReceiverEvidenceRead => ({ kind }))
			const r: ReceiverEvidenceReader = {
				read,
				readPage: () => ({ kind: "unavailable" }),
			}
			expect(
				createReceiverCapabilitiesProvider(r, fixturePolicy()).get("source"),
			).toEqual({
				ok: false,
				code: {
					missing: "NOT_FOUND",
					unavailable: "UNAVAILABLE",
					conflict: "CONFLICT",
					limit: "LIMIT",
				}[kind],
			})
			expect(read).toHaveBeenCalledTimes(1)
		},
	)

	it("returns FAILED on unexpected reader failure and UNAVAILABLE after idempotent disposal", () => {
		const r = readerFor(evidence())
		r.read.mockImplementation(() => {
			throw new TypeError("private reader detail")
		})
		const provider = createReceiverCapabilitiesProvider(r, fixturePolicy())
		expect(provider.get("test-source")).toEqual({ ok: false, code: "FAILED" })
		provider.dispose()
		provider.dispose()
		expect(provider.get("test-source")).toEqual({
			ok: false,
			code: "UNAVAILABLE",
		})
		expect(provider.list({ after: null, limit: 8 })).toEqual({
			ok: false,
			code: "UNAVAILABLE",
		})
		expect(r.read).toHaveBeenCalledTimes(1)
		expect(r.readPage).not.toHaveBeenCalled()
		expect(
			createReceiverCapabilitiesProvider(null, fixturePolicy()).get("missing"),
		).toEqual({ ok: false, code: "UNAVAILABLE" })
	})

	it("distinguishes internal absent invalid ID from present invalid source LIMIT", () => {
		for (const id of [
			"a".repeat(101),
			"a".repeat(513),
			"bad/id",
			"\ud800",
			"",
			"\u0800".repeat(86),
		]) {
			const present = readerFor(evidence(id))
			expect(
				createReceiverCapabilitiesProvider(present, fixturePolicy()).get(id),
			).toEqual({ ok: false, code: "LIMIT" })
			expect(present.read).toHaveBeenCalledWith(id)
			const absent = pageReader([])
			expect(
				createReceiverCapabilitiesProvider(absent, fixturePolicy()).get(id),
			).toEqual({ ok: false, code: "NOT_FOUND" })
		}
	})

	it("implements scalar, UTF8 and decoded UTF16 bounds without normalization", () => {
		for (const id of [
			"a".repeat(100),
			"é".repeat(100),
			"\u0800".repeat(85),
			"😀".repeat(50),
			"\u0800".repeat(84) + "abcd",
			"%2F",
			"a b",
			"e\u0301",
		])
			expect(isReceiverSourceId(id)).toBe(true)
		for (const id of [
			"a".repeat(101),
			"é".repeat(128),
			"\u0800".repeat(86),
			"😀".repeat(51),
			"\u0800".repeat(84) + "abcde",
			"\udfff",
			"a\\b",
			"a?b",
			"a#b",
			"a\u007fb",
		])
			expect(isReceiverSourceId(id)).toBe(false)
	})

	it.each([0, 17, -1, 1.5, NaN, Infinity])(
		"rejects internal limit %s before page read",
		limit => {
			const r = pageReader([])
			expect(
				createReceiverCapabilitiesProvider(r, fixturePolicy()).list({
					after: null,
					limit,
				}),
			).toEqual({ ok: false, code: "CONFLICT" })
			expect(r.readPage).not.toHaveBeenCalled()
		},
	)

	it("rejects invalid internal cursor before page read", () => {
		const r = pageReader([])
		const provider = createReceiverCapabilitiesProvider(r, fixturePolicy())
		for (const after of ["", "a".repeat(101), "a/b", "\ud800"])
			expect(provider.list({ after, limit: 8 })).toEqual({
				ok: false,
				code: "CONFLICT",
			})
		expect(r.readPage).not.toHaveBeenCalled()
	})

	it("rejects a nonstring internal get without a reader call", () => {
		const r = readerFor(evidence())
		expect(
			createReceiverCapabilitiesProvider(r, fixturePolicy()).get(
				123 as unknown as string,
			),
		).toEqual({ ok: false, code: "CONFLICT" })
		expect(r.read).not.toHaveBeenCalled()
	})

	it("returns CONFLICT for malformed list records without invoking accessors or reader", () => {
		const r = pageReader([])
		const provider = createReceiverCapabilitiesProvider(r, fixturePolicy())
		const getter = vi.fn(() => 8)
		const accessor = { after: null }
		Object.defineProperty(accessor, "limit", { get: getter, enumerable: true })
		const hiddenExtra = { after: null, limit: 8 }
		Object.defineProperty(hiddenExtra, "extra", { value: 1 })
		const malformed: unknown[] = [
			null,
			undefined,
			true,
			false,
			8,
			NaN,
			"input",
			Symbol("input"),
			[],
			[null, 8],
			{},
			{ after: null },
			{ limit: 8 },
			{ after: null, limit: 8, extra: 1 },
			{ a: null, b: 8 },
			{ after: undefined, limit: 8 },
			{ after: null, limit: "8" },
			new Date(now),
			accessor,
			hiddenExtra,
		]
		for (const input of malformed)
			expect(
				provider.list(input as Parameters<typeof provider.list>[0]),
			).toEqual({ ok: false, code: "CONFLICT" })
		expect(getter).not.toHaveBeenCalled()
		expect(r.readPage).not.toHaveBeenCalled()
		expect(r.read).not.toHaveBeenCalled()
	})

	it("contains throwing list reflection traps as FAILED with zero reads", () => {
		const r = pageReader([])
		const provider = createReceiverCapabilitiesProvider(r, fixturePolicy())
		const throwTrap = () => {
			throw new TypeError("private reflection detail")
		}
		for (const input of [
			new Proxy({ after: null, limit: 8 }, { getPrototypeOf: throwTrap }),
			new Proxy({ after: null, limit: 8 }, { ownKeys: throwTrap }),
			new Proxy(
				{ after: null, limit: 8 },
				{ getOwnPropertyDescriptor: throwTrap },
			),
			new Proxy({ after: null, limit: 8 }, { get: throwTrap }),
		])
			expect(provider.list(input)).toEqual({ ok: false, code: "FAILED" })
		expect(r.readPage).not.toHaveBeenCalled()
		expect(r.read).not.toHaveBeenCalled()
	})

	it("preserves absent/disposed UNAVAILABLE before malformed input reflection", () => {
		const trap = vi.fn(() => {
			throw new TypeError("must not reflect")
		})
		const input = new Proxy(
			{ after: null, limit: 8 },
			{ getPrototypeOf: trap, ownKeys: trap },
		)
		const r = pageReader([])
		const disposed = createReceiverCapabilitiesProvider(r, fixturePolicy())
		disposed.dispose()
		for (const provider of [
			disposed,
			createReceiverCapabilitiesProvider(null, fixturePolicy()),
		]) {
			expect(provider.list(input)).toEqual({ ok: false, code: "UNAVAILABLE" })
			expect(
				provider.list(null as unknown as Parameters<typeof provider.list>[0]),
			).toEqual({ ok: false, code: "UNAVAILABLE" })
		}
		expect(trap).not.toHaveBeenCalled()
		expect(r.readPage).not.toHaveBeenCalled()
	})

	it("preflights logical array length, dense indices and decorations before schema expansion", () => {
		// These small sparse fixtures safely expose logical-length bypasses; no OOM test.
		for (const length of [33, 4096]) {
			const sparse: unknown[] = []
			sparse.length = length
			expect(isDetachedPlainData(sparse)).toBe(false)
			expect(isDetachedPlainData({ nested: sparse })).toBe(false)
		}
		const oversized: unknown[] = []
		oversized.length = 33
		const enumerate = vi.fn(() => {
			throw new TypeError("must reject length before enumeration")
		})
		expect(
			isDetachedPlainData(new Proxy(oversized, { ownKeys: enumerate })),
		).toBe(false)
		expect(enumerate).not.toHaveBeenCalled()
		const hole = [1, 2, 3]
		delete hole[1]
		const decorated = [1, 2]
		Object.defineProperty(decorated, "extra", { value: 3 })
		const symbolic = [1]
		Object.defineProperty(symbolic, Symbol("extra"), { value: 3 })
		const getter = vi.fn(() => 1)
		const accessor = [1]
		Object.defineProperty(accessor, "0", { get: getter })
		for (const value of [hole, decorated, symbolic, accessor])
			expect(isDetachedPlainData(value)).toBe(false)
		expect(getter).not.toHaveBeenCalled()
		expect(
			isDetachedPlainData(Array.from({ length: 32 }, (_, index) => index)),
		).toBe(true)
		expect(isDetachedPlainData(fixturePolicy())).toBe(true)
		expect(
			isDetachedPlainData(
				{ candidates: Array.from({ length: 17 }, (_, i) => evidence(`s${i}`)) },
				true,
			),
		).toBe(true)
	})

	it("rejects sparse arrays nested in evidence candidates/caps without a second read", () => {
		const sparse: SourceReceiverEvidence[] = []
		sparse.length = 4096
		const r = pageReader(sparse)
		expect(
			createReceiverCapabilitiesProvider(r, fixturePolicy()).list({
				after: null,
				limit: 16,
			}),
		).toEqual({ ok: false, code: "CONFLICT" })
		expect(r.readPage).toHaveBeenCalledTimes(1)
		expect(r.read).not.toHaveBeenCalled()
		const caps: number[] = []
		caps.length = 4096
		const invalid = { ...evidence(), caps } as unknown as SourceReceiverEvidence
		expect(
			createReceiverCapabilitiesProvider(
				readerFor(invalid),
				fixturePolicy(),
			).get(invalid.sourceId),
		).toEqual({ ok: false, code: "CONFLICT" })
	})

	it("propagates whole-page unavailable/conflict/limit and unexpected failure", () => {
		for (const kind of ["unavailable", "conflict", "limit"] as const) {
			const r = pageReader([])
			r.readPage.mockImplementation(() => ({ kind }))
			expect(
				createReceiverCapabilitiesProvider(r, fixturePolicy()).list({
					after: null,
					limit: 8,
				}),
			).toEqual({ ok: false, code: kind.toUpperCase() })
			expect(r.readPage).toHaveBeenCalledTimes(1)
		}
		const r = pageReader([])
		r.readPage.mockImplementation(() => {
			throw new TypeError("private failure")
		})
		expect(
			createReceiverCapabilitiesProvider(r, fixturePolicy()).list({
				after: null,
				limit: 8,
			}),
		).toEqual({ ok: false, code: "FAILED" })
	})

	it("validates lookahead before omission and rejects whole-page conflicts", () => {
		const a = evidence("a")
		const b = { ...evidence("b"), caps: { sampleRate: -1, centerFreq: null } }
		const r = pageReader([a, b])
		expect(
			createReceiverCapabilitiesProvider(r, fixturePolicy()).list({
				after: null,
				limit: 1,
			}),
		).toEqual({ ok: false, code: "CONFLICT" })
		expect(r.readPage).toHaveBeenCalledTimes(1)
		expect(r.read).not.toHaveBeenCalled()
		const invalidLookahead = pageReader([a, evidence("b".repeat(101))])
		expect(
			createReceiverCapabilitiesProvider(
				invalidLookahead,
				fixturePolicy(),
			).list({ after: null, limit: 1 }),
		).toEqual({ ok: false, code: "LIMIT" })
	})

	it("checks common now/token, strict UTF8 order, exclusive cursor and candidate bound", () => {
		for (const candidates of [
			[evidence("a"), { ...evidence("b"), capturedAt: now + 1 }],
			[evidence("a"), { ...evidence("b"), snapshotId: token(4) }],
			[evidence("b"), evidence("a")],
			[evidence("a"), evidence("a")],
		])
			expect(
				createReceiverCapabilitiesProvider(
					pageReader(candidates),
					fixturePolicy(),
				).list({ after: null, limit: 1 }),
			).toEqual({ ok: false, code: "CONFLICT" })
		expect(
			createReceiverCapabilitiesProvider(
				pageReader([evidence("a")]),
				fixturePolicy(),
			).list({ after: "a", limit: 1 }),
		).toEqual({ ok: false, code: "CONFLICT" })
		expect(
			createReceiverCapabilitiesProvider(
				pageReader(
					Array.from({ length: 18 }, (_, i) =>
						evidence(String(i).padStart(2, "0")),
					),
				),
				fixturePolicy(),
			).list({ after: null, limit: 16 }),
		).toEqual({ ok: false, code: "LIMIT" })
	})

	it("rejects envelope contradictions even on an empty page", () => {
		const r = pageReader([])
		r.readPage.mockImplementation(() => ({
			kind: "candidates",
			candidates: [],
			capturedAt: now,
			snapshotId: token(3),
		}))
		expect(
			createReceiverCapabilitiesProvider(r, fixturePolicy()).list({
				after: null,
				limit: 8,
			}),
		).toEqual({ ok: false, code: "CONFLICT" })
		r.readPage.mockImplementation(() => ({
			kind: "candidates",
			candidates: [],
			capturedAt: Infinity,
			snapshotId: null,
		}))
		expect(
			createReceiverCapabilitiesProvider(r, fixturePolicy()).list({
				after: null,
				limit: 8,
			}),
		).toEqual({ ok: false, code: "CONFLICT" })
	})

	it("has no fake token for an empty page and uses null nextAfter at exact end", () => {
		for (const candidates of [[], [evidence("a")]]) {
			const r = pageReader(candidates)
			const result = createReceiverCapabilitiesProvider(
				r,
				fixturePolicy(),
			).list({ after: null, limit: 1 })
			expect(result.ok).toBe(true)
			if (result.ok) expect(result.value.nextAfter).toBeNull()
			expect(r.readPage).toHaveBeenCalledTimes(1)
		}
	})

	it("accepts the legal seventeen-candidate maximum before omitting lookahead", () => {
		const candidates = Array.from({ length: 17 }, (_, i) =>
			evidence(`s${String(i).padStart(2, "0")}`),
		)
		const r = pageReader(candidates)
		const result = createReceiverCapabilitiesProvider(r, fixturePolicy()).list({
			after: null,
			limit: 16,
		})
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value.items).toHaveLength(16)
			expect(result.value.nextAfter).toBe("s15")
		}
		expect(r.readPage).toHaveBeenCalledTimes(1)
	})

	it("uses an absent cursor as an exclusive UTF8 boundary without rereading it", () => {
		const r = pageReader([evidence("z"), evidence("é")])
		const result = createReceiverCapabilitiesProvider(r, fixturePolicy()).list({
			after: "removed",
			limit: 1,
		})
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value.items.map(item => item.sourceId)).toEqual(["z"])
			expect(result.value.nextAfter).toBe("z")
		}
		expect(r.readPage).toHaveBeenCalledWith("removed", 1)
		expect(r.read).not.toHaveBeenCalled()
	})

	it("orders U+E000 before U+10000 by UTF8 even though UTF16 ordering is inverted", () => {
		const bmp = "\ue000"
		const supplementary = "\u{10000}"
		expect(supplementary < bmp).toBe(true)
		const r = pageReader([evidence(bmp), evidence(supplementary)])
		const result = createReceiverCapabilitiesProvider(r, fixturePolicy()).list({
			after: null,
			limit: 1,
		})
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value.items.map(item => item.sourceId)).toEqual([bmp])
			expect(result.value.nextAfter).toBe(bmp)
		}
		const reversed = pageReader([evidence(supplementary), evidence(bmp)])
		expect(
			createReceiverCapabilitiesProvider(reversed, fixturePolicy()).list({
				after: null,
				limit: 1,
			}),
		).toEqual({ ok: false, code: "CONFLICT" })
	})

	it("fails closed on copied invariants, unknown fields and accessors without invoking them", () => {
		const base = evidence()
		const invalid = [
			{ ...base, snapshotId: "0".repeat(32) },
			{ ...base, sessionId: null },
			{ ...base, capturedAt: Infinity },
			{ ...base, sourceIncarnation: "UPPER" },
			{ ...base, header: { ...base.header, capturedAt: now + 1 } },
			{ ...base, header: { ...base.header, bytes: Buffer.alloc(13) } },
			{ ...base, delivery: { ...base.delivery, sampleAgeMs: 11 } },
			{
				...base,
				caps: { ...base.caps, sampleRate: Number.MAX_SAFE_INTEGER + 1 },
			},
			{ ...base, privateField: "not public" },
		]
		for (const value of invalid)
			expect(
				createReceiverCapabilitiesProvider(
					readerFor(value),
					fixturePolicy(),
				).get("test-source"),
			).toEqual({ ok: false, code: "CONFLICT" })
		const getter = vi.fn(() => 123)
		const accessor = { ...base }
		Object.defineProperty(accessor, "capturedAt", {
			get: getter,
			enumerable: true,
		})
		expect(
			createReceiverCapabilitiesProvider(
				readerFor(accessor),
				fixturePolicy(),
			).get("test-source"),
		).toEqual({ ok: false, code: "CONFLICT" })
		expect(getter).not.toHaveBeenCalled()
	})

	it("simulates reader token consumption before a lookahead projection failure without certifying a real allocator", () => {
		let allocated = 3
		const r: ReceiverEvidenceReader = {
			read: () => ({ kind: "missing" }),
			readPage: () => {
				const snapshotId = token(allocated++)
				return {
					kind: "candidates",
					capturedAt: now,
					snapshotId,
					candidates: [
						{ ...evidence("a"), snapshotId },
						{
							...evidence("b"),
							snapshotId,
							caps: { sampleRate: 0, centerFreq: null },
						},
					],
				}
			},
		}
		const provider = createReceiverCapabilitiesProvider(r, fixturePolicy())
		expect(provider.list({ after: null, limit: 1 })).toEqual({
			ok: false,
			code: "CONFLICT",
		})
		expect(allocated).toBe(4)
		expect(provider.list({ after: null, limit: 1 })).toEqual({
			ok: false,
			code: "CONFLICT",
		})
		expect(allocated).toBe(5)
	})

	// Feature: receiver-capabilities, Property 3: Authority separation
	// Validates: Requirements 1.2, 1.4, 1.5, 3.4
	it("never upgrades configured declarations or peer numbers into physical/current values", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 0xffffffff }),
				fc.integer({ min: 1, max: 0xffffffff }),
				(rate, frequency) => {
					const input = {
						...evidence(),
						caps: { sampleRate: rate, centerFreq: frequency },
					}
					const result = createReceiverCapabilitiesProvider(
						readerFor(input),
						fixturePolicy(),
					).get(input.sourceId)
					expect(result.ok).toBe(true)
					if (!result.ok) return
					expect(result.value.declaredStream).toEqual({
						provenance: "source-config-or-core-metadata",
						sampleRateHz: rate,
						centerFrequencyHz: frequency,
					})
					expect(result.value.controls).toHaveLength(15)
					for (const row of result.value.controls) {
						expect(row.physical).toEqual({
							state: "unknown",
							reason: "no-qualified-readback",
						})
						expect(row.currentValue.state).toBe("unknown")
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: receiver-capabilities, Property 4: Detached coherence
	// Validates: Requirements 2.2, 3.2, 3.5
	it("keeps each captured DTO immutable and detached from later reader/policy mutation", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 10000000 }), rate => {
				const input = evidence()
				const policy = fixturePolicy()
				const provider = createReceiverCapabilitiesProvider(
					readerFor(input),
					policy,
				)
				const result = provider.get(input.sourceId)
				expect(result.ok).toBe(true)
				if (!result.ok) return
				const serialized = JSON.stringify(result.value)
				Object.assign(input.caps, { sampleRate: rate })
				input.header.bytes?.fill(0)
				const rule = policy[0]?.rule
				if (rule?.kind === "integer-range") Object.assign(rule, { max: 2 })
				expect(JSON.stringify(result.value)).toBe(serialized)
				expect(Object.isFrozen(result.value)).toBe(true)
				expect(
					Object.isFrozen(result.value.controls[0]?.command.validation.rule),
				).toBe(true)
				expect(() =>
					Object.assign(result.value.source, { type: "recording" }),
				).toThrow(TypeError)
				const later = provider.get(input.sourceId)
				if (later.ok)
					expect(later.value.controls[0]?.command.validation.rule).toEqual({
						kind: "integer-range",
						min: 1,
						max: 100,
					})
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: receiver-capabilities, Property 5: Read purity/bounds/pagination
	// Validates: Requirements 1.6, 3.2, 3.5, 3.7
	it("projects bounded pages with one read and a validated exclusive lookahead", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 16 }),
				fc.integer({ min: 0, max: 17 }),
				(limit, count) => {
					const candidates = Array.from(
						{ length: Math.min(count, limit + 1) },
						(_, index) => evidence(`test-${String(index).padStart(2, "0")}`),
					)
					const r = pageReader(candidates)
					const sideEffects = {
						connect: vi.fn(),
						command: vi.fn(),
						on: vi.fn(),
						start: vi.fn(),
					}
					const provider = createReceiverCapabilitiesProvider(
						{ ...r, ...sideEffects },
						fixturePolicy(),
					)
					const result = provider.list({ after: null, limit })
					expect(result.ok).toBe(true)
					if (!result.ok) return
					expect(result.value.items.map(item => item.sourceId)).toEqual(
						candidates.slice(0, limit).map(item => item.sourceId),
					)
					expect(result.value.nextAfter).toBe(
						candidates.length > limit ? candidates[limit - 1]?.sourceId : null,
					)
					expect(
						Buffer.byteLength(JSON.stringify(result.value)),
					).toBeLessThanOrEqual(256 * 1024)
					for (const item of result.value.items)
						expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(
							16 * 1024,
						)
					expect(r.readPage).toHaveBeenCalledTimes(1)
					expect(r.read).not.toHaveBeenCalled()
					for (const call of Object.values(sideEffects))
						expect(call).not.toHaveBeenCalled()
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: receiver-capabilities, Property 5: Read purity/bounds/pagination
	// Validates: Requirements 3.2, 3.7
	it("applies independent UTF8 and UTF16 bounds to generated exact IDs", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("a", "é", "\u0800", "😀"),
				fc.integer({ min: 1, max: 130 }),
				(scalar, count) => {
					const id = scalar.repeat(count)
					const representable =
						id.length <= 100 && Buffer.byteLength(id, "utf8") <= 256
					const r = readerFor(evidence(id))
					const result = createReceiverCapabilitiesProvider(
						r,
						fixturePolicy(),
					).get(id)
					expect(result.ok).toBe(representable)
					if (!representable)
						expect(result).toEqual({ ok: false, code: "LIMIT" })
					else if (result.ok) expect(result.value.sourceId).toBe(id)
					expect(r.read).toHaveBeenCalledTimes(1)
				},
			),
			{ numRuns: 100 },
		)
	})
})

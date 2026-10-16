import { describe, expect, it } from "vitest"
import { EventEmitter } from "node:events"
import fc from "fast-check"
import pino from "pino"
import type { DsdFmeLinkLine } from "../../../../src/decoders/builtin/dsd-fme-link.js"
import {
	AmbientEvidence,
	type AmbientDeps,
	type AmbientEvidenceEvent,
	type AmbientTarget,
} from "../../../../src/core/scanner/probes/ambient.js"
import {
	createInterpreterState,
	type DecoderOutputLike,
	type InterpreterState,
} from "../../../../src/core/scanner/probes/confirm/double-match.js"
import { interpretDirewolf } from "../../../../src/core/scanner/probes/confirm/direwolf.js"
import {
	interpretDsdFme,
	toDsdFmeScannerEvent,
} from "../../../../src/core/scanner/probes/confirm/dsd-fme.js"
import { interpretRtl433 } from "../../../../src/core/scanner/probes/confirm/rtl433.js"
import {
	CapcodeWindows,
	MULTIMON_HOLD_MS,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import type { DecodeEvidence } from "../../../../src/core/scanner/types.js"
import type { TuningTrust } from "../../../../src/core/spectrum/types.js"
import {
	createComponentLogger,
	type Logger,
} from "../../../../src/utils/logger.js"

// ---------------------------------------------------------------------------
// Reference: AmbientEvidence as of cccf665f (src/core/scanner/probes/ambient.ts:52-168),
// verbatim except for the class name and its deps type.
type RefDeps = Omit<AmbientDeps, "tuningTrustOf">
interface AmbientState {
	epoch: number
	interp: InterpreterState | null
	capcodes: CapcodeWindows | null
}
const AMBIENT_TYPES = new Set(["dsd-fme", "multimon-ng", "direwolf", "rtl433"])

class ReferenceAmbient extends EventEmitter {
	private readonly log: Logger
	private readonly now: () => number
	private readonly states = new Map<string, AmbientState>()
	private readonly types = new Map<string, string>()
	private readonly detach: (() => void)[] = []
	private running = false

	constructor(private readonly deps: RefDeps) {
		super()
		this.log = createComponentLogger(deps.logger, "AmbientEvidence")
		this.now = deps.now ?? Date.now
	}

	start(): void {
		if (this.running) return
		this.running = true
		for (const status of this.deps.decoders.getAllStatus()) {
			if (status.owner === "scanner" || !AMBIENT_TYPES.has(status.type))
				continue
			this.types.set(status.id, status.type)
			if (status.type !== "dsd-fme") continue
			const decoder = this.deps.decoders.getDecoder(status.id) as unknown as
				| EventEmitter
				| undefined
			if (!decoder) continue
			const onLink = (line: DsdFmeLinkLine): void =>
				this.handle(status.id, { kind: "link", line })
			decoder.on("link", onLink)
			this.detach.push(() => decoder.off("link", onLink))
		}
		this.deps.decoders.on("decoder:output", this.onOutput)
		this.log.info(
			{ decoders: [...this.types.keys()] },
			"Ambient evidence attached",
		)
	}

	stop(): void {
		if (!this.running) return
		this.running = false
		this.deps.decoders.off("decoder:output", this.onOutput)
		for (const off of this.detach.splice(0)) off()
		this.states.clear()
		this.types.clear()
	}

	private readonly onOutput = (
		decoderId: string,
		out: DecoderOutputLike,
	): void => {
		const type = this.types.get(decoderId)
		if (!type) return
		if (type === "dsd-fme") {
			const ev = toDsdFmeScannerEvent(out)
			if (ev) this.handle(decoderId, ev)
			return
		}
		this.handle(decoderId, out)
	}

	private handle(
		decoderId: string,
		input: Parameters<typeof interpretDsdFme>[0] | DecoderOutputLike,
	): void {
		if (!this.running) return
		const target = this.deps.targetOf(decoderId)
		if (!target) return
		const epoch = this.deps.epochOf(target.sourceId)
		if (epoch === null) return
		const type = this.types.get(decoderId)
		let entry = this.states.get(decoderId)
		if (!entry || entry.epoch !== epoch) {
			const create = (): InterpreterState =>
				createInterpreterState({
					epoch,
					origin: "ambient",
					decoderId,
					...(target.nxdn !== undefined ? { nxdn: target.nxdn } : {}),
				})
			const multimon = type === "multimon-ng"
			entry = {
				epoch,
				interp: multimon ? null : create(),
				capcodes: multimon
					? new CapcodeWindows(MULTIMON_HOLD_MS, create)
					: null,
			}
			this.states.set(decoderId, entry)
		}
		const state = entry.interp
		let evs: DecodeEvidence[] = []
		if (entry.capcodes)
			evs = entry.capcodes.interpret(input as DecoderOutputLike, this.now())
		else if (state === null) return
		else if (type === "dsd-fme")
			evs = interpretDsdFme(
				input as Parameters<typeof interpretDsdFme>[0],
				state,
			)
		else if (type === "direwolf")
			evs = interpretDirewolf(input as DecoderOutputLike, state)
		else if (type === "rtl433")
			evs = interpretRtl433(input as DecoderOutputLike, state)
		for (const ev of evs) {
			const event: AmbientEvidenceEvent = {
				decoderId,
				sourceId: target.sourceId,
				hz: target.hz,
				ev,
			}
			this.emit("evidence", event)
		}
	}
}

// ---------------------------------------------------------------------------
// Fakes

interface FakeStatus {
	id: string
	type: string
	owner?: "config" | "scanner"
	running: boolean
	health: "running" | "idle" | "restarting" | "faulted"
	suspended?: boolean
}

class FakeDecoders extends EventEmitter {
	readonly statuses = new Map<string, FakeStatus>()
	readonly instances = new Map<string, EventEmitter>()
	add(id: string, type: string, patch: Partial<FakeStatus> = {}): void {
		this.statuses.set(id, {
			id,
			type,
			owner: "config",
			running: true,
			health: "running",
			suspended: false,
			...patch,
		})
		this.instances.set(id, new EventEmitter())
	}
	patch(id: string, patch: Partial<FakeStatus>): void {
		const s = this.statuses.get(id)
		if (s) Object.assign(s, patch)
	}
	getAllStatus() {
		return [...this.statuses.values()] as never
	}
	getStatus(id: string) {
		const s = this.statuses.get(id)
		return (s ? { ...s } : undefined) as never
	}
	getDecoder(id: string) {
		return this.instances.get(id) as never
	}
	out(id: string, o: DecoderOutputLike): void {
		this.emit("decoder:output", id, o)
	}
}

const silent = pino({ level: "silent" })
const AIS_A = 161_975_000
const AIS_B = 162_025_000

const target = (
	hz: number,
	extra: Partial<AmbientTarget> = {},
): AmbientTarget => ({
	sourceId: "rtl",
	hz,
	targetsHz: [hz],
	external: false,
	...extra,
})

interface Rig {
	decoders: FakeDecoders
	ambient: AmbientEvidence
	got: AmbientEvidenceEvent[]
	epoch: { v: number }
}

function rig(opts: {
	add: (d: FakeDecoders) => void
	targets: Record<string, AmbientTarget>
	trust?: AmbientDeps["tuningTrustOf"] | null
	logger?: Logger
}): Rig {
	const decoders = new FakeDecoders()
	opts.add(decoders)
	const epoch = { v: 1 }
	const deps: AmbientDeps = {
		decoders: decoders as never,
		targetOf: id => opts.targets[id] ?? null,
		epochOf: () => epoch.v,
		logger: opts.logger ?? silent,
		now: () => 1_000,
	}
	if (opts.trust !== null)
		deps.tuningTrustOf = opts.trust ?? (() => "commanded")
	const ambient = new AmbientEvidence(deps)
	const got: AmbientEvidenceEvent[] = []
	ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
	ambient.start()
	return { decoders, ambient, got, epoch }
}

const ship = (mmsi: string, channel: "A" | "B" | undefined = "A") => ({
	type: "ship",
	data: { mmsi, ...(channel ? { channel } : {}) },
	timestamp: new Date(1_000),
})
const acars = (tail: string, frequency: number, error = 0) => ({
	type: "acars",
	data: { tail, frequency, error },
	timestamp: new Date(1_000),
})
const vdl2 = (fromaddr: string, frequency: number) => ({
	type: "vdl2",
	data: { fromaddr, frequency },
	timestamp: new Date(1_000),
})
const mesh = (from: number, frequency: number, viaMqtt = false) => ({
	type: "meshtastic",
	data: { from, frequency, viaMqtt },
	timestamp: new Date(1_000),
})

function aisRig(
	extra: Partial<FakeStatus> = {},
	trust?: AmbientDeps["tuningTrustOf"] | null,
	t: Partial<AmbientTarget> = {},
	logger?: Logger,
): Rig {
	return rig({
		add: d => d.add("ais", "ais-catcher", extra),
		targets: { ais: target(AIS_A, { targetsHz: [AIS_A, AIS_B], ...t }) },
		...(trust !== undefined ? { trust } : {}),
		...(logger ? { logger } : {}),
	})
}

const twice = (r: Rig, id: string, o: DecoderOutputLike): void => {
	r.decoders.out(id, o)
	r.decoders.out(id, o)
}

// ---------------------------------------------------------------------------

describe("AmbientEvidence WG7 new types", () => {
	it("names AIS, ACARS, VDL2 and LoRa at the decode's own frequency on the second clean decode", () => {
		const r = rig({
			add: d => {
				d.add("ais", "ais-catcher")
				d.add("acars", "acarsdec")
				d.add("vdl", "dumpvdl2")
				d.add("lora", "lora-meshtastic")
			},
			targets: {
				ais: target(AIS_A, { targetsHz: [AIS_A, AIS_B] }),
				acars: target(131_550_000),
				vdl: target(136_975_000),
				lora: target(869_525_000),
			},
		})
		twice(r, "ais", ship("244123456", "B"))
		twice(r, "acars", acars("PH-BXA", 131_550_200))
		twice(r, "vdl", vdl2("4840D6", 136_975_000))
		twice(r, "lora", mesh(0xdeadbeef, 869_525_000))
		const named = r.got.filter(e => e.ev.identity)
		expect(
			named.map(e => [e.decoderId, e.hz, e.ev.protocol, e.ev.identity?.value]),
		).toEqual([
			["ais", AIS_B, "ais", "244123456"],
			["acars", 131_550_200, "acars", "PH-BXA"],
			["vdl", 136_975_000, "vdl2", "4840D6"],
			["lora", 869_525_000, "lora", "!deadbeef"],
		])
		expect(r.got).toHaveLength(8)
		for (const e of r.got) {
			expect(e.ev.origin).toBe("ambient")
			expect("hz" in e.ev).toBe(false)
		}
	})

	it("drops an external-input decoder", () => {
		const r = aisRig({}, undefined, { external: true })
		twice(r, "ais", ship("244123456"))
		expect(r.got).toEqual([])
	})

	it("treats a target without external as external (no evidence, no coverage)", () => {
		const r = rig({
			add: d => d.add("ais", "ais-catcher"),
			targets: { ais: { sourceId: "rtl", hz: AIS_A, targetsHz: [AIS_A] } },
		})
		twice(r, "ais", ship("244123456"))
		expect(r.got).toEqual([])
		expect(r.ambient.coverageAt("rtl", AIS_A, 1_000)).toEqual([])
	})

	it("drops a target with missing or empty targetsHz (no evidence, no coverage)", () => {
		for (const t of [
			{ sourceId: "rtl", hz: AIS_A, external: false },
			{ sourceId: "rtl", hz: AIS_A, targetsHz: [], external: false },
		]) {
			const r = rig({
				add: d => d.add("ais", "ais-catcher"),
				targets: { ais: t },
			})
			twice(r, "ais", ship("244123456"))
			expect(r.got).toEqual([])
			expect(r.ambient.coverageAt("rtl", AIS_A, 1_000)).toEqual([])
		}
	})

	it("drops a scanner-owned decoder", () => {
		const r = aisRig()
		r.decoders.patch("ais", { owner: "scanner" })
		twice(r, "ais", ship("244123456"))
		expect(r.got).toEqual([])
	})

	it("drops a suspended decoder", () => {
		const r = aisRig({ suspended: true })
		twice(r, "ais", ship("244123456"))
		expect(r.got).toEqual([])
	})

	it("drops a stopped decoder and one with faulted health, read at decode time", () => {
		const r = aisRig()
		r.decoders.patch("ais", { running: false })
		twice(r, "ais", ship("244123456"))
		expect(r.got).toEqual([])
		r.decoders.patch("ais", { running: true, health: "faulted" })
		twice(r, "ais", ship("244123456"))
		expect(r.got).toEqual([])
		r.decoders.patch("ais", { health: "idle" })
		twice(r, "ais", ship("244123456"))
		expect(r.got.filter(e => e.ev.identity)).toHaveLength(1)
	})

	it("drops unverified trust", () => {
		const r = aisRig({}, () => "unverified")
		twice(r, "ais", ship("244123456"))
		expect(r.got).toEqual([])
		expect(r.ambient.trustDropCount).toBe(2)
	})

	it("drops everything when the trust dependency is absent", () => {
		const r = aisRig({}, null)
		twice(r, "ais", ship("244123456"))
		expect(r.got).toEqual([])
	})

	it("drops undefined trust", () => {
		const r = aisRig({}, () => undefined)
		twice(r, "ais", ship("244123456"))
		expect(r.got).toEqual([])
	})

	it("drops a throwing trust lookup and logs once per decoder without values", () => {
		const lines: string[] = []
		const logger = pino(
			{ level: "debug" },
			{ write: (s: string) => void lines.push(s) },
		)
		const r = aisRig(
			{},
			() => {
				throw new Error("secret 161975000")
			},
			{},
			logger,
		)
		twice(r, "ais", ship("244123456"))
		r.decoders.out("ais", ship("244123456"))
		expect(r.got).toEqual([])
		const warns = lines.filter(l => l.includes("tuning trust"))
		expect(warns).toHaveLength(1)
		expect(warns[0]).not.toMatch(/secret|161975000|244123456/)
	})

	it("an untrusted channel never feeds the double match", () => {
		let trustB: TuningTrust = "unverified"
		const r = aisRig({}, (_id, hz) => (hz === AIS_B ? trustB : "commanded"))
		r.decoders.out("ais", ship("244123456", "B"))
		trustB = "relay"
		r.decoders.out("ais", ship("244123456", "B"))
		expect(r.got).toHaveLength(1)
		expect(r.got[0]?.ev.identity).toBeUndefined()
	})

	it("an epoch change resets the identity", () => {
		const r = aisRig()
		r.decoders.out("ais", ship("244123456"))
		r.epoch.v = 2
		r.decoders.out("ais", ship("244123456"))
		expect(r.got.filter(e => e.ev.identity)).toEqual([])
		r.decoders.out("ais", ship("244123456"))
		expect(r.got.filter(e => e.ev.identity)).toHaveLength(1)
	})

	it("ignores a decoder whose type is not ambient", () => {
		const r = rig({
			add: d => d.add("adsb", "readsb"),
			targets: { adsb: target(1_090_000_000) },
		})
		twice(r, "adsb", ship("244123456"))
		expect(r.got).toEqual([])
		expect(r.ambient.coverageAt("rtl", 1_090_000_000, 1_000)).toEqual([])
	})

	it("drops a decode 1.5 kHz off its target", () => {
		const r = rig({
			add: d => d.add("acars", "acarsdec"),
			targets: { acars: target(131_550_000) },
		})
		twice(r, "acars", acars("PH-BXA", 131_551_500))
		expect(r.got).toEqual([])
	})

	it("survives a throwing targetOf and malformed output", () => {
		const decoders = new FakeDecoders()
		decoders.add("ais", "ais-catcher")
		const ambient = new AmbientEvidence({
			decoders: decoders as never,
			targetOf: () => {
				throw new Error("boom")
			},
			epochOf: () => 1,
			logger: silent,
			tuningTrustOf: () => "commanded",
		})
		ambient.start()
		expect(() => decoders.out("ais", ship("1"))).not.toThrow()
		expect(ambient.coverageAt("rtl", AIS_A, 1_000)).toEqual([])
		const r = aisRig()
		r.decoders.out("ais", { type: "ship", data: null, timestamp: new Date(1) })
		expect(r.got).toEqual([])
	})
})

describe("AmbientEvidence.coverageAt", () => {
	const covRig = () =>
		rig({
			add: d => {
				d.add("z-ais", "ais-catcher")
				d.add("a-vdl", "dumpvdl2")
				d.add("ext", "ais-catcher")
				d.add("dmr", "dsd-fme")
				d.add("other", "acarsdec")
			},
			targets: {
				"z-ais": target(AIS_A, { targetsHz: [AIS_A, AIS_B] }),
				"a-vdl": target(136_975_000, { targetsHz: [136_975_000, AIS_B - 500] }),
				ext: target(AIS_B, { external: true }),
				dmr: target(AIS_B),
				other: target(AIS_B, { sourceId: "sdrpp" }),
			},
		})

	it("lists running config-owned new-type decoders on the source, sorted", () => {
		const r = covRig()
		expect(r.ambient.coverageAt("rtl", AIS_B, 1_000)).toEqual([
			{ decoderId: "a-vdl", type: "dumpvdl2", protocol: "vdl2" },
			{ decoderId: "z-ais", type: "ais-catcher", protocol: "ais" },
		])
		expect(r.ambient.coverageAt("rtl", AIS_B, 100)).toEqual([
			{ decoderId: "z-ais", type: "ais-catcher", protocol: "ais" },
		])
	})

	it("excludes another source", () => {
		const r = covRig()
		expect(r.ambient.coverageAt("sdrpp", AIS_B, 1_000)).toEqual([
			{ decoderId: "other", type: "acarsdec", protocol: "acars" },
		])
		expect(r.ambient.coverageAt("nope", AIS_B, 1_000)).toEqual([])
	})

	it("reads status at call time and is empty when not started", () => {
		const r = covRig()
		r.decoders.patch("z-ais", { suspended: true })
		r.decoders.patch("a-vdl", { health: "restarting" })
		expect(r.ambient.coverageAt("rtl", AIS_B, 1_000)).toEqual([])
		r.ambient.stop()
		r.decoders.patch("z-ais", { suspended: false })
		expect(r.ambient.coverageAt("rtl", AIS_B, 1_000)).toEqual([])
	})
})

// ---------------------------------------------------------------------------

describe("WG7 properties", () => {
	// Feature: web-gaps-7, Property 1: Ambient trust rule
	// Validates: Requirements 1.2, 1.3
	it("emits a new-type decode only for an eligible decoder with commanded or relay trust", () => {
		const trustArb = fc.constantFrom<TuningTrust | undefined | "throw">(
			"commanded",
			"relay",
			"unverified",
			undefined,
			"throw",
		)
		fc.assert(
			fc.property(
				fc.record({
					running: fc.boolean(),
					health: fc.constantFrom("running", "idle", "restarting", "faulted"),
					suspended: fc.boolean(),
					owner: fc.constantFrom<"config" | "scanner">("config", "scanner"),
					external: fc.boolean(),
					trust: trustArb,
					dep: fc.boolean(),
				}),
				fc.constantFrom("ais", "acars", "vdl", "lora"),
				(s, which) => {
					const r = rig({
						add: d => {
							d.add("ais", "ais-catcher", s as Partial<FakeStatus>)
							d.add("acars", "acarsdec", s as Partial<FakeStatus>)
							d.add("vdl", "dumpvdl2", s as Partial<FakeStatus>)
							d.add("lora", "lora-meshtastic", s as Partial<FakeStatus>)
						},
						targets: {
							ais: target(AIS_A, { external: s.external }),
							acars: target(131_550_000, { external: s.external }),
							vdl: target(136_975_000, { external: s.external }),
							lora: target(869_525_000, { external: s.external }),
						},
						trust: s.dep
							? () => {
									if (s.trust === "throw") throw new Error("x")
									return s.trust
								}
							: null,
					})
					// owner is read at decode time; start() already skips scanner-owned
					const out =
						which === "ais"
							? ship("244123456")
							: which === "acars"
								? acars("PH-BXA", 131_550_000)
								: which === "vdl"
									? vdl2("4840D6", 136_975_000)
									: mesh(1, 869_525_000)
					twice(r, which, out)
					const ok =
						s.running &&
						(s.health === "running" || s.health === "idle") &&
						!s.suspended &&
						s.owner === "config" &&
						!s.external &&
						s.dep &&
						(s.trust === "commanded" || s.trust === "relay")
					expect(r.got.length).toBe(ok ? 2 : 0)
					r.ambient.stop()
				},
			),
			{ numRuns: 300 },
		)
	})

	// Feature: web-gaps-7, Property 2: Existing ambient unchanged
	// Validates: Requirements 1.4
	it("the existing types emit exactly what the cccf665f implementation emitted", () => {
		type Step =
			| { k: "epoch" }
			| { k: "tick"; ms: number }
			| { k: "link"; cc: number; crcErr: boolean }
			| { k: "out"; o: DecoderOutputLike }
		const at = new Date(5_000)
		const outArb: fc.Arbitrary<Step> = fc.oneof(
			fc.constant<Step>({ k: "epoch" }),
			fc.integer({ min: 0, max: 30_000 }).map<Step>(ms => ({ k: "tick", ms })),
			fc
				.record({ cc: fc.integer({ min: 0, max: 2 }), crcErr: fc.boolean() })
				.map<Step>(v => ({ k: "link", ...v })),
			fc
				.record({
					callId: fc.constantFrom("c1", "c2"),
					talkgroup: fc.integer({ min: 0, max: 2 }),
					kind: fc.constantFrom("call_start", "call_end"),
				})
				.map<Step>(v => ({
					k: "out",
					o: {
						type: v.kind,
						data: { callId: v.callId, talkgroup: v.talkgroup, source: 7 },
						timestamp: at,
					},
				})),
			fc
				.record({
					address: fc.integer({ min: 0, max: 2 }),
					protocol: fc.constantFrom("POCSAG1200", "FLEX"),
					messageType: fc.constantFrom("alpha", "numeric", "ALN"),
				})
				.map<Step>(v => ({
					k: "out",
					o: {
						type: "message",
						data: { ...v, capcode: String(v.address), message: "HELLO WORLD" },
						timestamp: at,
					},
				})),
			fc.constantFrom("N0CALL", "K1ABC-9", "").map<Step>(source => ({
				k: "out",
				o: { type: "aprs", data: { source }, timestamp: at },
			})),
			fc
				.record({
					id: fc.integer({ min: 0, max: 2 }),
					mic: fc.constantFrom("CRC", ""),
				})
				.map<Step>(v => ({
					k: "out",
					o: {
						type: "signal",
						data: { model: "Acurite-Tower", ...v },
						timestamp: at,
					},
				})),
		)
		let emitted = 0
		fc.assert(
			fc.property(
				fc.constantFrom("dsd-fme", "multimon-ng", "direwolf", "rtl433"),
				fc.boolean(),
				fc.array(outArb, { maxLength: 40 }),
				(type, nxdn48, steps) => {
					const decoders = new FakeDecoders()
					decoders.add("cfg", type)
					const epoch = { v: 3 }
					const clock = { v: 100_000 }
					const t: AmbientTarget = {
						sourceId: "rtl",
						hz: 450_000_000,
						...(type === "dsd-fme"
							? { nxdn: nxdn48 ? "nxdn48" : "nxdn96" }
							: {}),
						targetsHz: [450_000_000],
						external: false,
					}
					const base = {
						decoders: decoders as never,
						targetOf: (id: string) => (id === "cfg" ? t : null),
						epochOf: () => epoch.v,
						logger: silent,
						now: () => clock.v,
					}
					const ref = new ReferenceAmbient(base)
					const cur = new AmbientEvidence({
						...base,
						tuningTrustOf: () => "unverified",
					})
					const a: AmbientEvidenceEvent[] = []
					const b: AmbientEvidenceEvent[] = []
					ref.on("evidence", (e: AmbientEvidenceEvent) => a.push(e))
					cur.on("evidence", (e: AmbientEvidenceEvent) => b.push(e))
					ref.start()
					cur.start()
					const inst = decoders.instances.get("cfg")!
					for (const s of steps) {
						if (s.k === "epoch") epoch.v++
						else if (s.k === "tick") clock.v += s.ms
						else if (s.k === "link") {
							const line: DsdFmeLinkLine = {
								protocol: "dmr",
								cc: s.cc,
								tg: "9",
								src: "2060945",
								slot: 1,
								crcErr: s.crcErr,
								at: clock.v,
							}
							inst.emit("link", line)
						} else decoders.out("cfg", s.o)
					}
					expect(b).toEqual(a)
					emitted += a.length
					ref.stop()
					cur.stop()
				},
			),
			{ numRuns: 200 },
		)
		expect(emitted).toBeGreaterThan(0)
	})
})

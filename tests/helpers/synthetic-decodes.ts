/**
 * What the adapters must make of the synthetic transmissions in
 * scripts/fixtures (made-up identities): the replay of decoder output lines
 * through an adapter on a fake clock, the scanner interpreters, and one
 * check per protocol (decoded fields, link lines, scanner evidence and the
 * Activity row). Shared by tests/integration/synthetic-frames.test.ts (live
 * binaries) and tests/unit/decoders/synthetic-decoder-lines.test.ts
 * (recorded output of the same transmissions).
 */
import { expect, vi } from "vitest"
import { presentDecoderOutput } from "../../src/core/activity/presentation/registry.js"
import { createInterpreterState } from "../../src/core/scanner/probes/confirm/double-match.js"
import { interpretDsdFme } from "../../src/core/scanner/probes/confirm/dsd-fme.js"
import { interpretMultimon } from "../../src/core/scanner/probes/confirm/multimon.js"
import type { DecodeEvidence } from "../../src/core/scanner/types.js"
import type { DsdFmeDecoder } from "../../src/decoders/builtin/dsd-fme.js"
import type { DsdFmeLinkLine } from "../../src/decoders/builtin/dsd-fme-link.js"
import type { MultimonDecoder } from "../../src/decoders/builtin/multimon-ng.js"
import type { DecoderOutput } from "../../src/decoders/types.js"

/** The fake clock's start. */
const T0 = Date.UTC(2026, 0, 2, 3, 4, 5)
/** Spacing of replayed decoder lines: about one frame each. */
const LINE_MS = 100
/** DsdFmeDecoder's call timer period (CALL_TIMEOUT_CHECK_INTERVAL_MS). */
const TIMER_MS = 500

export interface Replay {
	outputs: DecoderOutput[]
	links: DsdFmeLinkLine[]
	evidence: DecodeEvidence[]
	lines: string[]
}

export type Interpreter = (
	out: DecoderOutput | undefined,
	link?: DsdFmeLinkLine,
) => DecodeEvidence[]

/** Feeds decoder lines on a fake clock, then idles past the call timeout. */
export function replay(
	lines: string[],
	decoder: DsdFmeDecoder | MultimonDecoder,
	interpret: Interpreter,
): Replay {
	const outputs: DecoderOutput[] = []
	const links: DsdFmeLinkLine[] = []
	const evidence: DecodeEvidence[] = []
	decoder.on("output", (out: DecoderOutput) => {
		outputs.push(out)
		evidence.push(...interpret(out))
	})
	decoder.on("link", (line: DsdFmeLinkLine) => {
		links.push(line)
		evidence.push(...interpret(undefined, line))
	})
	const feed = (line: string) =>
		(
			decoder as unknown as { handleOutputLine(line: string): void }
		).handleOutputLine(line)
	// dsd-fme's call_start/call_end timer (every 500 ms once started).
	const timer = (
		decoder as unknown as { checkCallTimeoutAsync?: () => void }
	).checkCallTimeoutAsync?.bind(decoder)
	let at = T0
	let tick = T0 + TIMER_MS
	const advance = (to: number) => {
		for (; tick <= to; tick += TIMER_MS) {
			vi.setSystemTime(tick)
			timer?.()
		}
		vi.setSystemTime(to)
	}
	for (const line of lines) {
		if (line.trim() === "") continue
		at += LINE_MS
		advance(at)
		feed(line)
	}
	advance(at + 10_000)
	return { outputs, links, evidence, lines }
}

export function dsdInterpreter(): Interpreter {
	const state = createInterpreterState({ epoch: 1, origin: "probe" })
	return (out, link) => {
		if (link) return interpretDsdFme({ kind: "link", line: link }, state)
		if (!out || (out.type !== "call_start" && out.type !== "call_end"))
			return []
		return interpretDsdFme(
			{ kind: out.type, at: out.timestamp.getTime(), call: out.data as never },
			state,
		)
	}
}

export function multimonInterpreter(): Interpreter {
	const state = createInterpreterState({ epoch: 1, origin: "probe" })
	return out => (out ? interpretMultimon(out, state) : [])
}

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "")

/** The decoder lines and events worth showing in a failure message. */
export const transcript = (r: Replay) =>
	r.lines
		.map(stripAnsi)
		.filter(line => /Sync:|FLEX|Group|Source|SRC|Src/.test(line))
		.concat(
			r.outputs.map(o => `output ${o.type} ${JSON.stringify(o.data)}`),
			r.links.map(l => `link ${JSON.stringify(l)}`),
		)
		.join("\n")

const callStart = (r: Replay) => r.outputs.find(o => o.type === "call_start")
const row = (out: DecoderOutput | undefined, type: string) =>
	out ? presentDecoderOutput(out, type) : undefined

/** The transmissions' identities (scripts/fixtures generators). */
export const SYNTHETIC = {
	dstar: {
		rpt2: "DIRECT",
		rpt1: "DIRECT",
		ur: "CQCQCQ",
		my: "N0CALL",
		suffix: "TEST",
	},
	ysf: { dest: "ALL", src: "N0CALL", dgid: 21 },
	p25: { nac: 0x2a5, talkgroup: 4321, source: 1_234_567 },
	nxdn: { ran: 5, source: 1234, destination: 5678 },
	dpmr: { calledId: "0001234", callingId: "0005678", colourCode: 5 },
	flex: { capcode: 1_234_567, message: "SYNTHETIC FLEX PAGE 42" },
} as const

export function checkDstar(r: Replay): void {
	expect(callStart(r)?.data, transcript(r)).toMatchObject({
		protocol: "dstar",
		dstar: { my: "N0CALL", ur: "CQCQCQ", rpt1: "DIRECT", rpt2: "DIRECT" },
	})
	expect(r.links).toContainEqual(
		expect.objectContaining({
			protocol: "dstar",
			callsign: "N0CALL",
			verified: true,
		}),
	)
	expect(r.evidence).toContainEqual(
		expect.objectContaining({
			protocol: "dstar",
			identity: { kind: "dstar-call", value: "N0CALL" },
		}),
	)
	expect(row(callStart(r), "dsd-fme")).toMatchObject({
		title: "DSTAR from N0CALL to CQCQCQ",
		entityKey: "callsign:N0CALL",
	})
}

export function checkYsf(r: Replay): void {
	expect(callStart(r)?.data, transcript(r)).toMatchObject({
		protocol: "ysf",
		ysf: { callsign: "N0CALL" },
	})
	expect(r.links).toContainEqual(
		expect.objectContaining({
			protocol: "ysf",
			callsign: "N0CALL",
			verified: true,
		}),
	)
	expect(r.evidence).toContainEqual(
		expect.objectContaining({
			protocol: "ysf",
			metadata: expect.objectContaining({ callsigns: ["N0CALL"] }),
		}),
	)
	expect(row(callStart(r), "dsd-fme")).toMatchObject({
		title: "YSF from N0CALL",
	})
}

export function checkP25(r: Replay): void {
	expect(callStart(r)?.data, transcript(r)).toMatchObject({
		protocol: "p25p1",
		talkgroup: 4321,
		source: 1_234_567,
		p25: { nac: "2A5" },
	})
	expect(r.links).toContainEqual(
		expect.objectContaining({
			protocol: "p25",
			tg: "4321",
			src: "1234567",
			verified: true,
		}),
	)
	expect(r.evidence).toContainEqual(
		expect.objectContaining({
			protocol: "p25p1",
			metadata: expect.objectContaining({
				talkgroups: ["4321"],
				sources: ["1234567"],
			}),
		}),
	)
	expect(row(callStart(r), "dsd-fme")).toMatchObject({
		title: "P25P1 TG 4321 from 1234567",
	})
}

export function checkNxdn(variant: "nxdn48" | "nxdn96"): (r: Replay) => void {
	return r => {
		// The RAN can follow the call start (VCALL first): the call's last event.
		const end = r.outputs.find(o => o.type === "call_end")
		expect(end?.data, transcript(r)).toMatchObject({
			protocol: variant,
			talkgroup: 5678,
			source: 1234,
			nxdn: { ran: 5 },
		})
		expect(r.links).toContainEqual(
			expect.objectContaining({ protocol: "nxdn", ran: 5, verified: true }),
		)
		expect(r.links).toContainEqual(
			expect.objectContaining({
				protocol: "nxdn",
				tg: "5678",
				src: "1234",
				verified: true,
			}),
		)
		expect(r.evidence).toContainEqual(
			expect.objectContaining({ identity: { kind: "nxdn-ran", value: "5" } }),
		)
		expect(row(end, "dsd-fme")).toMatchObject({
			title: `${variant.toUpperCase()} TG 5678 from 1234`,
		})
	}
}

export function checkDpmr(r: Replay): void {
	// dsd-fme decodes the IDs and channel code...
	expect(r.lines.map(stripAnsi).join("\n")).toContain(
		"TG=0001234 Src=0005678 Channel Code=05",
	)
	// ...but its "OK" is not a CRC check: protocol only, no identity.
	expect(callStart(r)?.data, transcript(r)).toMatchObject({
		protocol: "dpmr",
		talkgroup: 0,
		source: 0,
	})
	expect(r.links.length).toBeGreaterThan(0)
	for (const link of r.links)
		expect(link).toMatchObject({ protocol: "dpmr", verified: false })
	expect(r.evidence.some(e => e.identity !== undefined)).toBe(false)
	expect(row(callStart(r), "dsd-fme")?.title).toBe("DPMR")
}

export function checkFlex(r: Replay): void {
	const page = r.outputs.find(o => o.type === "message")
	expect(page?.data, transcript(r)).toMatchObject({
		protocol: "FLEX",
		capcode: "001234567",
		messageType: "ALN",
		message: "SYNTHETIC FLEX PAGE 42",
	})
	expect(r.evidence).toContainEqual(
		expect.objectContaining({ protocol: "flex" }),
	)
	expect(row(page, "multimon-ng")?.title).toContain("SYNTHETIC FLEX PAGE 42")
}

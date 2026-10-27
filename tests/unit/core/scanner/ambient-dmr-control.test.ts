import { EventEmitter } from "node:events"
import pino from "pino"
import { describe, expect, it } from "vitest"
import type { DsdFmeLinkLine } from "../../../../src/decoders/builtin/dsd-fme-link.js"
import {
	AmbientEvidence,
	type AmbientEvidenceEvent,
} from "../../../../src/core/scanner/probes/ambient.js"
import { CONFIRM_MIN_SEPARATION_MS } from "../../../../src/core/scanner/probes/confirm/confirm-memory.js"
import { ambientStatusFake } from "../../../mocks/scanner/ambient-status-fake.js"

function setup() {
	const decoder = new EventEmitter()
	const decoders = new EventEmitter() as EventEmitter & Record<string, unknown>
	decoders["getAllStatus"] = () => [
		{ id: "control", type: "dsd-fme", sourceId: "synthetic", owner: "config" },
	]
	decoders["getDecoder"] = () => decoder
	ambientStatusFake(decoders)
	let now = 10_037
	const ambient = new AmbientEvidence({
		decoders: decoders as never,
		now: () => now,
		tuningTrustOf: () => "commanded",
		targetOf: () => ({
			sourceId: "synthetic",
			hz: 123_456_000,
			targetsHz: [123_456_000],
			external: false,
		}),
		centreOf: () => 123_400_000,
		epochOf: () => 1,
		logger: pino({ level: "silent" }),
	})
	const got: AmbientEvidenceEvent[] = []
	ambient.on("evidence", (ev: AmbientEvidenceEvent) => got.push(ev))
	ambient.start()
	const emit = (delta: number, fields: Partial<DsdFmeLinkLine> = {}) => {
		now += delta
		decoder.emit("link", {
			protocol: "dmr",
			cc: 1,
			slot: 1,
			verified: true,
			crcErr: false,
			at: now,
			...fields,
		})
	}
	return {
		emit,
		confirmed: () => got.filter(e => e.ev.identity?.kind === "dmr-cc"),
		stop: () => ambient.stop(),
	}
}

describe("ambient checked DMR control", () => {
	it("confirms identical checked burst repeats in 1.037 s steps only after 2 s", () => {
		const f = setup()
		try {
			f.emit(0)
			f.emit(1_037)
			expect(f.confirmed()).toEqual([])
			f.emit(1_037)
			expect(f.confirmed()).toHaveLength(1)
		} finally {
			f.stop()
		}
	})

	it.each([
		CONFIRM_MIN_SEPARATION_MS - 1,
		CONFIRM_MIN_SEPARATION_MS,
		CONFIRM_MIN_SEPARATION_MS + 1,
	])("checks identical same-slot repeats at %i ms", delta => {
		const f = setup()
		try {
			f.emit(0)
			f.emit(delta)
			expect(f.confirmed()).toHaveLength(
				delta >= CONFIRM_MIN_SEPARATION_MS ? 1 : 0,
			)
		} finally {
			f.stop()
		}
	})

	it.each([
		{ slot: 2 as const },
		{ slot: 2 as const, tg: "10", src: "20" },
		{ slot: 2 as const, voiceLc: true, tg: "10" },
	])(
		"pairs checked bursts by CC across slots except voice LC with both TG/SRC: %j",
		fields => {
			const f = setup()
			try {
				f.emit(0, { ...fields, slot: 1 })
				f.emit(CONFIRM_MIN_SEPARATION_MS, fields)
				expect(f.confirmed()).toHaveLength(1)
			} finally {
				f.stop()
			}
		},
	)

	it.each([
		{ verified: false },
		{ verified: undefined },
		{ crcErr: true },
		{ fecErrs: 1 },
	])("never confirms unchecked sync/CC or failed checks: %j", fields => {
		const f = setup()
		try {
			for (let n = 0; n < 10; n++)
				f.emit(1_037, fields as Partial<DsdFmeLinkLine>)
			expect(f.confirmed()).toEqual([])
		} finally {
			f.stop()
		}
	})

	it("keeps the content rule for checked voice LC with TG/SRC", () => {
		const f = setup()
		const lc = { voiceLc: true, tg: "10", src: "20" }
		try {
			f.emit(0, lc)
			f.emit(CONFIRM_MIN_SEPARATION_MS, lc)
			expect(f.confirmed()).toEqual([])
			f.emit(1, { ...lc, src: "21" })
			expect(f.confirmed()).toHaveLength(1)
		} finally {
			f.stop()
		}
	})
})

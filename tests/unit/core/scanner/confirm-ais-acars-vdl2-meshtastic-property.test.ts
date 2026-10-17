import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { createInterpreterState } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import type {
	DecoderOutputLike,
	InterpreterState,
} from "../../../../src/core/scanner/probes/confirm/double-match.js"
import { interpretAis } from "../../../../src/core/scanner/probes/confirm/ais.js"
import { interpretAcars } from "../../../../src/core/scanner/probes/confirm/acars.js"
import { interpretVdl2 } from "../../../../src/core/scanner/probes/confirm/vdl2.js"
import { interpretMeshtastic } from "../../../../src/core/scanner/probes/confirm/meshtastic.js"
import type {
	AmbientDecode,
	AmbientInterpretCtx,
} from "../../../../src/core/scanner/probes/confirm/ambient-decode.js"

const T0 = Date.UTC(2026, 9, 16, 12)
type Kind = "ais" | "acars" | "vdl2" | "lora"
interface Step {
	kind: Kind
	id: number
	clean: boolean
}
const MMSI = ["235000001", "235000002", "235000003"]
const TAIL = ["G-ABCD", "N123AB", "F-GKXA"]
const ADDR = ["4CA1B2", "ABCDEF", "000001"]
const NODE = [0xdeadbeef, 1, 0x7fffffff]

function run(
	step: Step,
	s: InterpreterState,
): { key: string; out: AmbientDecode[] } {
	const at = new Date(T0)
	const ctx: AmbientInterpretCtx = {
		targetsHz: [161_975_000, 131_550_000, 136_975_000, 869_525_000],
	}
	const o = (type: string, data: unknown): DecoderOutputLike => ({
		type,
		data,
		timestamp: at,
	})
	switch (step.kind) {
		case "ais":
			return {
				key: "ais" + step.id,
				out: interpretAis(
					o("ship", { mmsi: MMSI[step.id], channel: "A" }),
					s,
					ctx,
				),
			}
		case "acars":
			return {
				key: "acars" + step.id,
				out: interpretAcars(
					o("acars", {
						frequency: 131_550_000,
						error: step.clean ? 0 : 1,
						tail: TAIL[step.id],
					}),
					s,
					ctx,
				),
			}
		case "vdl2":
			return {
				key: "vdl2" + step.id,
				out: interpretVdl2(
					o("vdl2", { frequency: 136_975_000, fromaddr: ADDR[step.id] }),
					s,
					ctx,
				),
			}
		case "lora":
			return {
				key: "lora" + step.id,
				out: interpretMeshtastic(
					o("meshtastic", { frequency: 869_525_000, from: NODE[step.id] }),
					s,
					ctx,
				),
			}
	}
}

describe("ambient interpreters", () => {
	// Feature: web-gaps-7, Property 3: Identity needs two clean decodes
	// Validates: Requirements 1.3
	it("identity iff at least the second CRC-clean occurrence in the state", () => {
		const step = fc.record({
			kind: fc.constantFrom<Kind>("ais", "acars", "vdl2", "lora"),
			id: fc.integer({ min: 0, max: 2 }),
			clean: fc.boolean(),
		})
		fc.assert(
			fc.property(
				fc.array(fc.array(step, { maxLength: 30 }), {
					minLength: 1,
					maxLength: 3,
				}),
				epochs => {
					epochs.forEach((steps, epoch) => {
						const s = createInterpreterState({ epoch, origin: "ambient" })
						const cleanSeen = new Map<string, number>()
						for (const st of steps) {
							const { key, out } = run(st, s)
							expect(out).toHaveLength(1)
							const ev = out[0]
							const clean = ev?.crcClean === true
							if (clean) cleanSeen.set(key, (cleanSeen.get(key) ?? 0) + 1)
							const expected = clean && (cleanSeen.get(key) ?? 0) >= 2
							expect(ev?.identity !== undefined).toBe(expected)
						}
					})
				},
			),
			{ numRuns: 200 },
		)
	})
})

/**
 * GET /api/transmissions/:ref and copy (ghost) links (TransmissionDto.copy): through the real
 * route over the production Activity runtime and the memory catalogue double, a copy names its
 * root (its transmission ref and frequency), a root lists its copies (at most
 * TRANSMISSION_COPIES_MAX, with the full count), and a file with neither reads null. Made-up
 * keys and frequencies only.
 */
import { afterEach, describe, expect, it } from "vitest"
import type { TransmissionDto } from "@wavekit/api-types"
import { TRANSMISSION_COPIES_MAX } from "../../../src/core/transmissions/dto.js"
import {
	TX_A,
	analogItem,
	harness,
	keyOf,
	type Harness,
} from "./transmission-harness.js"

const at = Date.now()

describe("GET /api/transmissions/:ref: copy links", () => {
	let h: Harness | null = null
	afterEach(async () => {
		await h?.close()
		h = null
	})
	const get = async (ref: string): Promise<TransmissionDto> => {
		const app = await h!.app()
		const res = await app.inject({
			method: "GET",
			url: `/api/transmissions/${encodeURIComponent(ref)}`,
		})
		expect(res.statusCode).toBe(200)
		return res.json<TransmissionDto>()
	}

	it("a copy names its root; the root lists its copy; an unrelated file reads null", async () => {
		h = await harness(at)
		const root = keyOf(1)
		const ghost = keyOf(2)
		const other = keyOf(3)
		h.items.set(
			root,
			analogItem(root, { txId: TX_A, frequencyHz: 100_000_000 }),
		)
		h.items.set(
			ghost,
			analogItem(ghost, {
				frequencyHz: 100_060_000,
				copyOf: { key: root, evidence: ["intermod"] },
			}),
		)
		h.items.set(other, analogItem(other))
		const copy = await get(`rec:${ghost}`)
		expect(copy.copy).toEqual({
			of: { ref: TX_A, hz: 100_000_000 },
			copies: [],
			copiesTotal: 0,
		})
		const original = await get(`rec:${root}`)
		expect(original.copy).toEqual({
			of: null,
			copies: [
				{
					ref: `rec:${ghost}`,
					hz: 100_060_000,
					recordingKey: ghost,
					evidence: ["intermod"],
				},
			],
			copiesTotal: 1,
		})
		expect((await get(`rec:${other}`)).copy).toBeNull()
	})

	it(`lists at most TRANSMISSION_COPIES_MAX (${TRANSMISSION_COPIES_MAX}) copies, with the full count`, async () => {
		h = await harness(at)
		const root = keyOf(1)
		h.items.set(root, analogItem(root))
		for (let i = 0; i < TRANSMISSION_COPIES_MAX + 2; i++) {
			const key = keyOf(10 + i)
			h.items.set(
				key,
				analogItem(key, { copyOf: { key: root, evidence: ["off-raster"] } }),
			)
		}
		const dto = await get(`rec:${root}`)
		expect(dto.copy?.copies).toHaveLength(TRANSMISSION_COPIES_MAX)
		expect(dto.copy?.copiesTotal).toBe(TRANSMISSION_COPIES_MAX + 2)
	})

	it("a copy whose root the catalogue no longer serves still names it by its alias, frequency unknown", async () => {
		h = await harness(at)
		const ghost = keyOf(2)
		h.items.set(
			ghost,
			analogItem(ghost, { copyOf: { key: keyOf(1), evidence: ["intermod"] } }),
		)
		expect((await get(`rec:${ghost}`)).copy?.of).toEqual({
			ref: `rec:${keyOf(1)}`,
			hz: null,
		})
	})
})

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import {
	operatorDataErrorDtoSchema,
	operatorDataReadDtoSchema,
	operatorDataWriteDtoSchema,
} from "@wavekit/api-types"
import type {
	OperatorDataReadDto,
	OperatorDataWriteDto,
	SavedFrequencyInput,
} from "@wavekit/api-types"
import { MOCK_SAVED_FREQUENCIES } from "../../mock/data.ts"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

const harbour: SavedFrequencyInput = {
	name: "Harbour",
	frequencyHz: 156_650_000,
	mode: "nfm",
	bandwidthHz: 12_500,
	tone: { kind: "none" },
	group: "Marine",
}

describe("mock operator data REST", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})
	const read = async () => {
		const res = await server.app.inject({
			method: "GET",
			url: "/api/operator-data",
		})
		expect(res.statusCode).toBe(200)
		return operatorDataReadDtoSchema.parse(res.json()) as OperatorDataReadDto
	}
	const send = (
		method: "POST" | "PUT" | "DELETE",
		url: string,
		payload: Record<string, unknown>,
	) => server.app.inject({ method, url, payload })

	it("serves the canvas's saved frequencies in core's read DTO", async () => {
		const dto = await read()
		expect(dto.snapshot.savedFrequencies.map(f => f.name)).toEqual(
			MOCK_SAVED_FREQUENCIES.map(f => f.name),
		)
		expect(dto.preferences.values.showSavedFrequencyLabels).toBe(true)
		// three tags inside the default 160.3–162.7 MHz capture
		expect(
			dto.snapshot.savedFrequencies.filter(
				f => f.frequencyHz > 160_300_000 && f.frequencyHz < 162_700_000,
			),
		).toHaveLength(3)
	})

	it("creates, replaces and deletes with the revision token", async () => {
		const before = await read()
		const expected = {
			storeId: before.snapshot.storeId,
			revision: before.snapshot.revision,
		}
		const created = await send("POST", "/api/operator-data/saved-frequencies", {
			expected,
			frequency: { ...harbour, name: "  Harbour  " },
		})
		expect(created.statusCode).toBe(201)
		const c = operatorDataWriteDtoSchema.parse(
			created.json(),
		) as OperatorDataWriteDto
		const id = c.savedFrequencyId ?? ""
		expect(c.snapshot.revision).toBe(expected.revision + 1)
		expect(c.snapshot.savedFrequencies.find(f => f.id === id)).toMatchObject({
			name: "Harbour",
		})

		const replaced = await send(
			"PUT",
			`/api/operator-data/saved-frequencies/${id}`,
			{
				expected: { ...expected, revision: c.snapshot.revision },
				frequency: { ...harbour, name: "Pier" },
			},
		)
		expect(replaced.statusCode).toBe(200)
		const r = replaced.json<OperatorDataWriteDto>()
		expect(r.snapshot.savedFrequencies.find(f => f.id === id)?.name).toBe(
			"Pier",
		)

		const deleted = await send(
			"DELETE",
			`/api/operator-data/saved-frequencies/${id}`,
			{ expected: { ...expected, revision: r.snapshot.revision } },
		)
		expect(deleted.statusCode).toBe(200)
		const d = deleted.json<OperatorDataWriteDto>()
		expect(d.snapshot.savedFrequencies.some(f => f.id === id)).toBe(false)
		expect(d.snapshot.revision).toBe(expected.revision + 3)
	})

	it("answers core's error codes and bodies", async () => {
		const dto = await read()
		const token = {
			storeId: dto.snapshot.storeId,
			revision: dto.snapshot.revision,
		}
		const url = "/api/operator-data/saved-frequencies"
		const stale = await send("POST", url, {
			expected: { ...token, revision: token.revision - 1 },
			frequency: harbour,
		})
		expect(stale.statusCode).toBe(409)
		expect(operatorDataErrorDtoSchema.parse(stale.json())).toMatchObject({
			code: "OPERATOR_DATA_CONFLICT",
			details: { current: token },
		})
		const missing = await send("POST", url, { frequency: harbour })
		expect(missing.statusCode).toBe(428)
		const invalid = await send("POST", url, {
			expected: token,
			frequency: { ...harbour, mode: "raw" },
		})
		expect(invalid.json()).toMatchObject({ code: "OPERATOR_DATA_INVALID" })
		expect(invalid.statusCode).toBe(400)
		const extra = await send("POST", url, {
			expected: token,
			frequency: harbour,
			id: "x",
		})
		expect(extra.statusCode).toBe(400)
		const gone = await send(
			"DELETE",
			`${url}/00000000-0000-4000-8000-000000000000`,
			{ expected: token },
		)
		expect(gone.statusCode).toBe(404)
		expect(gone.json()).toMatchObject({ code: "OPERATOR_DATA_NOT_FOUND" })
		expect((await read()).snapshot.revision).toBe(token.revision)
	})
})

describe("mock operator data WebSocket", () => {
	let server: MockServer
	let api: string
	beforeAll(async () => {
		server = await buildMockServer({ port: 0, audioPort: 0 })
		api = (await server.listen()).apiUrl
	})
	afterAll(async () => {
		await server.close()
	})

	it("sends a snapshot on subscribe and an update after each change", async () => {
		const socket = new WebSocket(`${api.replace(/^http/, "ws")}/ws`)
		const messages: { type: string; data: unknown }[] = []
		const waiters: (() => void)[] = []
		socket.on("message", (raw: Buffer) => {
			messages.push(JSON.parse(raw.toString("utf-8")) as never)
			for (const w of waiters.splice(0)) w()
		})
		const next = async (type: string) => {
			for (;;) {
				const found = messages.find(m => m.type === type)
				if (found) {
					messages.splice(messages.indexOf(found), 1)
					return found
				}
				await new Promise<void>(resolve => waiters.push(resolve))
			}
		}
		await new Promise(resolve => socket.once("open", resolve))
		socket.send(
			JSON.stringify({ type: "subscribe", channels: ["operator-data"] }),
		)
		expect((await next("subscribed")).data).toEqual({
			channels: ["operator-data"],
		})
		const snap = operatorDataReadDtoSchema.parse(
			(await next("operator-data:snapshot")).data,
		) as OperatorDataReadDto
		const res = await fetch(`${api}/api/operator-data/saved-frequencies`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				expected: {
					storeId: snap.snapshot.storeId,
					revision: snap.snapshot.revision,
				},
				frequency: harbour,
			}),
		})
		expect(res.status).toBe(201)
		const updated = operatorDataReadDtoSchema.parse(
			(await next("operator-data:updated")).data,
		) as OperatorDataReadDto
		expect(updated.snapshot.revision).toBe(snap.snapshot.revision + 1)
		expect(updated.snapshot.savedFrequencies.map(f => f.name)).toContain(
			"Harbour",
		)
		socket.close()
	})
})

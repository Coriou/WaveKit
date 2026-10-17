/**
 * receiver-endpoints defaults (3.1, 3.7): without `endpointSelection: auto` the
 * parsed config, the REST source schemas' output and the CLI view are exactly
 * what they were; the new field is additive and optional everywhere.
 */
import { describe, expect, it } from "vitest"
import Fastify from "fastify"
import { SourceConfigSchema } from "../../../src/config.js"
import { sourceEndpointSchema } from "@wavekit/api-types"
import { guardSource } from "../../../cli/source/data/guards.js"

const SOURCE = {
	id: "pi",
	type: "rtl_tcp",
	host: "192.0.2.69",
	port: 5555,
	caps: { kind: "iq", sampleRate: 2_048_000, format: "U8_IQ" },
	sdrHost: { apiUrl: "http://192.0.2.69:8080" },
}

describe("receiver-endpoints defaults", () => {
	it("parses a source config without adding keys (golden)", () => {
		expect(JSON.stringify(SourceConfigSchema.parse(SOURCE))).toBe(
			'{"id":"pi","type":"rtl_tcp","host":"192.0.2.69","port":5555,"loop":false,"playbackSpeed":1,"caps":{"kind":"iq","sampleRate":2048000,"format":"U8_IQ","exclusive":false},"sdrHost":{"apiUrl":"http://192.0.2.69:8080"}}',
		)
		expect(
			SourceConfigSchema.parse({
				...SOURCE,
				sdrHost: { endpointSelection: "auto" },
			}).sdrHost,
		).toEqual({ endpointSelection: "auto" })
		expect(() =>
			SourceConfigSchema.parse({
				...SOURCE,
				sdrHost: { endpointSelection: "on" },
			}),
		).toThrow()
	})

	it("serialises a status without endpoint exactly as before and an endpoint when present", async () => {
		const app = Fastify()
		const base = {
			id: "pi",
			connected: true,
			bytesReceived: 1,
			dataRate: 2,
			reconnectAttempts: 0,
		}
		const endpoint = {
			configuredHost: "198.51.100.23",
			activeHost: "192.0.2.69",
			reason: "verified ethernet endpoint",
			at: "2026-10-17T11:09:13.000Z",
		}
		const properties = {
			id: { type: "string" },
			connected: { type: "boolean" },
			bytesReceived: { type: "number" },
			dataRate: { type: "number" },
			reconnectAttempts: { type: "number" },
		}
		for (const [url, withEndpoint] of [
			["/old", false],
			["/new", true],
		] as const)
			app.get(
				url,
				{
					schema: {
						response: {
							200: {
								type: "object",
								properties: withEndpoint
									? { ...properties, endpoint: sourceEndpointSchema }
									: properties,
							},
						},
					},
				},
				async () => base,
			)
		app.get(
			"/tracked",
			{
				schema: {
					response: {
						200: {
							type: "object",
							properties: { ...properties, endpoint: sourceEndpointSchema },
						},
					},
				},
			},
			async () => ({ ...base, endpoint }),
		)
		const body = async (url: string) => (await app.inject({ url })).body
		expect(await body("/new")).toBe(await body("/old"))
		expect(JSON.parse(await body("/tracked")).endpoint).toEqual(endpoint)
		expect(
			JSON.parse(
				await (async () => {
					const app2 = Fastify()
					app2.get(
						"/",
						{
							schema: {
								response: {
									200: {
										type: "object",
										properties: {
											...properties,
											endpoint: sourceEndpointSchema,
										},
									},
								},
							},
						},
						async () => ({ ...base, endpoint: { ...endpoint, at: null } }),
					)
					return (await app2.inject({ url: "/" })).body
				})(),
			).endpoint.at,
		).toBeNull()
	})

	it("CLI source guard ignores the new endpoint field", () => {
		const row = {
			id: "pi",
			connected: true,
			consumers: 0,
			bytesReceived: 1,
			dataRate: 2,
			reconnectAttempts: 0,
			available: true,
			caps: {
				kind: "iq",
				sampleRate: 2_048_000,
				format: "U8_IQ",
				exclusive: false,
			},
			assignments: [],
		}
		expect(
			guardSource({
				...row,
				endpoint: {
					configuredHost: "198.51.100.23",
					activeHost: "192.0.2.69",
					reason: "verified ethernet endpoint",
					at: null,
				},
			}),
		).toEqual(guardSource(row))
		expect(guardSource(row)).toBeDefined()
	})
})

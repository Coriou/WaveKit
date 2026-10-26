// Discovery detail reads carry the remembered replay trials (`trialMemory`).
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DiscoveryTrialMemory } from "@wavekit/api-types"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import { ScannerService } from "../../../src/core/scanner/scanner-service.js"
import type { TrialMemoryEntry } from "../../../src/core/scanner/trial-memory.js"
import type { Discovery } from "../../../src/core/scanner/types.js"

const T = Date.UTC(2026, 9, 26, 8, 0, 0)

const survivor = {
	id: "d_a",
	frequencyHz: 466_050_000,
	sourceIds: ["rtl"],
	signal: { best: { snrDb: 20 }, last: { snrDb: 10 } },
	coChannel: [],
} as unknown as Discovery

const trials: DiscoveryTrialMemory[] = [
	{
		protocol: "pocsag",
		decoder: "multimon-ng",
		attempts: 3,
		decoded: 2,
		consecutiveFailures: 0,
		lastOutcome: "decoded",
		lastAt: new Date(T).toISOString(),
		lastDecodedAt: new Date(T).toISOString(),
	},
	{
		protocol: "dmr",
		decoder: "dsd-fme",
		attempts: 1,
		decoded: 0,
		consecutiveFailures: 1,
		lastOutcome: "no-sync",
		lastAt: new Date(T - 60_000).toISOString(),
	},
]

describe("discovery detail: trialMemory", () => {
	let app: FastifyInstance | undefined

	afterEach(async () => {
		await app?.close()
		app = undefined
	})

	async function build(memory: (id: string) => DiscoveryTrialMemory[]) {
		const service = {
			listDiscoveries: vi.fn(() => ({ items: [survivor], nextCursor: null })),
			getDiscovery: vi.fn((id: string) =>
				id === survivor.id ? survivor : undefined,
			),
			resolveDiscovery: vi.fn((id: string) =>
				id === survivor.id
					? survivor
					: id === "d_b"
						? { ...survivor, absorbedInto: "d_a", requestedId: "d_b" }
						: undefined,
			),
			discoveryTrialMemory: vi.fn(memory),
		}
		app = Fastify({ logger: false })
		await app.register(scannerRoutes, {
			scanner: service as unknown as ScannerRouteService,
		})
		return { app, service }
	}

	it("every field of every remembered trial survives the response schema", async () => {
		const { app } = await build(id => (id === "d_a" ? trials : []))
		const res = await app.inject({ url: "/api/scanner/discoveries/d_a" })
		expect(res.statusCode).toBe(200)
		expect(res.json().trialMemory).toEqual(trials)
	})

	it("an absorbed id reads the survivor's memory; nothing remembered omits the field", async () => {
		const { app, service } = await build(id => (id === "d_a" ? trials : []))
		const alias = await app.inject({ url: "/api/scanner/discoveries/d_b" })
		expect(alias.json().trialMemory).toEqual(trials)
		expect(service.discoveryTrialMemory).toHaveBeenLastCalledWith("d_a")
		service.discoveryTrialMemory.mockReturnValue([])
		const none = await app.inject({ url: "/api/scanner/discoveries/d_a" })
		expect(none.json()).not.toHaveProperty("trialMemory")
	})

	it("the list stays without trial memory", async () => {
		const { app } = await build(() => trials)
		const res = await app.inject({ url: "/api/scanner/discoveries" })
		expect(res.json().items[0]).not.toHaveProperty("trialMemory")
	})

	it("the service projects trialMemoryOf with ISO times", () => {
		const entries: TrialMemoryEntry[] = [
			{
				protocol: "pocsag",
				decoder: "multimon-ng",
				attempts: 3,
				decoded: 2,
				consecutiveFailures: 0,
				lastOutcome: "decoded",
				lastAt: T,
				lastDecodedAt: T,
			},
			{
				protocol: "dmr",
				decoder: "dsd-fme",
				attempts: 1,
				decoded: 0,
				consecutiveFailures: 1,
				lastOutcome: "no-sync",
				lastAt: T - 60_000,
			},
		]
		const self = {
			trialMemoryOf: (id: string) => (id === "d_a" ? entries : []),
		}
		const project = (id: string): DiscoveryTrialMemory[] =>
			ScannerService.prototype.discoveryTrialMemory.call(
				self as unknown as ScannerService,
				id,
			)
		expect(project("d_a")).toEqual(trials)
		expect(project("d_x")).toEqual([])
	})
})

import Fastify from "fastify"
import { decoderStatusExtensionProperties } from "../../../src/api/routes/decoder-status-schemas.js"
import { expect, it } from "vitest"
import type { DecoderEfficiencyView } from "@wavekit/api-types"
import {
	decoderRoutes,
	type DecoderRoutesOptions,
} from "../../../src/api/routes/decoders.js"

import { installAccessHooks } from "../../../src/access/fastify-adapter.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import { createEfficiencyGate } from "../../../src/decoders/enablement/efficiency-gate.js"
import { placementKey } from "../../../src/decoders/enablement/contract.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"

const placement = {
	decoderId: "dec",
	sourceId: "rtl",
	channelHz: null,
	reach: "raw" as const,
	costCores: 0.1,
	probation: false,
}
const view: DecoderEfficiencyView = {
	budgetCores: 0.5,
	cpuGuardPercent: 90,
	sources: [
		{
			sourceId: "rtl",
			coresInUse: 0.1,
			cpu: { percent: null, limit: 90 },
			drops: "unknown",
			dropBytesPerSecond: null,
			admitted: [placement],
			blocked: [
				{
					...placement,
					decoderId: "blocked",
					detail: "unknown",
					retryAt: "2026-10-21T12:00:00.000Z",
				},
			],
		},
	],
}
it.each([
	"route returns budget, cpu null as null, drops unknown as unknown, ordered admitted and blocked",
	"efficiency route schema keeps every DecoderEfficiencyView field",
])("%s", async () => {
	const app = Fastify()
	await app.register(decoderRoutes, {
		decoderManager: {
			efficiencyView: () => view,
		} as unknown as DecoderRoutesOptions["decoderManager"],
		authorizeSettings: () => {
			throw new Error("write authorization must not run")
		},
	})
	try {
		const response = await app.inject("/api/decoders/efficiency")
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(view)
	} finally {
		await app.close()
	}
})

it("protected reads use identical admission for decoder inventory and efficiency", async () => {
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: async () => {},
	})
	const app = Fastify()
	installAccessHooks(app, {
		sessions,
		policy: new AccessPolicy({
			listenerScheme: "http",
			allowedAuthorities: ["example.test"],
			allowedOrigins: ["http://example.test"],
			sessionCookieName: "wavekit_session",
			machineSecretDigest: digest,
			sessions,
		}),
	})
	await app.register(decoderRoutes, {
		decoderManager: {
			efficiencyView: () => view,
			getAllStatus: () => [],
		} as unknown as DecoderRoutesOptions["decoderManager"],
	})
	const session = await sessions.create()
	if (session.kind !== "created") throw new Error("Missing session")
	try {
		for (const [credentials, expectedStatus] of [
			[{}, 401],
			[{ authorization: "Bearer invalid" }, 401],
			[{ authorization: `Bearer ${token}` }, 200],
			[{ cookie: `wavekit_session=${session.cookieValue}` }, 403],
			[
				{
					cookie: `wavekit_session=${session.cookieValue}`,
					origin: "http://example.test",
				},
				200,
			],
		] as const) {
			const headers = { host: "example.test", ...credentials }
			const inventory = await app.inject({ url: "/api/decoders", headers })
			const efficiency = await app.inject({
				url: "/api/decoders/efficiency",
				headers,
			})
			expect(inventory.statusCode).toBe(expectedStatus)
			expect(efficiency.statusCode).toBe(inventory.statusCode)
			if (efficiency.statusCode === 200) expect(efficiency.json()).toEqual(view)
			else expect(efficiency.json()).toEqual(inventory.json())
		}
	} finally {
		await app.close()
	}
})

it("the route serves the real efficiency gate's view unchanged", async () => {
	const now = Date.parse("2026-10-21T12:00:00.000Z")
	let drops: "ok" | "dropping" | "unknown" = "ok"
	const gate = createEfficiencyGate(
		{ budgetCores: 0.5, cpuGuardPercent: 90 },
		{
			drops: {
				dropState: () => ({ state: drops, dropBytesPerSecond: 12.5 }),
				monoNow: () => 1_000,
				sources: () => ["rtl", "spare"],
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
			},
		},
	)
	gate.record({ atMs: now, cpuPercent: 42.5, sources: new Map() })
	const placement = (decoderId: string, channelHz: number | null) => ({
		key: placementKey(
			decoderId,
			"rtl",
			channelHz === null ? "raw" : "channel",
			channelHz,
		),
		decoderId,
		sourceId: "rtl",
		channelHz,
		reach: channelHz === null ? ("raw" as const) : ("channel" as const),
		origin: "configured" as const,
		primary: true,
		costCores: 0.1,
		sampleRateHz: 2_400_000,
	})
	const running = [{ ...placement("dec", 162_000_000), admittedAtMs: now }]
	const raw = placement("raw", null)
	expect(gate.admit(raw, running, now).admit).toBe(true)
	drops = "unknown"
	const blocked = placement("blocked", 162_025_000)
	const decision = gate.admit(blocked, running, now)
	expect(decision.admit).toBe(false)
	const real = gate.view(running, [{ placement: blocked, decision }], now)
	const app = Fastify()
	await app.register(decoderRoutes, {
		decoderManager: {
			efficiencyView: () => real,
		} as unknown as DecoderRoutesOptions["decoderManager"],
	})
	try {
		const response = await app.inject("/api/decoders/efficiency")
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(real)
		expect(real.sources.map(source => source.sourceId)).toEqual([
			"rtl",
			"spare",
		])
		expect(real.sources[0]?.blocked[0]).toMatchObject({
			decoderId: "blocked",
			detail: "unknown",
			retryAt: "2026-10-21T12:01:00.000Z",
		})
	} finally {
		await app.close()
	}
})

it("late drop evidence and held reasons survive efficiency serialization", async () => {
	const enriched: DecoderEfficiencyView = {
		...view,
		sources: view.sources.map(source => ({
			...source,
			attribution: "consumer",
			lateDrops: {
				condemningWindows: 2,
				windows: 3,
				cooldownUntil: "2026-10-22T12:00:00.000Z",
				sheddable: 1,
				held: "nothing-sheddable",
			},
			blocked: source.blocked.map(item => ({ ...item, detail: "late-drops" })),
		})),
	}
	const app = Fastify()
	await app.register(decoderRoutes, {
		decoderManager: {
			efficiencyView: () => enriched,
		} as unknown as DecoderRoutesOptions["decoderManager"],
	})
	try {
		const response = await app.inject("/api/decoders/efficiency")
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(enriched)
	} finally {
		await app.close()
	}
})

async function responseValidator() {
	const app = Fastify({ ajv: { customOptions: { coerceTypes: false } } })
	let schema: unknown
	app.addHook("onRoute", route => {
		if (route.url === "/api/decoders/efficiency")
			schema = (
				route.schema?.response as Record<number, unknown> | undefined
			)?.[200]
	})
	await app.register(decoderRoutes, {
		decoderManager: {
			efficiencyView: () => view,
		} as unknown as DecoderRoutesOptions["decoderManager"],
	})
	await app.ready()
	const validator = Fastify({ ajv: { customOptions: { coerceTypes: false } } })
	validator.post(
		"/validate",
		{ schema: { body: schema as Record<string, unknown> } },
		async () => ({}),
	)
	await app.close()
	return validator
}

it.each([
	{ attribution: "invalid" },
	{ attribution: null },
	{
		lateDrops: {
			condemningWindows: -1,
			windows: 3,
			cooldownUntil: null,
			sheddable: 0,
			held: null,
		},
	},
	{
		lateDrops: {
			condemningWindows: 2,
			windows: 3.5,
			cooldownUntil: null,
			sheddable: 0,
			held: null,
		},
	},
	{
		lateDrops: {
			condemningWindows: 2,
			windows: 3,
			cooldownUntil: 42,
			sheddable: 0,
			held: null,
		},
	},
	{
		lateDrops: {
			condemningWindows: 2,
			windows: 3,
			cooldownUntil: null,
			sheddable: "one",
			held: null,
		},
	},
	{
		lateDrops: {
			condemningWindows: 2,
			windows: 3,
			cooldownUntil: null,
			sheddable: 0,
			held: "invalid",
		},
	},
	{
		lateDrops: {
			condemningWindows: 2,
			windows: 3,
			cooldownUntil: null,
			sheddable: 0,
		},
	},
	{ blocked: [{ ...placement, detail: "invalid" }] },
])("efficiency response schema rejects malformed evidence %j", async fields => {
	const app = await responseValidator()
	try {
		const response = await app.inject({
			method: "POST",
			url: "/validate",
			payload: {
				...view,
				sources: view.sources.map(source => ({ ...source, ...fields })),
			},
		})
		expect(response.statusCode).toBe(400)
	} finally {
		await app.close()
	}
})

it.each(["none", "link", "host", "consumer", "unknown"] as const)(
	"efficiency response schema accepts attribution %s and all held states",
	async attribution => {
		const app = await responseValidator()
		try {
			for (const held of [null, "nothing-sheddable", "link-or-unknown"]) {
				const response = await app.inject({
					method: "POST",
					url: "/validate",
					payload: {
						...view,
						sources: view.sources.map(source => ({
							...source,
							attribution,
							blocked: [{ ...placement, detail: "late-drops" }],
							lateDrops: {
								condemningWindows: 2,
								windows: 3,
								cooldownUntil: null,
								sheddable: 0,
								held,
							},
						})),
					},
				})
				expect(response.statusCode).toBe(200)
			}
		} finally {
			await app.close()
		}
	},
)

it("decoder status efficiency schema accepts late-drops and rejects unknown details", async () => {
	const app = Fastify()
	app.post(
		"/validate",
		{ schema: { body: decoderStatusExtensionProperties.efficiency } },
		async () => ({}),
	)
	try {
		for (const [detail, expected] of [
			["late-drops", 200],
			["invalid", 400],
		] as const) {
			const response = await app.inject({
				method: "POST",
				url: "/validate",
				payload: { detail },
			})
			expect(response.statusCode).toBe(expected)
		}
	} finally {
		await app.close()
	}
})

it("efficiency route preserves an unavailable retry deadline as null", async () => {
	const unavailable: DecoderEfficiencyView = {
		...view,
		sources: view.sources.map(source => ({
			...source,
			blocked: source.blocked.map(item => ({ ...item, retryAt: null })),
		})),
	}
	const app = Fastify()
	await app.register(decoderRoutes, {
		decoderManager: {
			efficiencyView: () => unavailable,
		} as unknown as DecoderRoutesOptions["decoderManager"],
	})
	try {
		const response = await app.inject("/api/decoders/efficiency")
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual(unavailable)
	} finally {
		await app.close()
	}
})

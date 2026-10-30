import Fastify from "fastify"
import type { FastifyRequest } from "fastify"
import { expect, it, vi } from "vitest"
import {
	decoderRoutes,
	type DecoderRoutesOptions,
} from "../../../src/api/routes/decoders.js"
import { openEfficiencyBudget } from "../../../src/decoders/enablement/budget-settings.js"
import { resolveCpuBudget } from "../../../src/decoders/enablement/cpu-budget.js"
import { createEfficiencyGate } from "../../../src/decoders/enablement/efficiency-gate.js"
import { installAccessHooks } from "../../../src/access/fastify-adapter.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"

async function setup(protectedMode = false, onChanged?: () => void) {
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: async () => {},
	})
	const write = vi.fn().mockResolvedValue(undefined)
	const budget = await openEfficiencyBudget({
		stateDir: "unused",
		configured: 0.1,
		...(onChanged ? { onChanged } : {}),
		read: async () => undefined,
		write,
		resolve: value =>
			resolveCpuBudget(value, { cpuCount: 8, readCpuMax: () => "max 100000" }),
	})
	const gate = createEfficiencyGate(
		{ budgetCores: 0.1, cpuGuardPercent: 90, budget },
		{
			drops: {
				monoNow: () => 0,
				sources: () => ["s"],
				dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
			},
		},
	)
	const app = Fastify()
	const access = protectedMode
		? installAccessHooks(app, {
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
		: undefined
	await app.register(decoderRoutes, {
		decoderManager: {
			efficiencyView: () => gate.view([], [], 0),
		} as unknown as DecoderRoutesOptions["decoderManager"],
		efficiencyBudget: budget,
		...(access
			? {
					authorizeSettings: (request: FastifyRequest) =>
						access.authorizeMetadataMutation(request),
				}
			: {}),
	})
	return { app, token, sessions, budget, gate, write }
}
it("validates strict budget bodies, persists, updates the gate live and retains metadata", async () => {
	const h = await setup(true)
	const headers = { host: "example.test", authorization: `Bearer ${h.token}` }
	const url = "/api/decoders/efficiency/budget"
	try {
		const placement = {
			key: "p",
			decoderId: "p",
			sourceId: "s",
			reach: "raw" as const,
			channelHz: null,
			costCores: 0.2,
			sampleRateHz: 1,
			origin: "band" as const,
			primary: true,
		}
		expect(h.gate.admit(placement, [], 0)).toMatchObject({
			admit: false,
			detail: "budget",
		})
		const before = await h.app.inject({
			url: "/api/decoders/efficiency",
			headers,
		})
		expect(before.json()).toMatchObject({ budgetCores: 0.1 })
		for (const cpuBudgetCores of [0, -1, 64.001, "3", "unknown", null]) {
			expect(
				(
					await h.app.inject({
						method: "PUT",
						url,
						headers,
						payload: { cpuBudgetCores },
					})
				).statusCode,
			).toBe(400)
		}
		for (const payload of [{}, { cpuBudgetCores: 3, extra: true }])
			expect(
				(await h.app.inject({ method: "PUT", url, headers, payload }))
					.statusCode,
			).toBe(400)
		expect(h.write).not.toHaveBeenCalled()
		for (const cpuBudgetCores of [0.001, 64, "auto"] as const) {
			const updated = await h.app.inject({
				method: "PUT",
				url,
				headers,
				payload: { cpuBudgetCores },
			})
			expect(updated.statusCode).toBe(200)
			expect(updated.json()).toMatchObject({ cpuBudgetCores })
		}
		expect(h.gate.admit(placement, [], 1)).toMatchObject({ admit: true })
		const read = await h.app.inject({ url, headers })
		expect(read.json()).toEqual({
			source: "saved",
			cpuBudgetCores: "auto",
			resolved: {
				mode: "auto",
				cpus: 8,
				cores: 4,
				label: "auto (8 CPUs → 4 cores)",
			},
		})
		const efficiency = await h.app.inject({
			url: "/api/decoders/efficiency",
			headers,
		})
		expect(efficiency.json()).toMatchObject({
			budgetCores: 4,
			budget: read.json<{ resolved: unknown }>().resolved,
		})
		h.write.mockRejectedValueOnce(new TypeError("disk"))
		expect(
			(
				await h.app.inject({
					method: "PUT",
					url,
					headers,
					payload: { cpuBudgetCores: 2 },
				})
			).statusCode,
		).toBe(503)
		expect(h.budget.view().cpuBudgetCores).toBe("auto")
	} finally {
		await h.app.close()
	}
})
it("requires settings write admission before body parsing", async () => {
	const h = await setup(true)
	try {
		const session = await h.sessions.create()
		if (session.kind !== "created") throw new TypeError("session")
		for (const headers of [
			{ host: "example.test" },
			{
				host: "example.test",
				cookie: `wavekit_session=${session.cookieValue}`,
				origin: "http://example.test",
			},
		]) {
			const response = await h.app.inject({
				method: "PUT",
				url: "/api/decoders/efficiency/budget",
				headers: { ...headers, "content-type": "application/json" },
				payload: "{",
			})
			expect([401, 403]).toContain(response.statusCode)
		}
		expect(h.write).not.toHaveBeenCalled()
	} finally {
		await h.app.close()
	}
})
it("keeps reads available and writes absent without the settings authorizer", async () => {
	const h = await setup()
	try {
		expect(
			(await h.app.inject("/api/decoders/efficiency/budget")).statusCode,
		).toBe(200)
		expect(
			(
				await h.app.inject({
					method: "PUT",
					url: "/api/decoders/efficiency/budget",
					payload: { cpuBudgetCores: 3 },
				})
			).statusCode,
		).toBe(404)
		expect(h.write).not.toHaveBeenCalled()
	} finally {
		await h.app.close()
	}
})

it("returns the committed live budget when the change notification throws", async () => {
	const changed = vi.fn(() => {
		throw new TypeError("notification")
	})
	const h = await setup(true, changed)
	try {
		const response = await h.app.inject({
			method: "PUT",
			url: "/api/decoders/efficiency/budget",
			headers: { host: "example.test", authorization: `Bearer ${h.token}` },
			payload: { cpuBudgetCores: 2 },
		})
		expect(response.statusCode).toBe(200)
		expect(response.json()).toMatchObject({
			source: "saved",
			cpuBudgetCores: 2,
			resolved: { cores: 2 },
		})
		expect(h.budget.cores()).toBe(2)
		expect(h.write).toHaveBeenCalledOnce()
		expect(changed).toHaveBeenCalledOnce()
	} finally {
		await h.app.close()
	}
})

it("saves a budget with `expected` only while the stored value still matches", async () => {
	const h = await setup(true)
	const headers = { host: "example.test", authorization: `Bearer ${h.token}` }
	const url = "/api/decoders/efficiency/budget"
	const put = (payload: unknown) =>
		h.app.inject({ method: "PUT", url, headers, payload: payload as object })
	try {
		const matched = await put({ cpuBudgetCores: 3, expected: 0.1 })
		expect(matched.statusCode).toBe(200)
		expect(matched.json()).toMatchObject({ source: "saved", cpuBudgetCores: 3 })
		expect(h.write).toHaveBeenCalledOnce()

		const stale = await put({ cpuBudgetCores: 0.1, expected: 4 })
		expect(stale.statusCode).toBe(409)
		expect(stale.json()).toEqual({
			code: "EFFICIENCY_BUDGET_CONFLICT",
			current: {
				source: "saved",
				cpuBudgetCores: 3,
				resolved: { mode: "configured", cores: 3, label: "configured" },
			},
		})
		expect(h.write).toHaveBeenCalledOnce()
		expect(h.budget.view().cpuBudgetCores).toBe(3)
		expect(
			(await put({ cpuBudgetCores: "auto", expected: "auto" })).statusCode,
		).toBe(409)

		for (const expected of [0, -1, 65, "3", null, "unknown"])
			expect((await put({ cpuBudgetCores: 2, expected })).statusCode).toBe(400)
		expect(h.write).toHaveBeenCalledOnce()

		// without `expected` the write applies whatever is stored
		const plain = await put({ cpuBudgetCores: "auto" })
		expect(plain.statusCode).toBe(200)
		expect(h.budget.view().cpuBudgetCores).toBe("auto")
		expect(
			(await put({ cpuBudgetCores: 2, expected: "auto" })).statusCode,
		).toBe(200)
		expect(h.write).toHaveBeenCalledTimes(3)
	} finally {
		await h.app.close()
	}
})

it("compares `expected` after earlier queued writes, so only one of two racing conditional writes lands", async () => {
	const h = await setup(true)
	const headers = { host: "example.test", authorization: `Bearer ${h.token}` }
	const url = "/api/decoders/efficiency/budget"
	try {
		const [first, second] = await Promise.all(
			[8, 0.5].map(cpuBudgetCores =>
				h.app.inject({
					method: "PUT",
					url,
					headers,
					payload: { cpuBudgetCores, expected: 0.1 },
				}),
			),
		)
		expect([first?.statusCode, second?.statusCode].sort()).toEqual([200, 409])
		expect(h.write).toHaveBeenCalledOnce()
		const winner = first?.statusCode === 200 ? 8 : 0.5
		expect(h.budget.view().cpuBudgetCores).toBe(winner)
	} finally {
		await h.app.close()
	}
})

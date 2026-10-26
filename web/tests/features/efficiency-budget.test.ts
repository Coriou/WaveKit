import { describe, expect, it } from "vitest"
import {
	EMPTY_BUDGET,
	EfficiencyBudgetStore,
} from "../../src/features/settings/efficiency-budget.ts"
import { Store } from "../../src/data/store.ts"
import type { AccessStoreState } from "../../src/data/index.ts"
import { json, scripted } from "../data/fake-fetch.ts"

const auto = {
	cpuBudgetCores: "auto",
	resolved: {
		mode: "auto",
		cpus: 8,
		cores: 4,
		label: "auto (8 CPUs → 4 cores)",
	},
}
const view = {
	budgetCores: 4,
	budget: auto.resolved,
	sources: [{ coresInUse: 0.75 }, { coresInUse: 1.5 }],
}

describe("decoder CPU budget data", () => {
	it("loads both settings routes and sums cores across sources", async () => {
		const { api, calls } = scripted(call =>
			json(200, call.url.endsWith("/budget") ? auto : view),
		)
		const store = new EfficiencyBudgetStore(api)
		await Promise.all([store.load(), store.load()])
		expect(calls.map(c => c.url)).toEqual([
			"/api/decoders/efficiency/budget",
			"/api/decoders/efficiency",
		])
		expect(store.get()).toMatchObject({
			settings: auto,
			used: 2.25,
			error: null,
		})
	})
	it.each(["saved", "config", "default", undefined] as const)(
		"keeps optional budget provenance %s on reads and writes",
		async source => {
			const response = { ...auto, ...(source === undefined ? {} : { source }) }
			const { api } = scripted(call =>
				json(200, call.url.endsWith("/budget") ? response : view),
			)
			const store = new EfficiencyBudgetStore(api)
			await store.load()
			expect(store.get().settings).toEqual(response)
			await store.save("auto")
			expect(store.get().settings).toEqual(response)
		},
	)
	it.each([{}, { code: "DECODER_NOT_FOUND", message: "Decoder not found" }])(
		"treats an absent budget route as unavailable: %o",
		async body => {
			let available = true
			const { api, calls } = scripted(call =>
				available
					? json(200, call.url.endsWith("/budget") ? auto : view)
					: json(404, body),
			)
			const store = new EfficiencyBudgetStore(api)
			await store.load()
			available = false
			calls.length = 0
			await store.load()
			expect(store.get()).toEqual({ ...EMPTY_BUDGET, unavailable: true })
			expect(calls.map(call => call.url)).toEqual([
				"/api/decoders/efficiency/budget",
			])
			available = true
			await store.load()
			expect(store.get()).toMatchObject({
				unavailable: false,
				settings: auto,
				used: 2.25,
			})
		},
	)
	it("saves a fractional budget and Auto with PUT and uses the returned resolution", async () => {
		const { api, calls } = scripted(call => {
			const value = (call.body as { cpuBudgetCores: number | "auto" })
				.cpuBudgetCores
			return json(
				200,
				value === "auto"
					? auto
					: {
							cpuBudgetCores: value,
							resolved: {
								mode: "configured",
								cores: value,
								label: "configured",
							},
						},
			)
		})
		const store = new EfficiencyBudgetStore(api)
		expect(await store.save(2.5)).toEqual({ ok: true })
		expect(store.get().settings?.resolved).toEqual({
			mode: "configured",
			cores: 2.5,
			label: "configured",
		})
		expect(await store.save("auto")).toEqual({ ok: true })
		expect(calls.map(c => [c.method, c.body])).toEqual([
			["PUT", { cpuBudgetCores: 2.5 }],
			["PUT", { cpuBudgetCores: "auto" }],
		])
		expect(store.get().busy).toBe(false)
	})
	it("keeps the saved value on failure and exposes settings-write denials", async () => {
		let status = 200
		const { api } = scripted(call =>
			status === 200
				? json(200, call.url.endsWith("/budget") ? auto : view)
				: json(status, { code: "FORBIDDEN", message: "Settings write denied" }),
		)
		const store = new EfficiencyBudgetStore(api)
		await store.load()
		status = 503
		expect((await store.save(3)).ok).toBe(false)
		expect(store.get()).toMatchObject({
			settings: auto,
			denied: null,
			busy: false,
		})
		status = 403
		expect(await store.save(3)).toEqual({
			ok: false,
			message: "Settings write denied",
		})
		expect(store.get()).toMatchObject({
			settings: auto,
			denied: "Settings write denied",
			busy: false,
		})
	})
	it.each([401, 403])(
		"allows a save after reauthentication following a %s denial",
		async status => {
			let allowed = false
			const { api } = scripted(call =>
				call.method === "PUT" && !allowed
					? json(status, { message: "Settings write denied" })
					: json(200, call.url.endsWith("/budget") ? auto : view),
			)
			const access = new Store<AccessStoreState>({
				access: null,
				session: null,
				error: null,
			})
			const store = new EfficiencyBudgetStore(api)
			const unfollow = store.followAccess(access)
			await store.load()
			await store.save(3)
			expect(store.get().denied).toBe("Settings write denied")
			// Polling and unrelated errors must not clear a write denial.
			await store.load()
			access.update(s => ({ ...s, error: "Access refresh failed" }))
			expect(store.get().denied).toBe("Settings write denied")
			access.update(s => ({
				...s,
				session: {
					deviceId: `device_${"d".repeat(43)}`,
					expiresAt: Date.now() + 86_400_000,
					csrfToken: "t".repeat(43),
				},
			}))
			expect(store.get()).toMatchObject({
				denied: null,
				error: null,
				settings: auto,
			})
			allowed = true
			expect(await store.save("auto")).toEqual({ ok: true })
			unfollow()
		},
	)
	it("ignores a denial from a write started before the access context changed", async () => {
		let answer: ((value: Response) => void) | undefined
		const { api } = scripted(
			() =>
				new Promise<Response>(resolve => {
					answer = resolve
				}),
		)
		const access = new Store<AccessStoreState>({
			access: null,
			session: null,
			error: null,
		})
		const store = new EfficiencyBudgetStore(api)
		const unfollow = store.followAccess(access)
		const saving = store.save(3)
		access.update(s => ({ ...s, access: { mode: "legacy" } }))
		answer?.(json(403, { message: "Settings write denied" }))
		await saving
		expect(store.get()).toMatchObject({
			denied: null,
			error: null,
			busy: false,
		})
		unfollow()
	})
	it("validates responses and shows unknown usage after a failed refresh", async () => {
		let malformed = false
		const { api } = scripted(call =>
			json(
				200,
				malformed
					? { sources: [{ coresInUse: -2 }] }
					: call.url.endsWith("/budget")
						? auto
						: view,
			),
		)
		const store = new EfficiencyBudgetStore(api)
		await store.load()
		malformed = true
		await store.load()
		expect(store.get().settings).toEqual(auto)
		expect(store.get().used).toBeNull()
		expect(store.get().error).toMatch(/Unexpected answer/)
		expect(store.get().usageError).toMatch(/Unexpected answer/)
	})
	it("does not let an older read overwrite a completed save", async () => {
		let answer: ((value: Response) => void) | undefined
		const { api } = scripted(call =>
			call.method === "PUT"
				? json(200, {
						cpuBudgetCores: 2,
						resolved: { mode: "configured", cores: 2, label: "configured" },
					})
				: call.url.endsWith("/budget")
					? new Promise<Response>(resolve => {
							answer = resolve
						})
					: json(200, view),
		)
		const store = new EfficiencyBudgetStore(api)
		const loading = store.load()
		await store.save(2)
		answer?.(json(200, auto))
		await loading
		expect(store.get().settings?.cpuBudgetCores).toBe(2)
	})
})

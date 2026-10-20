import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BANDPLAN_URL_IMPORT_HOSTS } from "@wavekit/api-types"
import { openBandPlanService } from "../../../../src/core/bandplans/index.js"
import type {
	BandPlanService,
	BandPlanUrlFetcher,
} from "../../../../src/core/bandplans/contract.js"

// WG6 (U): the barrel wires the update diff; src/index.ts passes the fetcher and the
// allowlist to both services, and only the writable (protected) one advertises hosts.
const dirs: string[] = []
const services: BandPlanService[] = []
afterEach(async () => {
	for (const s of services.splice(0)) await s.close()
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function open(writable: boolean): Promise<{
	service: BandPlanService
	fetch: ReturnType<typeof vi.fn<BandPlanUrlFetcher>>
}> {
	const dir = await mkdtemp(join(tmpdir(), "wk-bp-wiring-"))
	dirs.push(dir)
	const fetch = vi.fn<BandPlanUrlFetcher>(() =>
		Promise.reject(new Error("no network in tests")),
	)
	const service = await openBandPlanService({
		stateDir: dir,
		context: { region: "EU", effectiveCountry: null },
		writable,
		urlFetcher: fetch,
		urlImportHosts: BANDPLAN_URL_IMPORT_HOSTS,
	})
	services.push(service)
	return { service, fetch }
}

describe("band-plan URL import wiring (WG6)", () => {
	it("the legacy (read-only) service advertises no URL hosts and refuses URL work", async () => {
		const { service, fetch } = await open(false)
		expect(service.view().capabilities.urlImportHosts).toEqual([])
		await expect(service.checkImportUpdate?.("x")).rejects.toMatchObject({
			code: "BANDPLANS_URL_IMPORT_DISABLED",
		})
		expect(fetch).not.toHaveBeenCalled()
	})

	it("the protected service advertises the frozen allowlist and has the update diff", async () => {
		const { service } = await open(true)
		expect(service.view().capabilities.urlImportHosts).toEqual([
			...BANDPLAN_URL_IMPORT_HOSTS,
		])
		// With the diff wired, an unknown pack is not answered DISABLED.
		await expect(
			service.checkImportUpdate?.("missing"),
		).rejects.not.toMatchObject({ code: "BANDPLANS_URL_IMPORT_DISABLED" })
	})
})

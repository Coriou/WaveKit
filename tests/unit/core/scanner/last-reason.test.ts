import { readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScannerApiError } from "../../../../src/core/scanner/errors.js"
import {
	LAST_REASON_CODES,
	LAST_REASON_SOURCES_MAX,
	LastReasons,
	leaseRefusal,
	safeReasonCode,
} from "../../../../src/core/scanner/last-reason.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})
function harness() {
	const h = serviceHarness({})
	cleanups.push(async () => {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	})
	return h
}
type Internals = {
	createDriver(record: unknown): { start(): Promise<void> }
	arbitrationFailed(sourceId: string, err: unknown): void
}
const internals = (h: ReturnType<typeof harness>) =>
	h.service as unknown as Internals

const engineOf = (h: ReturnType<typeof harness>) =>
	h.service.status().engines.find(engine => engine.sourceId === "rtl")

describe("safeReasonCode", () => {
	it("passes every listed code and nothing else", () => {
		for (const code of LAST_REASON_CODES)
			expect(safeReasonCode({ code })).toBe(code)
		for (const err of [
			new Error("connect ECONNREFUSED receiver.invalid"),
			{ code: "/etc/passwd" },
			{ code: "lower case" },
			{ code: "SECRET_CUSTOMER_TOKEN" },
			{ code: "ENOENT" },
			{ code: 7 },
			null,
			undefined,
			"SCANNER_SOURCE_BUSY",
		])
			expect(safeReasonCode(err)).toBe("UNKNOWN")
	})

	it("lists exactly the codes the refusal paths raise", () => {
		const raisedBy = (path: string): string[] =>
			readFileSync(new URL(`../../../../src/${path}`, import.meta.url), "utf8")
				.match(/"(?:SCANNER|SPECTRUM|TUNER)_[A-Z0-9_]+"/g)
				?.map(literal => literal.slice(1, -1)) ?? []
		const raised = new Set(
			[
				"core/scanner/job-runner.ts",
				"core/scanner/tuner-arbiter.ts",
				"core/spectrum/spectrum-service.ts",
				"core/spectrum/spectrum-engine.ts",
				"core/spectrum/pipeline-host.ts",
				"core/tuner-controller.ts",
			].flatMap(raisedBy),
		)
		// Only logged by the job runner: it never leaves a dispatch.
		raised.delete("SCANNER_ACTIVITY_VIEW")
		// Only POST /api/tuner/:sourceId/take-back raises these: never a scanner dispatch.
		raised.delete("TUNER_TAKE_BACK_BLOCKED")
		raised.delete("TUNER_NOTHING_HELD")
		// From the service itself and from the tuner's ownership check, whose code has another prefix.
		raised.add("SCANNER_JOB_NOT_FOUND")
		raised.add("ACCESS_UNAVAILABLE")
		expect([...LAST_REASON_CODES].sort()).toEqual([...raised].sort())
	})
})

describe("leaseRefusal", () => {
	it("names a holder only when it is a plain id", () => {
		const of = (holderJobId: unknown) =>
			leaseRefusal(
				"hand-back",
				new ScannerApiError("held", "SCANNER_SOURCE_BUSY", 409, {
					holderJobId,
				}),
				0,
			)
		expect(of("job-1")).toEqual({
			kind: "hand-back",
			code: "SCANNER_SOURCE_BUSY",
			at: "1970-01-01T00:00:00.000Z",
			holderJobId: "job-1",
		})
		expect(of("job 1\nforged")).not.toHaveProperty("holderJobId")
		expect(of(7)).not.toHaveProperty("holderJobId")
	})
})

describe("LastReasons", () => {
	it("keeps every source at the bound and drops the oldest past it", () => {
		const reasons = new LastReasons<number>()
		for (let i = 0; i < LAST_REASON_SOURCES_MAX; i++) reasons.set(`s${i}`, i)
		expect(reasons.get("s0")).toBe(0)
		// Writing again makes a source the newest, so s1 is now the oldest.
		reasons.set("s0", 100)
		reasons.set("past", 1)
		expect(reasons.get("s1")).toBeUndefined()
		expect(reasons.get("s0")).toBe(100)
		expect(reasons.get("past")).toBe(1)
	})
})

describe("scanner status last reasons", () => {
	it("shows a passive start failure as a code until the next start succeeds", async () => {
		const h = harness()
		const svc = internals(h)
		const createDriver = svc.createDriver.bind(h.service)
		let refuse = true
		svc.createDriver = record => {
			const driver = createDriver(record)
			if (refuse)
				driver.start = () =>
					Promise.reject(
						new ScannerApiError(
							"no engine at /private/path",
							"SCANNER_ENGINE_FAILED",
							503,
						),
					)
			return driver
		}
		await h.service.start()
		await vi.waitFor(() =>
			expect(engineOf(h)?.lastPassiveStartFailure?.code).toBe(
				"SCANNER_ENGINE_FAILED",
			),
		)
		expect(JSON.stringify(engineOf(h))).not.toContain("/private/path")

		refuse = false
		h.sources.emit("connected", "rtl")
		await vi.waitFor(() =>
			expect(h.service.getJob("passive-rtl")?.state).toBe("running"),
		)
		expect(engineOf(h)).not.toHaveProperty("lastPassiveStartFailure")
	})

	it("shows the last lease refusal the core met on its own", async () => {
		const h = harness()
		await h.service.start()
		expect(engineOf(h)).not.toHaveProperty("lastLeaseRefusal")
		internals(h).arbitrationFailed(
			"rtl",
			new Error("connect failed at receiver.invalid"),
		)
		expect(engineOf(h)?.lastLeaseRefusal).toMatchObject({
			kind: "arbitration",
			code: "UNKNOWN",
		})
	})
})

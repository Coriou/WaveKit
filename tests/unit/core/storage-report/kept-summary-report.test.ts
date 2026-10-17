import { describe, expect, it, vi } from "vitest"
import type { StorageKeptSummary } from "@wavekit/api-types"
import { createStorageReporter } from "../../../../src/core/storage-report/reporter.js"
import type { StorageAreaSource } from "../../../../src/core/storage-report/contract.js"

type Internal = NonNullable<Parameters<typeof createStorageReporter>[1]>

const scan = vi.fn(async (areas: readonly StorageAreaSource[]) =>
	areas.map(a => ({
		id: a.id,
		bytes: 10,
		files: 2,
		exists: true,
		partialReason: null,
	})),
) as unknown as NonNullable<Internal["scan"]>
const statfs: NonNullable<Internal["statfs"]> = async () => ({
	blocks: 1000,
	bfree: 400n,
	bavail: 300,
	bsize: 4096n,
})

function make(kept?: () => StorageKeptSummary | null) {
	return createStorageReporter(
		{
			stateDir: "/state",
			areas: [{ id: "activity", paths: ["/x"], capBytes: 100 }],
			minFreeBytes: null,
			now: () => 1_000,
			...(kept ? { kept } : {}),
		},
		{ scan, statfs },
	)
}

describe("storage report kept (WG10 req 1.8)", () => {
	it("golden: the frozen report without the option", async () => {
		expect(await make().report()).toEqual({
			generatedAt: "1970-01-01T00:00:01.000Z",
			cachedUntil: expect.any(String),
			filesystem: expect.anything(),
			areas: expect.anything(),
			kept: null,
			lowSpace: {
				policy: "scanner-evidence-stops-writing",
				minFreeBytes: null,
				state: "unknown",
			},
		})
	})

	it("reports a ready summary", async () => {
		const k: StorageKeptSummary = {
			state: "ready",
			recordings: 2,
			bytes: 50,
			maxRecordings: 10,
			maxBytes: 1000,
		}
		expect((await make(() => k).report()).kept).toEqual(k)
	})

	it("reports loading and failed without counts", async () => {
		expect((await make(() => ({ state: "loading" })).report()).kept).toEqual({
			state: "loading",
		})
		expect((await make(() => ({ state: "failed" })).report()).kept).toEqual({
			state: "failed",
		})
	})

	it("a throwing source reports null", async () => {
		const r = await make(() => {
			throw new Error("boom")
		}).report()
		expect(r.kept).toBeNull()
	})
})

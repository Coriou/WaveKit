import { describe, expect, it } from "vitest"

import {
	EPISODE_END_MS,
	createLinkAdvisoryMock,
	linkControlSchema,
} from "../../mock/link-advisories.ts"

describe("mock link advisory", () => {
	it("keeps the core's episode rule: from the first dropping until 60 s without one", () => {
		let t = Date.parse("2026-11-16T10:00:00Z")
		const m = createLinkAdvisoryMock("rtl-0", () => t)
		expect(m.entries()).toEqual([])
		expect(m.snapshot().linkAdvisories).toEqual([])
		m.control({ level: "dropping" })
		const ep = new Date(t).toISOString()
		expect(m.entries()).toEqual([
			{
				sourceId: "rtl-0",
				level: "dropping",
				lossReason: "source",
				since: ep,
				episodeSince: ep,
			},
		])
		t += 5000
		m.control({ level: "none" })
		expect(m.entries()[0]).toMatchObject({ level: "none", episodeSince: ep })
		t += 5000
		m.control({ level: "dropping", lossReason: "core-busy" })
		expect(m.entries()[0]).toMatchObject({
			lossReason: "core-busy",
			episodeSince: ep,
			since: new Date(t).toISOString(),
		})
		expect(m.control({ endEpisode: true })).toBe("endEpisode while dropping")
		m.control({ level: "none" })
		t += EPISODE_END_MS
		expect(m.entries()[0]?.episodeSince).toBeUndefined()
		m.control({ level: "dropping" })
		m.control({ level: "none", endEpisode: true })
		expect(m.entries()[0]?.episodeSince).toBeUndefined()
		m.control({ level: "absent" })
		expect(m.entries()).toEqual([])
	})

	it("accepts only the scenario fields", () => {
		expect(linkControlSchema.safeParse({ level: "dropping" }).success).toBe(
			true,
		)
		expect(linkControlSchema.safeParse({ level: "lost" }).success).toBe(false)
		expect(linkControlSchema.safeParse({ extra: 1 }).success).toBe(false)
	})
})

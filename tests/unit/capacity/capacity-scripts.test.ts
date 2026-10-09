import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { expect, it } from "vitest"

it("validates the capacity script channelizer extensions", () => {
	const result = spawnSync(
		"python3",
		[resolve("tests/unit/capacity/test_capacity_channelizer.py")],
		{
			encoding: "utf8",
			timeout: 30000,
		},
	)
	expect(result.status, result.stdout + result.stderr).toBe(0)
}, 35000)

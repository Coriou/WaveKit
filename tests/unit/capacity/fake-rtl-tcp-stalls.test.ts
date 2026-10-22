import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { expect, it } from "vitest"

it("validates fake rtl_tcp stall scheduling and drop accounting", () => {
	const result = spawnSync(
		"python3",
		[resolve("tests/unit/capacity/test_fake_rtl_tcp_stalls.py")],
		{ encoding: "utf8", timeout: 30000 },
	)
	expect(result.status, result.stdout + result.stderr).toBe(0)
}, 35000)

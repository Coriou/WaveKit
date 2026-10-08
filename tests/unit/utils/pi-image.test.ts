import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { expect, it } from "vitest"

it("validates the file-only Pi image builder and firstboot payload", () => {
	const result = spawnSync(
		"python3",
		[resolve("tests/unit/utils/test_pi_image.py")],
		{
			encoding: "utf8",
			timeout: 30000,
		},
	)
	expect(result.status, result.stdout + result.stderr).toBe(0)
}, 35000)

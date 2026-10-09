import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { expect, it } from "vitest"

// Feature: core-channelizer (T7a), fixtures/compose.py: offset bin, cu8 mapping,
// resampler stopband, determinism, saturation guard and the POCSAG/ACARS generators.
it("passes the fixture composer self-test", () => {
	const result = spawnSync(
		"python3",
		[resolve("tests/unit/fixtures/test_compose.py")],
		{
			encoding: "utf8",
			timeout: 60000,
		},
	)
	expect(result.status, result.stdout + result.stderr).toBe(0)
}, 65000)

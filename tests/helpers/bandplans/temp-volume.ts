import { execFileSync, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface FastTemp {
	mkdtemp(prefix: string): Promise<string>
	destroy(): void
}

// APFS fsync on the system disk is about 25 ms, so 100 real restarts miss the
// 5 s test budget. A RAM volume runs the same fsync, rename and directory-sync
// protocol in well under that. Other platforms already have a fast temp dir.
export function mountFastTemp(): FastTemp {
	if (process.platform !== "darwin") {
		const base = tmpdir()
		return {
			mkdtemp: prefix => mkdtemp(join(base, prefix)),
			destroy: () => undefined,
		}
	}
	const name = `wkbp${randomBytes(4).toString("hex")}`
	const attached = execFileSync(
		"hdiutil",
		["attach", "-nomount", "ram://262144"],
		{ encoding: "utf8" },
	)
	const dev = attached.trim().split(/\s+/)[0]
	if (dev === undefined || !dev.startsWith("/dev/disk"))
		throw new Error(`hdiutil returned no device: ${attached}`)
	let detached = false
	const detach = () => {
		if (detached) return
		detached = true
		spawnSync("hdiutil", ["detach", dev, "-force"], { stdio: "ignore" })
	}
	process.on("exit", detach)
	try {
		execFileSync("diskutil", ["erasevolume", "APFS", name, dev], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		})
		const mounts = execFileSync("mount", { encoding: "utf8" })
		const base = mounts
			.split("\n")
			.find(line => line.includes(`/Volumes/${name} `))
			?.split(" on ")[1]
			?.split(" (")[0]
		if (base === undefined) throw new Error(`RAM volume ${name} did not mount`)
		return {
			mkdtemp: prefix => mkdtemp(join(base, prefix)),
			destroy: detach,
		}
	} catch (error) {
		detach()
		throw error
	}
}

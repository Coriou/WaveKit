// direwolf takes its KISS and AGW ports from a per-instance config file: `-p` only enables a
// KISS pseudo terminal and `-a N` is the audio statistics interval, so neither flag can carry
// a port. The adapter writes the base config plus KISSPORT/AGWPORT before spawning.
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	DirewolfDecoder,
	direwolfConfigPath,
	renderDirewolfConfig,
} from "../../../src/decoders/builtin/direwolf.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { DecoderSpawnError } from "../../../src/utils/errors.js"

class ConfigDirewolf extends DirewolfDecoder {
	constructor(
		options: Record<string, unknown>,
		root: string,
		base: string,
		id = "aprs-a",
	) {
		super(
			{
				id,
				type: "direwolf",
				enabled: true,
				options,
			} as DecoderConfig,
			pino({ level: "silent" }),
		)
		this.configRoot = root
		this.baseConfigPath = base
	}
	argv(): string[] {
		return this.getDecoderArgs()
	}
	path(): string {
		return this.instanceConfigPath()
	}
	write(): Promise<void> {
		return this.writeInstanceConfig()
	}
}

let root: string
let base: string

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dw-conf-"))
	base = join(root, "base.conf")
	await writeFile(
		base,
		"MYCALL N0CALL\nADEVICE stdin null\nKISSPORT 9999\n  agwport 7777\nKISSPORTX keep\nCHANNEL 0\n",
	)
})

afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

describe("renderDirewolfConfig", () => {
	it("drops the base port lines and appends this instance's ports", () => {
		const text = renderDirewolfConfig(
			"MYCALL N0CALL\nKISSPORT 9999\r\n agwport 7777\nKISSPORTX keep\nKISSPORT\nCHANNEL 0",
			{ kissPort: 8002, agwPort: 8010 },
		)
		expect(text).toBe(
			"MYCALL N0CALL\nKISSPORTX keep\nCHANNEL 0\n# WaveKit per-instance ports\nKISSPORT 8002\nAGWPORT 8010\n",
		)
	})
})

describe("direwolf instance config", () => {
	it("honours configured kissPort and agwPort and passes no -p/-a", async () => {
		const decoder = new ConfigDirewolf(
			{ kissPort: 8002, agwPort: "8010" },
			root,
			base,
		)
		const argv = decoder.argv()
		expect(argv.slice(0, 5)).toEqual(["-c", decoder.path(), "-", "-r", "48000"])
		expect(argv).not.toContain("-p")
		expect(argv).not.toContain("-a")
		await decoder.write()
		const text = await readFile(decoder.path(), "utf8")
		expect(text).toContain("MYCALL N0CALL\nADEVICE stdin null\n")
		expect(text.match(/^KISSPORT .*$/gm)).toEqual(["KISSPORT 8002"])
		expect(text.match(/^AGWPORT .*$/gim)).toEqual(["AGWPORT 8010"])
		expect((await stat(decoder.path())).mode & 0o777).toBe(0o600)
		expect((await stat(dirname(decoder.path()))).mode & 0o777).toBe(0o700)
		// The adapter connects to the same KISS port it configured.
		expect((decoder as unknown as { outputPort: number }).outputPort).toBe(8002)
	})

	it("uses the default ports at the bounds' defaults and the fallback base when /etc is absent", async () => {
		const decoder = new ConfigDirewolf({}, root, join(root, "missing.conf"))
		await decoder.write()
		expect(await readFile(decoder.path(), "utf8")).toBe(
			"MYCALL N0CALL\nADEVICE stdin null\nCHANNEL 0\n# WaveKit per-instance ports\nKISSPORT 8001\nAGWPORT 8000\n",
		)
	})

	it("writes the port bounds 1 and 65535 and clamps past them", async () => {
		for (const [given, want] of [
			[1, 1],
			[65535, 65535],
			[65536, 65535],
			[0, 1],
		] as const) {
			const decoder = new ConfigDirewolf(
				{ kissPort: given, agwPort: given },
				root,
				base,
			)
			await decoder.write()
			const text = await readFile(decoder.path(), "utf8")
			expect(text, String(given)).toContain(
				`KISSPORT ${want}\nAGWPORT ${want}\n`,
			)
		}
	})

	it("replaces a pre-planted symlink instead of writing through it", async () => {
		const decoder = new ConfigDirewolf({}, root, base)
		const target = join(root, "victim")
		await writeFile(target, "untouched")
		await mkdir(dirname(decoder.path()), { recursive: true, mode: 0o700 })
		await symlink(target, decoder.path())
		await decoder.write()
		expect(await readFile(target, "utf8")).toBe("untouched")
		expect(await readFile(decoder.path(), "utf8")).toContain("KISSPORT 8001")
	})

	it("refuses a config directory that is not owner-only", async () => {
		const decoder = new ConfigDirewolf({}, root, base)
		await mkdir(dirname(decoder.path()), { recursive: true })
		await chmod(dirname(decoder.path()), 0o755)
		await expect(decoder.write()).rejects.toBeInstanceOf(DecoderSpawnError)
	})

	it("removes the instance config on stop", async () => {
		const decoder = new ConfigDirewolf({}, root, base)
		await decoder.write()
		await decoder.stop()
		await expect(stat(decoder.path())).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("keeps the shared directory on stop for an instance between validating and writing", async () => {
		const a = new ConfigDirewolf({}, root, base, "aprs-a")
		await a.write()
		// b's base config is a FIFO: its write validates the directory, then blocks reading
		// the base until the test feeds it, after a has fully stopped.
		const fifo = join(root, "base.fifo")
		execFileSync("mkfifo", [fifo])
		const b = new ConfigDirewolf({ kissPort: 8100 }, root, fifo, "aprs-b")
		const writing = b.write()
		await new Promise(resolve => setTimeout(resolve, 100))
		await a.stop()
		await expect(stat(a.path())).rejects.toMatchObject({ code: "ENOENT" })
		expect((await stat(dirname(a.path()))).isDirectory()).toBe(true)
		await writeFile(fifo, "MYCALL N0CALL\n")
		await writing
		expect(await readFile(b.path(), "utf8")).toContain("KISSPORT 8100")
	})

	it("never deletes through a planted directory symlink", async () => {
		const decoder = new ConfigDirewolf({}, root, base)
		const victimDir = join(root, "victim-dir")
		await mkdir(victimDir, { mode: 0o700 })
		const victim = join(victimDir, basename(decoder.path()))
		await writeFile(victim, "untouched")
		await mkdir(dirname(dirname(decoder.path())), { recursive: true })
		await symlink(victimDir, dirname(decoder.path()))
		await expect(decoder.write()).rejects.toBeInstanceOf(DecoderSpawnError)
		await decoder.stop()
		expect(await readFile(victim, "utf8")).toBe("untouched")
	})

	it("re-checks the directory on stop and leaves a swapped-in symlink's target alone", async () => {
		const decoder = new ConfigDirewolf({}, root, base)
		await decoder.write()
		const victimDir = join(root, "victim-dir")
		await mkdir(victimDir, { mode: 0o700 })
		const victim = join(victimDir, basename(decoder.path()))
		await writeFile(victim, "untouched")
		await rm(dirname(decoder.path()), { recursive: true })
		await symlink(victimDir, dirname(decoder.path()))
		await decoder.stop()
		expect(await readFile(victim, "utf8")).toBe("untouched")
	})

	it("hashes the decoder id into the file name", () => {
		const path = direwolfConfigPath("../../etc/x; rm", "/r")
		expect(path).toMatch(
			new RegExp(`^/r/wavekit-direwolf-${process.pid}/[0-9a-f]{16}\\.conf$`),
		)
		expect(direwolfConfigPath("a", "/r")).not.toBe(
			direwolfConfigPath("b", "/r"),
		)
	})
})

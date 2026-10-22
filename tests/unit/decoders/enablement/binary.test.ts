import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	writeFile,
	readFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WRAPPER_SCRIPT_PATH } from "../../../../src/decoders/builtin/lora-meshtastic.js"
import {
	DECODER_BINARIES,
	DECODER_REQUIRED_FILES,
	resolveDecoderBinary,
} from "../../../../src/decoders/enablement/binary.js"

let directory: string
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "wavekit-binary-"))
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})
it("found on PATH", async () => {
	const file = join(directory, "AIS-catcher")
	await writeFile(file, "")
	await chmod(file, 0o100)
	expect(
		await resolveDecoderBinary("ais-catcher", {
			PATH: `${join(directory, "missing")}:${directory}`,
		}),
	).toEqual({ available: true })
})
it("missing binary yields unavailable without spawning", async () => {
	const stat = vi.fn().mockRejectedValue(new Error("missing"))
	expect(
		await resolveDecoderBinary("readsb", { PATH: directory }, { stat }),
	).toEqual({ available: false })
	expect(stat).toHaveBeenCalledWith(join(directory, "readsb"))
	const source = await readFile("src/decoders/enablement/binary.ts", "utf8")
	expect(source).not.toMatch(/child_process|\bspawn\s*\(/)
})
it("non-executable file is unavailable", async () => {
	await writeFile(join(directory, "readsb"), "", { mode: 0o600 })
	expect(await resolveDecoderBinary("readsb", { PATH: directory })).toEqual({
		available: false,
	})
})
it("empty PATH is unavailable", async () => {
	const stat = vi.fn()
	for (const PATH of [undefined, "", ":"])
		expect(await resolveDecoderBinary("readsb", { PATH }, { stat })).toEqual({
			available: false,
		})
	expect(stat).not.toHaveBeenCalled()
})
it("directories and unknown types are unavailable", async () => {
	await mkdir(join(directory, "readsb"))
	expect(await resolveDecoderBinary("readsb", { PATH: directory })).toEqual({
		available: false,
	})
	for (const type of ["unknown", "toString", "__proto__"])
		expect(await resolveDecoderBinary(type, { PATH: directory })).toEqual({
			available: false,
		})
})
it("maps the decoder executables used by adapters", () => {
	expect(DECODER_BINARIES).toEqual({
		readsb: "readsb",
		"ais-catcher": "AIS-catcher",
		acarsdec: "acarsdec",
		dumpvdl2: "dumpvdl2",
		rtl433: "rtl_433",
		direwolf: "direwolf",
		"multimon-ng": "multimon-ng",
		"dsd-fme": "dsd-fme",
		"lora-meshtastic": "python3",
	})
})
it("relative PATH entries are never searched", async () => {
	const stat = vi.fn()
	for (const PATH of [".", "bin", "./bin:../bin"])
		expect(await resolveDecoderBinary("readsb", { PATH }, { stat })).toEqual({
			available: false,
		})
	expect(stat).not.toHaveBeenCalled()
})
it("lora-meshtastic needs its wrapper script as well as the interpreter", async () => {
	expect(DECODER_REQUIRED_FILES["lora-meshtastic"]).toEqual([
		WRAPPER_SCRIPT_PATH,
	])
	const python = join(directory, "python3")
	const fakeFs = (wrapper: "missing" | "directory" | "file") => ({
		stat: vi.fn(async (p: string) => {
			if (p === python) return { isFile: () => true, mode: 0o755 }
			if (p === WRAPPER_SCRIPT_PATH && wrapper !== "missing")
				return { isFile: () => wrapper === "file", mode: 0o644 }
			throw new Error("missing")
		}),
	})
	const env = { PATH: directory }
	expect(
		await resolveDecoderBinary("lora-meshtastic", env, fakeFs("missing")),
	).toEqual({ available: false })
	expect(
		await resolveDecoderBinary("lora-meshtastic", env, fakeFs("directory")),
	).toEqual({ available: false })
	expect(
		await resolveDecoderBinary("lora-meshtastic", env, fakeFs("file")),
	).toEqual({ available: true })
	expect(
		await resolveDecoderBinary("lora-meshtastic", { PATH: "" }, fakeFs("file")),
	).toEqual({ available: false })
})

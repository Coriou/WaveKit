import { stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import type { CatalogueType } from "./contract.js"

/** Decoder executables, excluding the DSP or shell wrappers used by adapters. */
export const DECODER_BINARIES: Readonly<Record<CatalogueType, string>> = {
	readsb: "readsb",
	"ais-catcher": "AIS-catcher",
	acarsdec: "acarsdec",
	dumpvdl2: "dumpvdl2",
	rtl433: "rtl_433",
	direwolf: "direwolf",
	"multimon-ng": "multimon-ng",
	"dsd-fme": "dsd-fme",
	"lora-meshtastic": "python3",
}

/**
 * Files an adapter passes to its executable that must also exist (absolute paths). Kept as a
 * literal so this module does not import the adapter at runtime; a test pins it to the adapter.
 */
export const DECODER_REQUIRED_FILES: Readonly<
	Partial<Record<CatalogueType, readonly string[]>>
> = {
	"lora-meshtastic": ["/usr/local/bin/lora_meshtastic_decode.py"],
}

type StatFs = { stat(p: string): Promise<{ isFile(): boolean; mode: number }> }

async function isRegularFile(fs: StatFs, path: string): Promise<boolean> {
	try {
		return (await fs.stat(path)).isFile()
	} catch {
		return false
	}
}

export async function resolveDecoderBinary(
	type: string,
	env: { PATH?: string | undefined },
	fs: StatFs = { stat },
): Promise<{ available: boolean }> {
	if (!Object.hasOwn(DECODER_BINARIES, type)) return { available: false }
	const binary = DECODER_BINARIES[type as CatalogueType]
	for (const required of DECODER_REQUIRED_FILES[type as CatalogueType] ?? [])
		if (!(await isRegularFile(fs, required))) return { available: false }
	for (const directory of (env.PATH ?? "").split(":")) {
		// Never search the working directory, implicitly or through a relative entry.
		if (!isAbsolute(directory)) continue
		try {
			const file = await fs.stat(join(directory, binary))
			if (file.isFile() && (file.mode & 0o111) !== 0) return { available: true }
		} catch {
			// Missing or unreadable candidates do not prevent checking later PATH entries.
		}
	}
	return { available: false }
}

/**
 * Synthetic scanner store for the analog longevity harnesses (measure only): clones the one
 * analog operation already recorded under `root` (its intent.json, receipt.json and WAV) into
 * `ops` operation folders with fresh ids spread over `folders` discovery folders, and writes
 * `legacy` other recordings (recordings/dv/). The clones parse and match like real ones;
 * recovery quarantines them (their discoveries do not exist), as a live store's old ones are
 * kept or quarantined.
 */
import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function cloneAnalogStore(opts: {
	root: string
	/** The discovery the seed recording was made for. */
	seedDiscoveryId: string
	ops: number
	legacy: number
	folders: number
}): Promise<void> {
	const { root, seedDiscoveryId: discoveryId } = opts
	const opsDir = join(root, ".analog-operations")
	const [seedId] = (await readdir(opsDir)).filter(n => !n.startsWith("."))
	if (!seedId) throw new Error("template operation folder missing")
	const intentText = await readFile(join(opsDir, seedId, "intent.json"), "utf8")
	const receiptText = await readFile(
		join(opsDir, seedId, "receipt.json"),
		"utf8",
	)
	const media = await readFile(
		join(root, "recordings", "analog", discoveryId, `analog-${seedId}.wav`),
	)
	const folder = (i: number): string =>
		`d_B${String(i % opts.folders).padStart(4, "0")}`
	for (let i = 0; i < opts.ops; i++) {
		const id = randomUUID()
		const swap = (text: string): string =>
			text.replaceAll(seedId, id).replaceAll(discoveryId, folder(i))
		await mkdir(join(opsDir, id))
		await writeFile(join(opsDir, id, "intent.json"), swap(intentText))
		await writeFile(join(opsDir, id, "receipt.json"), swap(receiptText))
		const mediaDir = join(root, "recordings", "analog", folder(i))
		await mkdir(mediaDir, { recursive: true })
		await writeFile(join(mediaDir, `analog-${id}.wav`), media)
	}
	for (let i = 0; i < opts.legacy; i++) {
		const dir = join(root, "recordings", "dv", folder(i))
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, `call-${i}.wav`), media)
	}
}

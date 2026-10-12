import { isAbsolute } from "node:path"
import { z } from "zod"
import { WaveKitError } from "../utils/errors.js"
import { PrivateAccessStorage } from "./private-storage.js"

const optionsSchema = z
	.object({
		directory: z
			.string()
			.min(1)
			.max(4096)
			.refine(isAbsolute)
			.refine(value => !value.includes("\0")),
	})
	.strict()

export type MachineRotationResult =
	| { kind: "rotated" }
	| { kind: "unavailable"; code: string }

/**
 * Offline replacement of the machine credential. Refuses while another live
 * owner holds the private directory. Remembered browser sessions stay in the
 * 0600 state file under the new binding. Nothing secret is returned.
 */
export async function rotateLocalMachineCredential(options: {
	directory: string
}): Promise<MachineRotationResult> {
	const parsed = optionsSchema.safeParse(options)
	if (!parsed.success)
		return { kind: "unavailable", code: "ACCESS_COMMAND_INVALID" }
	let storage: PrivateAccessStorage | undefined
	try {
		storage = await PrivateAccessStorage.open({
			directory: parsed.data.directory,
			mode: "load",
			ownership: "single-host-pid-namespace",
		})
		await storage.rotateMachineCredential()
		return { kind: "rotated" }
	} catch (error) {
		const code =
			error instanceof WaveKitError ? error.code : "ACCESS_STORAGE_UNAVAILABLE"
		return { kind: "unavailable", code }
	} finally {
		await storage?.close().catch(() => undefined)
	}
}

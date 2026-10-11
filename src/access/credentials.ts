import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { WaveKitError } from "../utils/errors.js"

export type AccessRandomBytes = (size: number) => Uint8Array

export function isCanonicalToken(value: string): boolean {
	return (
		/^[A-Za-z0-9_-]{43}$/.test(value) &&
		Buffer.from(value, "base64url").toString("base64url") === value
	)
}

export function generateMachineToken(
	random: AccessRandomBytes = randomBytes,
): string {
	try {
		const bytes = random(32)
		if (!(bytes instanceof Uint8Array) || bytes.length !== 32)
			throw new WaveKitError(
				"Credential generation failed",
				"CREDENTIAL_GENERATION_FAILED",
			)
		return Buffer.from(bytes).toString("base64url")
	} catch {
		throw new WaveKitError(
			"Credential generation failed",
			"CREDENTIAL_GENERATION_FAILED",
		)
	}
}

export function digestMachineToken(value: string): Buffer {
	if (!isCanonicalToken(value))
		throw new WaveKitError("Invalid credential", "INVALID_CREDENTIAL")
	return createHash("sha256").update(value, "ascii").digest()
}

export function verifyMachineToken(value: string, digest: Uint8Array): boolean {
	if (
		!isCanonicalToken(value) ||
		!(digest instanceof Uint8Array) ||
		digest.length !== 32
	)
		return false
	return timingSafeEqual(digestMachineToken(value), digest)
}

/** Bind persisted browser devices to one machine-credential generation. */
export function sessionCredentialBinding(digest: Uint8Array): string {
	if (!(digest instanceof Uint8Array) || digest.length !== 32)
		throw new WaveKitError("Invalid credential digest", "INVALID_CREDENTIAL")
	return createHash("sha256")
		.update("wavekit-access-sessions-v1\0")
		.update(digest)
		.digest("hex")
}

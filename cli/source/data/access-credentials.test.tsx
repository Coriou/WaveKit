import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	createFileCredentialProvider,
	MachineCredential,
} from "./access-credentials.js"

let directory: string
let path: string
const token = randomBytes(32).toString("base64url")
beforeEach(async () => {
	directory = await fs.mkdtemp(
		join(await fs.realpath(tmpdir()), "wavekit-cli-access-"),
	)
	await fs.chmod(directory, 0o700)
	path = join(directory, "machine-token")
	await fs.writeFile(path, `${token}\n`, { mode: 0o600 })
})
afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(directory, { recursive: true, force: true })
})
const read = () => createFileCredentialProvider({ path, format: "token" })()
function state(): unknown {
	const digest = createHash("sha256").update(token, "ascii").digest()
	const binding = createHash("sha256")
		.update("wavekit-access-sessions-v1\0")
		.update(digest)
		.digest("hex")
	return {
		version: 1,
		machineToken: token,
		credentialBinding: binding,
		sessions: { version: 1, credentialBinding: binding, sessions: [] },
	}
}
async function rejection(): Promise<void> {
	try {
		await read()
		expect.fail("must refuse unsafe credential")
	} catch (error) {
		expect(error).toMatchObject({
			name: "CliAccessError",
			code: "ACCESS_CREDENTIAL_UNAVAILABLE",
			message: "CLI access unavailable",
		})
		expect(String(error)).not.toContain(path)
		expect(JSON.stringify(error)).not.toContain(token)
		expect(error).not.toHaveProperty("cause")
	}
}

describe("read-only private credentials", () => {
	it("reads canonical tokens without exposing enumerable secrets or changing files", async () => {
		const before = await fs.readdir(directory)
		const credential = await read()
		expect(credential.use(value => value)).toBe(token)
		expect(JSON.stringify(credential)).toBe("{}")
		expect(inspect(credential)).not.toContain(token)
		expect({ ...credential }).toEqual({})
		expect(await fs.readdir(directory)).toEqual(before)
		expect(await fs.readFile(path, "utf8")).toBe(`${token}\n`)
	})
	it("reloads the file on each request to observe rotation", async () => {
		const provider = createFileCredentialProvider({ path, format: "token" })
		expect((await provider()).use(value => value)).toBe(token)
		const next = randomBytes(32).toString("base64url")
		await fs.writeFile(path, next)
		expect((await provider()).use(value => value)).toBe(next)
	})
	it.each([0o644, 0o640, 0o400, 0o1600])("rejects file mode %i", async mode => {
		await fs.chmod(path, mode)
		await rejection()
	})
	it.each([0o755, 0o750, 0o1700])("rejects directory mode %i", async mode => {
		await fs.chmod(directory, mode)
		await rejection()
	})
	it("rejects file symlinks", async () => {
		await fs.rename(path, `${path}.original`)
		await fs.symlink(`${path}.original`, path)
		await rejection()
	})
	it("rejects direct directory symlinks", async () => {
		const link = join(directory, "linked")
		await fs.symlink(directory, link)
		await expect(
			createFileCredentialProvider({
				path: join(link, "machine-token"),
				format: "token",
			})(),
		).rejects.toMatchObject({ code: "ACCESS_CREDENTIAL_UNAVAILABLE" })
	})
	it("rejects hard links", async () => {
		await fs.link(path, `${path}.link`)
		await rejection()
	})
	it("rejects a selected file replaced between lstat and open", async () => {
		const open = fs.open.bind(fs)
		vi.spyOn(fs, "open").mockImplementation(async (selected, flags, mode) => {
			if (selected === path) {
				await fs.rename(path, `${path}.old`)
				await fs.writeFile(path, token, { mode: 0o600 })
			}
			return open(selected, flags, mode)
		})
		await rejection()
	})
	it("rejects nonregular files without opening them", async () => {
		await fs.unlink(path)
		await fs.mkdir(path, { mode: 0o600 })
		await rejection()
	})
	it("rejects foreign ownership and unsupported uid checks", async () => {
		const uid = process.getuid!()
		const uidProcess = process as unknown as { getuid(): number | undefined }
		const getuid = vi.spyOn(uidProcess, "getuid")
		getuid.mockReturnValue(uid + 1)
		await rejection()
		getuid.mockReturnValue(undefined)
		await rejection()
	})
	it.each([
		"XXXXX-XXXXX",
		`${token}=`,
		`${token}\n\n`,
		` ${token}`,
		"a".repeat(129),
		"A".repeat(42) + "B",
	])("rejects malformed/noncanonical or oversized tokens", async value => {
		await fs.writeFile(path, value)
		await rejection()
	})
	it("sanitizes missing-file and malformed JSON errors", async () => {
		await fs.unlink(path)
		await rejection()
		await fs.writeFile(path, `{\"machineToken\":\"${token}\"`, { mode: 0o600 })
		await expect(
			createFileCredentialProvider({ path, format: "access-state" })(),
		).rejects.toMatchObject({ message: "CLI access unavailable" })
	})
	it("reads only the validated machine projection despite an existing core owner lock", async () => {
		await fs.writeFile(path, JSON.stringify(state()))
		await fs.writeFile(join(directory, "owner-core.lock"), "live", {
			mode: 0o600,
		})
		const provider = createFileCredentialProvider({
			path,
			format: "access-state",
		})
		expect((await provider()).use(value => value)).toBe(token)
		expect(await fs.readFile(join(directory, "owner-core.lock"), "utf8")).toBe(
			"live",
		)
	})
	it.each([
		{ version: 1, machineToken: token },
		{ ...(state() as object), credentialBinding: "0".repeat(64) },
		{ ...(state() as object), unexpected: token },
	])(
		"rejects incomplete, foreign-binding and extra-field state",
		async value => {
			await fs.writeFile(path, JSON.stringify(value))
			await expect(
				createFileCredentialProvider({ path, format: "access-state" })(),
			).rejects.toMatchObject({ code: "ACCESS_CREDENTIAL_UNAVAILABLE" })
		},
	)
	it("bounds access-state bytes before JSON parsing", async () => {
		await fs.writeFile(path, " ".repeat(65537))
		await expect(
			createFileCredentialProvider({ path, format: "access-state" })(),
		).rejects.toMatchObject({ code: "ACCESS_CREDENTIAL_UNAVAILABLE" })
	})
	it("rejects duplicate session records and invalid time bounds in the state projection", async () => {
		const value = state() as { sessions: { sessions: unknown[] } }
		const record = {
			deviceId: `device_${token}`,
			csrfToken: token,
			tokenHash: "0".repeat(64),
			createdAt: 1,
			renewedAt: 2,
			expiresAt: 3,
		}
		for (const records of [
			[record, record],
			[{ ...record, expiresAt: 1 }],
			Array.from({ length: 33 }, () => record),
		]) {
			value.sessions.sessions = records
			await fs.writeFile(path, JSON.stringify(value))
			await expect(
				createFileCredentialProvider({ path, format: "access-state" })(),
			).rejects.toMatchObject({ code: "ACCESS_CREDENTIAL_UNAVAILABLE" })
		}
	})
	it("rejects invalid provider options without echoing paths", () => {
		expect(() =>
			createFileCredentialProvider({ path: "private-secret", format: "token" }),
		).toThrow("CLI access unavailable")
	})
	it("canonical 32-byte credentials round-trip and stay opaque", () => {
		// Feature: core-access-policy, Property 2: Credential canonicality
		// Validates: Requirements 3.1, 6.3, 6.4
		fc.assert(
			fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), bytes => {
				const value = Buffer.from(bytes).toString("base64url")
				const credential = new MachineCredential(value)
				expect(credential.use(v => v)).toBe(value)
				expect(JSON.stringify(credential)).toBe("{}")
			}),
			{ numRuns: 100 },
		)
	})
})

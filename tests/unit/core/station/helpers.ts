import { vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Logger } from "../../../../src/utils/logger.js"

export async function makeTmp(): Promise<string> {
	return mkdtemp(join(tmpdir(), "wavekit-station-"))
}

export async function removeTmp(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true })
}

export interface StubLogger {
	logger: Logger
	warn: ReturnType<typeof vi.fn>
	error: ReturnType<typeof vi.fn>
}

export function stubLogger(): StubLogger {
	const warn = vi.fn()
	const error = vi.fn()
	const noop = vi.fn()
	const logger: Record<string, unknown> = {
		warn,
		error,
		info: noop,
		debug: noop,
		trace: noop,
		fatal: noop,
	}
	logger["child"] = () => logger
	return { logger: logger as unknown as Logger, warn, error }
}

import { WaveKitError } from "../utils/errors.js"

/**
 * Error fields a decoder log may carry (WG7 HW R2, fail closed by meaning). Node
 * errors carry argv (`spawnargs`, `path`), hosts (`hostname`, `address`, the DNS
 * `message`) and option text in `message`/`stack`; none of them reaches a log.
 */
export interface SafeErrorFields {
	/** Error class name, from code (a constructor name), never `err.name`. */
	type: string
	/** Node / WaveKit error code: `^[A-Z0-9_]{1,32}$` only. */
	code?: string
	/** Finite numeric errno. */
	errno?: number
	/** One of the known syscall names; Node's `"spawn <command>"` reduces to `spawn`. */
	syscall?: string
}

const CODE_PATTERN = /^[A-Z0-9_]{1,32}$/
const CLASS_NAME_PATTERN = /^[A-Z][A-Za-z0-9]{0,47}$/
const KNOWN_SYSCALLS = new Set([
	"spawn",
	"kill",
	"connect",
	"bind",
	"listen",
	"accept",
	"getaddrinfo",
	"getnameinfo",
	"read",
	"write",
	"open",
	"close",
	"stat",
	"lstat",
	"scandir",
	"readdir",
	"mkdir",
	"unlink",
	"rename",
	"send",
	"recv",
	"recvmsg",
	"shutdown",
	"pipe",
	"uv_pipe_open",
])

function className(err: object): string {
	const name: unknown = (err.constructor as { name?: unknown } | undefined)
		?.name
	return typeof name === "string" && CLASS_NAME_PATTERN.test(name)
		? name
		: "Error"
}

/**
 * Reduce any thrown value to allowlisted fields: class name, `code`, `errno`,
 * `syscall`. Never message, stack, path, spawnargs, hostname, address or port.
 * Log as `{ err: safeErrorFields(err) }` (a plain object without `message`
 * passes pino's err serializer unchanged).
 */
export function safeErrorFields(err: unknown): SafeErrorFields {
	if (err === null || typeof err !== "object") {
		return { type: typeof err }
	}
	const out: SafeErrorFields = { type: className(err) }
	// Own data properties only: no getters run, no prototype lookups.
	const read = (key: string): unknown => {
		const desc = Object.getOwnPropertyDescriptor(err, key)
		return desc !== undefined && "value" in desc ? desc.value : undefined
	}
	const code = err instanceof WaveKitError ? err.code : read("code")
	if (typeof code === "string" && CODE_PATTERN.test(code)) out.code = code
	const errno = read("errno")
	if (typeof errno === "number" && Number.isFinite(errno)) out.errno = errno
	const syscall = read("syscall")
	if (typeof syscall === "string") {
		const head = syscall.split(" ", 1)[0] ?? ""
		if (KNOWN_SYSCALLS.has(head)) out.syscall = head
	}
	return out
}

import {
	ConfigValidationError,
	DecoderParseError,
	DecoderSpawnError,
	DecoderVersionError,
	NetworkConnectionError,
	RegistryError,
	SourceConnectionError,
	WaveKitError,
} from "../utils/errors.js"

/**
 * Error fields a decoder log may carry (WG7 HW R2, fail closed by meaning). Node
 * errors carry argv (`spawnargs`, `path`), hosts (`hostname`, `address`, the DNS
 * `message`) and option text in `message`/`stack`; none of them reaches a log.
 */
export interface SafeErrorFields {
	/**
	 * Error class name from a fixed list of trusted classes (never `err.name` or a
	 * forgeable `constructor.name`); `"Object"` for a plain object, `"unknown"` otherwise.
	 */
	type: string
	/** Node / WaveKit error code: `^[A-Z0-9_]{1,32}$` only. */
	code?: string
	/** Finite numeric errno. */
	errno?: number
	/** One of the known syscall names; Node's `"spawn <command>"` reduces to `spawn`. */
	syscall?: string
}

const CODE_PATTERN = /^[A-Z0-9_]{1,32}$/
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

/** Most specific first: the first class the value is an instance of names it. */
const TRUSTED_CLASSES: readonly (readonly [
	abstract new (...args: never[]) => object,
	string,
])[] = [
	[ConfigValidationError, "ConfigValidationError"],
	[DecoderParseError, "DecoderParseError"],
	[DecoderSpawnError, "DecoderSpawnError"],
	[DecoderVersionError, "DecoderVersionError"],
	[NetworkConnectionError, "NetworkConnectionError"],
	[RegistryError, "RegistryError"],
	[SourceConnectionError, "SourceConnectionError"],
	[WaveKitError, "WaveKitError"],
	[TypeError, "TypeError"],
	[RangeError, "RangeError"],
	[SyntaxError, "SyntaxError"],
	[ReferenceError, "ReferenceError"],
	[URIError, "URIError"],
	[EvalError, "EvalError"],
	[AggregateError, "AggregateError"],
	[Error, "Error"],
]

function className(err: object): string {
	// instanceof only walks the prototype chain (a hostile proxy may throw: caller catches).
	for (const [cls, name] of TRUSTED_CLASSES) if (err instanceof cls) return name
	const proto: unknown = Object.getPrototypeOf(err)
	return proto === Object.prototype || proto === null ? "Object" : "unknown"
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
	try {
		const out: SafeErrorFields = { type: className(err) }
		// Own data properties only: no getters run, no prototype lookups.
		const read = (key: string): unknown => {
			const desc = Object.getOwnPropertyDescriptor(err, key)
			return desc !== undefined && "value" in desc ? desc.value : undefined
		}
		const code = read("code")
		if (typeof code === "string" && CODE_PATTERN.test(code)) out.code = code
		const errno = read("errno")
		if (typeof errno === "number" && Number.isFinite(errno)) out.errno = errno
		const syscall = read("syscall")
		if (typeof syscall === "string") {
			const head = syscall.split(" ", 1)[0] ?? ""
			if (KNOWN_SYSCALLS.has(head)) out.syscall = head
		}
		return out
	} catch {
		// A revoked proxy or a throwing trap: the sanitiser itself never throws.
		return { type: "unknown" }
	}
}

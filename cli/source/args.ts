import { VIEW_ORDER, type ViewId } from "./ui/actions.js"
import { ASCII_GLYPHS, UTF8_GLYPHS, glyphs, type Glyphs } from "./ui/theme.js"

export const VIEW_ALIASES: Readonly<Record<string, ViewId>> = {
	overview: "overview",
	decoders: "decoders",
	messages: "messages",
	receiver: "receiver",
	system: "system",
	dashboard: "overview",
	output: "messages",
	backpressure: "decoders",
	sources: "receiver",
	tuner: "receiver",
	"live-audio": "system",
	resources: "system",
}

export type ParsedArgs =
	| { kind: "run"; view: ViewId; api?: string }
	| { kind: "help" }
	| { kind: "error"; message: string }

const VALID = VIEW_ORDER.join(", ")
const ALIASES = Object.keys(VIEW_ALIASES)
	.filter(k => !VIEW_ORDER.includes(k as ViewId))
	.join(", ")

function lookupView(v: string): ViewId | undefined {
	return Object.hasOwn(VIEW_ALIASES, v) ? VIEW_ALIASES[v] : undefined
}

function viewError(v: string): ParsedArgs {
	return {
		kind: "error",
		message: `wavekit: invalid view "${v}" ${glyphs().sep} valid views: ${VALID} (aliases: ${ALIASES})`,
	}
}

/** Reads `--flag value` or `--flag=value`; returns the value and the index of the last token consumed. */
function flagValue(
	argv: readonly string[],
	i: number,
	flag: string,
): { value: string | undefined; next: number } {
	const a = argv[i] ?? ""
	if (a.startsWith(`${flag}=`))
		return { value: a.slice(flag.length + 1), next: i }
	return { value: argv[i + 1], next: i + 1 }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" }
	let view: ViewId = "overview"
	let api: string | undefined
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? ""
		if (a === "--view" || a === "-v" || a.startsWith("--view=")) {
			const { value, next } = flagValue(argv, i, "--view")
			i = next
			const id = value === undefined ? undefined : lookupView(value)
			if (id === undefined) return viewError(value ?? "")
			view = id
			continue
		}
		if (a === "--api" || a.startsWith("--api=")) {
			const { value, next } = flagValue(argv, i, "--api")
			i = next
			if (value === undefined || value === "" || value.startsWith("-")) {
				return {
					kind: "error",
					message:
						"wavekit: --api needs a URL, e.g. --api http://127.0.0.1:9000",
				}
			}
			api = value
			continue
		}
		return {
			kind: "error",
			message: `wavekit: unknown argument "${a}" ${glyphs().sep} see wavekit --help`,
		}
	}
	return api === undefined ? { kind: "run", view } : { kind: "run", view, api }
}

/** Help in the given glyph set; cli.tsx prints it after the glyph mode is set (WAVEKIT_ASCII, locale). */
export function helpText(g: Glyphs = glyphs()): string {
	const ascii = g === ASCII_GLYPHS
	const to = ascii ? "->" : "→"
	const unicode = ascii
		? "Unicode marks"
		: [
				UTF8_GLYPHS.live,
				UTF8_GLYPHS.neutral,
				UTF8_GLYPHS.fault,
				UTF8_GLYPHS.ellipsis,
			].join(" ")
	return `wavekit ${g.sep} WaveKit terminal dashboard

Usage:
  wavekit [--view <view>] [--api <url>]
  wavekit --help

Views (keys 1-5):
  overview   1  chain strip, receiver, decoders, latest messages
  decoders   2  process state, decodes and IQ drops per decoder
  messages   3  filterable, pausable decoded-message feed
  receiver   4  source, tuner, relay, fanout and upstream drops
  system     5  container, SDR host, live audio, core

Aliases:
  dashboard ${to} overview, output ${to} messages, backpressure ${to} decoders,
  sources ${to} receiver, tuner ${to} receiver,
  live-audio ${to} system, resources ${to} system

Options:
  --view, -v <view>   open this view first
  --api <url>         WaveKit API base URL, e.g. http://127.0.0.1:9000
  --help, -h          show this help

Environment:
  WAVEKIT_API_URL     API base URL (WebSocket derived as ws://host/ws)
  WAVEKIT_WS_URL      WebSocket URL (API base derived from it)
  WAVEKIT_WS_URLS     comma-separated WebSocket URLs; the first is used
  NO_COLOR            no colour (bold, dim and inverse are kept)
  WAVEKIT_ASCII=1     ASCII glyphs instead of ${unicode} (also used when the
                      locale does not name UTF-8)

Precedence: --api, then WAVEKIT_API_URL, then WAVEKIT_WS_URL / WAVEKIT_WS_URLS.
With none set, wavekit tries http://127.0.0.1:9000, then http://127.0.0.1:3000.
localhost is read as 127.0.0.1. Port 4713 is the RTL-TCP relay, not the API.
`
}

export const HELP_TEXT = helpText(UTF8_GLYPHS)

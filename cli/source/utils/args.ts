/**
 * Argument parser for WaveKit CLI
 */

export type View =
	| "dashboard"
	| "decoders"
	| "output"
	| "backpressure"
	| "sources"
	| "live-audio"

export interface ParsedArgs {
	view: View
	help: boolean
}

const validViews: View[] = [
	"dashboard",
	"decoders",
	"output",
	"backpressure",
	"sources",
	"live-audio",
]

export function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = {
		view: "dashboard",
		help: false,
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]

		if (arg === "--help" || arg === "-h") {
			result.help = true
		} else if (arg === "--view" || arg === "-v") {
			const view = argv[i + 1]
			if (view && validViews.includes(view as View)) {
				result.view = view as View
				i++
			}
		}
	}

	return result
}

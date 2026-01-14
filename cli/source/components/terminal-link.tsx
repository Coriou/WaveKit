/**
 * TerminalLink Component - Clickable hyperlinks in terminal
 *
 * Uses OSC 8 escape sequences to create clickable links in supported terminals.
 * Works with iTerm2, Terminal.app, VS Code integrated terminal, Hyper, etc.
 *
 * @see https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda
 */

import React from "react"
import { Text, Transform } from "ink"

interface TerminalLinkProps {
	/** The URL to link to */
	url: string
	/** The visible text (children) */
	children: React.ReactNode
	/** Whether to show in dim color */
	dimColor?: boolean
}

/**
 * Wrap text with OSC 8 hyperlink escape sequences.
 * The Transform component allows us to modify the output after Ink renders it.
 */
export function TerminalLink({
	url,
	children,
	dimColor,
}: TerminalLinkProps): React.ReactElement {
	// OSC 8 hyperlink format: \x1b]8;;URL\x07TEXT\x1b]8;;\x07
	const wrapWithLink = (text: string): string => {
		return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
	}

	return (
		<Transform transform={wrapWithLink}>
			<Text dimColor={dimColor}>{children}</Text>
		</Transform>
	)
}

export default TerminalLink

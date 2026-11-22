// Every hint in Listen, in one place (docs/web/DESIGN.md, Hints: the writing rules). Settings repeats the
// shared ones (Voice only), so a sentence is defined once.
import { createElement } from "react"

import type { HintContent } from "../../ui/Hint.tsx"
import { Kbd } from "../../ui/Kbd.tsx"

/** Foot of the cards whose setting every device hears. */
const SHARED = "Shared with every device listening"

export const SQUELCH_HINT: HintContent = {
	text: "Keeps the speaker quiet until there is something to hear.",
	learn: {
		rows: [
			{
				term: "Auto",
				text: "Opens when a signal rises above the noise, and adapts as the noise changes.",
			},
			{ term: "Manual", text: "Plays everything above the line you set." },
			{
				term: "Open",
				text: [
					"Plays everything, noise included. ",
					createElement(Kbd, { key: "q" }, "Q"),
					" opens it and goes back.",
				],
			},
		],
		foot: SHARED,
	},
}

export const VOICE_ONLY_HINT: HintContent = {
	text: "Plays only when someone talks; carriers, data and pagers stay silent. Voice arrives about 1 s late, uncut.",
}

export const TONE_SQUELCH_HINT: HintContent = {
	text: "Plays only transmissions that carry this tone; others sharing the channel stay silent.",
}

export const SOURCE_HINT: HintContent = {
	text: "Chooses what plays on channels that carry digital voice.",
	learn: {
		rows: [
			{
				term: "Auto",
				text: "The channel's own audio, switching to decoded voice during a digital call.",
			},
			{
				term: "Analog",
				text: "Always the channel's own audio; a digital call sounds like a buzz.",
			},
			{ term: "Digital", text: "Only decoded voice; silent between calls." },
		],
		foot: SHARED,
	},
}

export const LEVEL_CONTROL_HINT: HintContent = {
	text: "Evens out loud and quiet stations. Fast suits AM and SSB, Off suits FM.",
}

export const DEEMPHASIS_HINT: HintContent = {
	text: "Tames the boosted treble of FM broadcasts. Europe uses 50 µs, the Americas 75.",
}

export const HEARD_HINT: HintContent = {
	text: "Share of the last 10 s of audio that reached this browser. Drops usually mean WaveKit is busy.",
}

/**
 * The head's Play anyway button: its description (the head takes no marks), and the receipt toast with Undo
 * says what happened.
 */
export const PLAY_ANYWAY_TEXT = "Turns Voice only off, so every carrier plays."

/** Every Listen hint, for the copy test and the report. */
export const LISTEN_HINTS: Readonly<Record<string, HintContent>> = {
	Squelch: SQUELCH_HINT,
	"Voice only": VOICE_ONLY_HINT,
	"Tone squelch": TONE_SQUELCH_HINT,
	Source: SOURCE_HINT,
	"Level control": LEVEL_CONTROL_HINT,
	"De-emphasis": DEEMPHASIS_HINT,
	"the heard figure": HEARD_HINT,
}

export interface BannedRule {
	id: string
	re: RegExp
}

/** Spec §9 banned list plus T8 blame words. Matched after stripQuoted(). */
export const BANNED_RULES: readonly BannedRule[] = [
	{ id: "Waiting for", re: /\bWaiting for\b/i },
	{ id: "No … yet", re: /\bNo\b.*\byet\b/ },
	{ id: "Loading", re: /\bLoading\b/i },
	{ id: "OK", re: /\bOK\b/ },
	{ id: "healthy", re: /\b(?:un)?healthy\b/i },
	{ id: "stable", re: /\bstable\b/i },
	{ id: "all good", re: /\ball good\b/i },
	{ id: "Status:", re: /\bStatus:/ },
	{ id: "n/a", re: /\bn\/a\b/i },
	{ id: "unavailable", re: /\bunavailable\b(?! ·)/i },
	{ id: "successfully", re: /\bsuccessfully\b/i },
	{ id: "please", re: /\bplease\b/i },
	{ id: "sentence !", re: /[A-Za-z0-9)]!(?=\s|$)/ },
	{ id: "360°", re: /360°/ },
	{ id: "press N to view", re: /\bpress \S+ to view\b/i },
	{ id: "Connected", re: /\bConnected\b/ },
	{ id: "slow", re: /\bslow\b/i },
	{ id: "lagging", re: /\blagging\b/i },
	{ id: "overloaded", re: /\boverloaded\b/i },
	{ id: "bottleneck", re: /\bbottleneck\b/i },
	{ id: "emoji", re: /\p{Emoji_Presentation}/u },
]

/** Server-quoted text ("…") is shown verbatim and is exempt from the copy rules. */
export function stripQuoted(text: string): string {
	return text.replace(/"[^"\n]*"/g, '""')
}

export function findBanned(text: string): string[] {
	const t = stripQuoted(text)
	return BANNED_RULES.filter(r => r.re.test(t)).map(r => r.id)
}

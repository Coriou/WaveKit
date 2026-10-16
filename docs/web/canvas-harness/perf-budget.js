// perf-budget.js: spec §8 glass and animation budget, evaluated in a rendered board.
(() => {
	const all = [...document.querySelectorAll("*")]
	const blurred = all.filter(e => { const cs = getComputedStyle(e); const b = cs.backdropFilter || cs.webkitBackdropFilter; return b && b !== "none" })
	const nested = blurred.filter(e => blurred.some(o => o !== e && o.contains(e)))
	const banned = blurred.filter(e => e.closest(".wk-drawer,.wk-menu,.wk-toast,.wk-tip,[data-wk-theme=\"light\"]"))
	const props = new Set()
	const badAnims = []
	for (const a of document.getAnimations()) {
		const t = a.effect && a.effect.getTiming && a.effect.getTiming()
		if (!t || t.iterations !== Infinity || a.playState !== "running") continue
		const kf = a.effect.getKeyframes()
		const ps = new Set(kf.flatMap(k => Object.keys(k).filter(x => !["offset", "easing", "composite", "computedOffset"].includes(x))))
		const bad = [...ps].filter(p => p !== "opacity" && p !== "transform")
		ps.forEach(p => props.add(p))
		if (bad.length) badAnims.push((a.animationName || a.id || "anim") + ":" + bad.join("/"))
	}
	const d = e => (e.className && typeof e.className === "string" ? e.tagName.toLowerCase() + "." + e.className.split(" ")[0] : e.tagName.toLowerCase()) + (e.getAttribute("aria-label") ? "[" + e.getAttribute("aria-label") + "]" : "")
	return { blurred: blurred.length, blurredList: blurred.slice(0, 12).map(d), nested: nested.map(d), banned: banned.map(d), badInfiniteAnimations: [...new Set(badAnims)] }
})()

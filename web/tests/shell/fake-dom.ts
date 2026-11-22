// A minimal DOM for mounting a component with react-dom/client in node (no jsdom in this workspace): enough for
// React to create, update and remove elements and run its effects. No layout, no events, no selectors
// (querySelector finds nothing). Install it before the first render and remove it after the test.

type Listener = () => void

class FakeStyle {
	[key: string]: unknown
	readonly props = new Map<string, string>()
	setProperty(name: string, value: string): void {
		this.props.set(name, value)
	}
	removeProperty(name: string): string {
		const v = this.props.get(name) ?? ""
		this.props.delete(name)
		return v
	}
}

export class FakeNode {
	readonly childNodes: FakeNode[] = []
	parentNode: FakeNode | null = null
	nodeValue: string | null = null
	constructor(
		readonly nodeType: number,
		readonly nodeName: string,
		readonly ownerDocument: FakeDocument | null,
	) {}
	get firstChild(): FakeNode | null {
		return this.childNodes[0] ?? null
	}
	get lastChild(): FakeNode | null {
		return this.childNodes[this.childNodes.length - 1] ?? null
	}
	get nextSibling(): FakeNode | null {
		const p = this.parentNode
		if (!p) return null
		return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null
	}
	get parentElement(): FakeNode | null {
		return this.parentNode
	}
	get textContent(): string {
		return this.nodeType === 3
			? (this.nodeValue ?? "")
			: this.childNodes.map(c => c.textContent).join("")
	}
	set textContent(text: string) {
		if (this.nodeType === 3) {
			this.nodeValue = text
			return
		}
		for (const c of this.childNodes) c.parentNode = null
		this.childNodes.length = 0
		if (text !== "" && this.ownerDocument)
			this.appendChild(this.ownerDocument.createTextNode(text))
	}
	set data(text: string) {
		this.nodeValue = text
	}
	appendChild(c: FakeNode): FakeNode {
		return this.insertBefore(c, null)
	}
	insertBefore(c: FakeNode, before: FakeNode | null): FakeNode {
		if (c.parentNode) c.parentNode.removeChild(c)
		const i = before ? this.childNodes.indexOf(before) : -1
		if (i < 0) this.childNodes.push(c)
		else this.childNodes.splice(i, 0, c)
		c.parentNode = this
		return c
	}
	removeChild(c: FakeNode): FakeNode {
		const i = this.childNodes.indexOf(c)
		if (i >= 0) this.childNodes.splice(i, 1)
		c.parentNode = null
		return c
	}
	contains(n: FakeNode | null): boolean {
		for (let p = n; p; p = p.parentNode) if (p === this) return true
		return false
	}
	addEventListener(_type: string, _l: Listener): void {}
	removeEventListener(_type: string, _l: Listener): void {}
}

export class FakeElement extends FakeNode {
	readonly attributes = new Map<string, string>()
	readonly style = new FakeStyle()
	readonly tagName: string
	constructor(
		tag: string,
		doc: FakeDocument | null,
		readonly namespaceURI = "http://www.w3.org/1999/xhtml",
	) {
		super(1, tag.toUpperCase(), doc)
		this.tagName = tag.toUpperCase()
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, String(value))
	}
	setAttributeNS(_ns: string | null, name: string, value: string): void {
		this.setAttribute(name, value)
	}
	removeAttribute(name: string): void {
		this.attributes.delete(name)
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null
	}
	hasAttribute(name: string): boolean {
		return this.attributes.has(name)
	}
	querySelector(_sel: string): null {
		return null
	}
	querySelectorAll(_sel: string): never[] {
		return []
	}
	closest(_sel: string): null {
		return null
	}
	focus(): void {}
	blur(): void {}
	/** The first descendant (or this) whose attribute `name` equals `value`. */
	find(name: string, value: string): FakeElement | null {
		if (this.attributes.get(name) === value) return this
		for (const c of this.childNodes)
			if (c instanceof FakeElement) {
				const hit = c.find(name, value)
				if (hit) return hit
			}
		return null
	}
}

export class FakeDocument extends FakeNode {
	readonly body: FakeElement
	readonly documentElement: FakeElement
	activeElement: FakeElement
	defaultView: unknown = null
	constructor() {
		super(9, "#document", null)
		this.documentElement = new FakeElement("html", this)
		this.body = new FakeElement("body", this)
		this.documentElement.appendChild(this.body)
		this.appendChild(this.documentElement)
		this.activeElement = this.body
	}
	createElement(tag: string): FakeElement {
		return new FakeElement(tag, this)
	}
	createElementNS(ns: string, tag: string): FakeElement {
		return new FakeElement(tag, this, ns)
	}
	createTextNode(text: string): FakeNode {
		const t = new FakeNode(3, "#text", this)
		t.nodeValue = text
		return t
	}
	createComment(text: string): FakeNode {
		const t = new FakeNode(8, "#comment", this)
		t.nodeValue = text
		return t
	}
}

class FakeIFrame {}

const KEYS = [
	"window",
	"document",
	"HTMLElement",
	"HTMLIFrameElement",
	"IS_REACT_ACT_ENVIRONMENT",
] as const

/** Put a fresh fake document on globalThis; returns it and a function that puts the old globals back. */
export function installFakeDom(): {
	doc: FakeDocument
	restore: () => void
} {
	const g = globalThis as Record<string, unknown>
	const old = new Map<string, unknown>(KEYS.map(k => [k, g[k]]))
	const doc = new FakeDocument()
	const win: Record<string, unknown> = {
		document: doc,
		HTMLIFrameElement: FakeIFrame,
		HTMLElement: FakeElement,
		event: undefined,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	}
	doc.defaultView = win
	g["window"] = win
	g["document"] = doc
	g["HTMLElement"] = FakeElement
	g["HTMLIFrameElement"] = FakeIFrame
	g["IS_REACT_ACT_ENVIRONMENT"] = true
	return {
		doc,
		restore: () => {
			for (const [k, v] of old)
				if (v === undefined) delete g[k]
				else g[k] = v
		},
	}
}

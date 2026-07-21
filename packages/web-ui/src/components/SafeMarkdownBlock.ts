import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";

// URL schemes allowed in rendered markdown links. Everything else
// (javascript:, data:, vbscript:, ...) is neutralized to plain text.
const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto"]);

function isDangerousHref(href: string): boolean {
	// Strip whitespace that could obfuscate the scheme (e.g. "java\tscript:")
	const cleaned = href.replace(/\s/g, "");
	const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
	// Scheme-less hrefs (relative paths, #fragments) cannot execute script
	if (!schemeMatch) return false;
	return !SAFE_LINK_SCHEMES.has(schemeMatch[1].toLowerCase());
}

/**
 * Drop-in replacement for mini-lit's <markdown-block> that neutralizes links
 * with dangerous URL schemes (javascript:, data:, vbscript:, ...).
 *
 * MarkdownBlock escapes source HTML but never sanitizes the HTML *generated*
 * by marked before passing it to unsafeHTML, so [click](javascript:alert(1))
 * would produce a link executing in the app origin. Since MarkdownBlock uses
 * light DOM and re-renders asynchronously while streaming, we observe its DOM
 * and unwrap dangerous anchors into plain text after every render.
 */
@customElement("safe-markdown-block")
export class SafeMarkdownBlock extends LitElement {
	@property() content = "";
	@property({ type: Boolean }) isThinking = false;

	private observer?: MutationObserver;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.observer = new MutationObserver(() => this.sanitizeLinks());
		this.observer.observe(this, { childList: true, subtree: true });
	}

	override disconnectedCallback(): void {
		this.observer?.disconnect();
		this.observer = undefined;
		super.disconnectedCallback();
	}

	private sanitizeLinks(): void {
		for (const anchor of Array.from(this.querySelectorAll("a[href]"))) {
			const href = anchor.getAttribute("href") ?? "";
			if (!isDangerousHref(href)) continue;
			// Unwrap: keep the link text, drop the executable href
			const span = document.createElement("span");
			span.textContent = anchor.textContent;
			anchor.replaceWith(span);
		}
	}

	override render() {
		return html`<markdown-block .content=${this.content} .isThinking=${this.isThinking}></markdown-block>`;
	}
}

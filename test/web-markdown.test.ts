// The web UI's markdown renderer (src/web/ui/markdown.js): the vendored marked + DOMPurify builds are loaded into a
// test DOM exactly as the browser loads them (classic scripts, in order), and md()/inline() are checked for GFM
// features, safety (scripts, handlers, javascript:/data: links, foreign images) and the no-library fallback.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const UI = join(import.meta.dirname, "../src/web/ui");
const MARKED = readFileSync(join(dirname(require.resolve("marked")), "marked.umd.js"), "utf8");
const PURIFY = readFileSync(require.resolve("dompurify/dist/purify.min.js"), "utf8");
const RENDERER = readFileSync(join(UI, "markdown.js"), "utf8");

type Win = JSDOM["window"] & { md(t: unknown): string; inline(t: unknown): string; __alerted?: boolean };
function load(libs = true): Win {
	const dom = new JSDOM("<!doctype html><body></body>", { url: "http://127.0.0.1:8484/", runScripts: "outside-only" });
	const w = dom.window as Win;
	w.alert = () => { w.__alerted = true; };
	if (libs) { w.eval(MARKED); w.eval(PURIFY); }
	w.eval(RENDERER);
	return w;
}
const frag = (w: Win, html: string) => { const d = w.document.createElement("div"); d.innerHTML = html; return d; };

describe("md(): GFM rendering", () => {
	const w = load();

	test("tables, nested lists, blockquotes, h3/h4, emphasis, strikethrough and links", () => {
		const src = [
			"### Heading three", "#### Heading four", "",
			"| a | b |", "|---|---|", "| 1 | 2 |", "",
			"- outer", "  - inner", "",
			"> quoted", "",
			"*italic* ~~gone~~ **bold** [label](https://example.com)",
		].join("\n");
		const d = frag(w, w.md(src));
		expect(d.querySelector("h3")?.textContent).toBe("Heading three");
		expect(d.querySelector("h4")?.textContent).toBe("Heading four");
		expect(d.querySelectorAll("table td").length).toBe(2);
		expect(d.querySelector("ul li ul li")?.textContent).toBe("inner");
		expect(d.querySelector("blockquote")?.textContent?.trim()).toBe("quoted");
		expect(d.querySelector("em")?.textContent).toBe("italic");
		expect(d.querySelector("del")?.textContent).toBe("gone");
		const a = d.querySelector("a")!;
		expect(a.textContent).toBe("label");
		expect(a.getAttribute("href")).toBe("https://example.com");
		expect(a.getAttribute("target")).toBe("_blank");
		expect(a.getAttribute("rel")).toBe("noopener noreferrer");
		expect(d.textContent).not.toMatch(/[|>[]/);
	});

	test("soft line breaks inside a paragraph; a blank line starts a new one", () => {
		const d = frag(w, w.md("line one\nline two\n\nnext para"));
		const ps = d.querySelectorAll("p");
		expect(ps.length).toBe(2);
		expect(ps[0]!.querySelector("br")).not.toBeNull();
		expect(ps[0]!.textContent).toBe("line oneline two");
	});

	test("task lists render disabled checkboxes", () => {
		const d = frag(w, w.md("- [ ] todo\n- [x] done"));
		const boxes = [...d.querySelectorAll("input")];
		expect(boxes.length).toBe(2);
		expect(boxes.every((b) => b.type === "checkbox" && b.disabled)).toBe(true);
		expect(boxes[1]!.checked).toBe(true);
	});

	test("fenced code is verbatim and not rendered as markdown", () => {
		const d = frag(w, w.md("```ts\nconst a = b < c && d > e; // **not bold** [x](y)\n```"));
		const code = d.querySelector("pre code")!;
		expect(code.textContent).toBe("const a = b < c && d > e; // **not bold** [x](y)\n");
		expect(code.querySelector("strong, a")).toBeNull();
	});

	test("bare URLs autolink; h1–h6 and hr render", () => {
		const d = frag(w, w.md("see https://example.org/x\n\n###### six\n\n---"));
		expect(d.querySelector("a")?.getAttribute("href")).toBe("https://example.org/x");
		expect(d.querySelector("h6")).not.toBeNull();
		expect(d.querySelector("hr")).not.toBeNull();
	});

	test("deterministic: the same text gives the same HTML", () => {
		const s = "# t\n\n- a\n- b\n\n| x |\n|---|\n| y |";
		expect(w.md(s)).toBe(w.md(s));
	});
});

describe("md(): safety", () => {
	const w = load();

	test("script tags, event handlers and javascript:/data: links are neutralised", () => {
		const html = w.md("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [y](data:text/html,<script>alert(1)</script>) <a href=\"JaVaScRiPt:alert(1)\">z</a>");
		const d = frag(w, html);
		expect(d.querySelector("script")).toBeNull();
		expect(html).not.toMatch(/onerror/i);
		for (const a of d.querySelectorAll("a")) {
			expect(a.getAttribute("href") ?? "").not.toMatch(/^\s*(javascript|data):/i);
			expect(a.getAttribute("rel")).toBe("noopener noreferrer");
		}
		expect(html).not.toMatch(/javascript:/i);
		w.document.body.innerHTML = html;
		expect(w.__alerted).toBeUndefined();
	});

	test("style, iframe, object, form and inline styles are stripped; harmless inline tags stay", () => {
		const html = w.md('<style>body{display:none}</style><iframe src="https://evil"></iframe><object data="x"></object><form action="/x"><input name="q"></form><span style="position:fixed">s</span> <kbd>K</kbd>');
		const d = frag(w, html);
		expect(d.querySelector("style, iframe, object, form, input")).toBeNull();
		expect(d.querySelector("[style]")).toBeNull();
		expect(d.querySelector("kbd")?.textContent).toBe("K");
	});

	test("images load only from this origin or data:; foreign ones become links or alt text", () => {
		const d = frag(w, w.md("![local](/api/runs/r1/screenshots/s1) ![inline](data:image/png;base64,iVBORw0KGgo=) ![far](https://evil.example/t.png) ![rel](ftp://x/y.png)"));
		const srcs = [...d.querySelectorAll("img")].map((i) => i.getAttribute("src"));
		expect(srcs).toEqual(["/api/runs/r1/screenshots/s1", "data:image/png;base64,iVBORw0KGgo="]);
		const far = [...d.querySelectorAll("a")].find((a) => a.textContent === "far");
		expect(far?.getAttribute("href")).toBe("https://evil.example/t.png");
		expect(far?.getAttribute("rel")).toBe("noopener noreferrer");
		expect(d.textContent).toContain("rel");
		const raw = frag(w, w.md('<img src="http://evil.example/p.gif" alt="pixel">'));
		expect(raw.querySelector("img")).toBeNull();
	});

	test("inline(): one-line markdown without block wrappers, sanitised", () => {
		const html = w.inline("**bold** `code` [l](https://e.com) <script>alert(1)</script> [j](javascript:alert(1))");
		const d = frag(w, html);
		expect(d.querySelector("p, ul, h1")).toBeNull();
		expect(d.querySelector("strong")?.textContent).toBe("bold");
		expect(d.querySelector("code")?.textContent).toBe("code");
		expect(d.querySelector("script")).toBeNull();
		expect(html).not.toMatch(/javascript:/i);
		for (const a of d.querySelectorAll("a")) expect(a.getAttribute("rel")).toBe("noopener noreferrer");
	});
});

describe("fallback without the libraries", () => {
	test("escaped plain text with line breaks kept", () => {
		const w = load(false);
		const html = w.md("<script>alert(1)</script>\nsecond **line**");
		expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;<br>second **line**</p>");
		expect(w.inline("<b>x</b>")).toBe("&lt;b&gt;x&lt;/b&gt;");
		expect(w.md("")).toBe("");
	});
});

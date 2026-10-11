# Progress — full markdown rendering in the web UI

- [x] marked 18.1.0 + dompurify 3.4.16 as exact runtime deps; jsdom + @types/jsdom dev deps for tests
- [x] server: exact STATIC routes /vendor/marked.js (marked's lib/marked.umd.js, found next to its exported entry),
      /vendor/purify.js (dist/purify.min.js), /markdown.js; lookup uses Object.hasOwn (no prototype keys)
- [x] src/web/ui/markdown.js defines globals md()/inline(); app.js's hand-written versions removed
- [x] ask_human question card uses md(); finding descriptions keep inline()
- [x] CSS for markdown elements (tables scroll via display:block + overflow-x)
- [x] tests: test/web-markdown.test.ts (jsdom), vendor route tests in test/web.test.ts
- [x] docs: design-spec §3.6 bullet, README web UI paragraph, AGENTS.md, scripts/setup.sh, scripts/run.sh

Decisions
- Separate markdown.js file (own static route) rather than inlining in app.js: testable in jsdom in isolation.
- Private DOMPurify instance (DOMPurify(window)) so hooks don't leak to the global.
- Foreign images are replaced in a DOMPurify hook inside its inert document (no request): http(s) → link, else alt text.
- No CI workflow: the project has none and the spec doesn't require one.
- No browser available in the build sandbox; layout checked by reasoning (grid minmax(0,1fr), .blk min-width:0).
- Full suite: 8–9 failures in sandbox*.test.ts / durability.test.ts are pre-existing here (bwrap cannot create namespaces in this build host); identical on the base commit.

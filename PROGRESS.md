# Progress (run-mv46hn3a-f4fa: Chat button + full-screen chat)

- [x] core: optional title (deriveTitle in discussion-doc.ts), listModels op (+CORE_OPS), tests
- [ ] UI: remove Discussions tab/list/modal; Chat button; full-screen chat view
- [ ] docs: README Web UI, design-doc amendment, architecture.md ops
- [ ] AGENTS.md, scripts/setup.sh, scripts/run.sh, CI

## Decisions / notes
- Starting two discussions concurrently on a project whose clone does not exist yet can fail one (pre-existing core race); tests start them sequentially.

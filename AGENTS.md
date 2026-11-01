# Repository Guidelines

## Project Overview

A Chrome MV3 extension ("自助签到中转站") built with WXT, React 19, TypeScript, Zustand, and Tailwind CSS. It automates multi-site login and check-in: the background worker owns browser APIs and scheduling, while content scripts drive page interactions. See `docs/ARCHITECTURE.md`.

## Project Structure & Module Organization

- `src/entrypoints/` — `background.ts`, `auto-login.content.ts`, `options/`, `sidepanel/`; keep WXT entry names stable.
- `src/automation/` — login, check-in, challenge, learning, and balance logic.
- `src/background/` — queues, proxies, OAuth, sliders, and task lifecycle.
- `src/components/`, `src/stores/`, `src/data/` — UI, Zustand state, and the centralized storage write boundary.
- `src/lib/`, `src/sites/`, `src/types/` — shared utilities, site templates, and runtime-free contracts.
- `tests/e2e/`, `tests/smoke/`, `tests/dev-probes/` — Playwright regressions, smoke checks, and one-off probes; unit tests sit beside source as `*.test.ts`.
- `public/`, `scripts/`, `docs/` — assets, scripts, docs.

## Build, Test, and Development Commands

- `pnpm install` — install dependencies; runs `wxt prepare`.
- `pnpm dev` — start WXT development mode.
- `pnpm compile` — strict TypeScript check.
- `pnpm build` — build to `.output/chrome-mv3`; `pnpm zip` packages it.
- `pnpm test` — run Vitest with one worker; `pnpm test:watch` watches.
- `pnpm test:fixture` then `pnpm test:e2e` — build the fixture and run Playwright tests; build the extension first.
- `pnpm test:ui` — UI screenshots and layout assertions.
- `pnpm test:real:smoke` / `pnpm test:real:site --site <name> --real` — read-only and credentialed site checks (see `docs/TESTING_GUIDE.md`).

## Coding Style & Naming Conventions

Use two-space indentation, single quotes, and the `@/*` alias. Name components PascalCase, functions camelCase, modules kebab-case, and constants UPPER_SNAKE_CASE. No linter/formatter is configured; match nearby code. Keep comments and UI copy in Chinese. UI code calls the background through typed messages; `background/` must not import React, `automation/` must not write persistence, and `types/` must stay runtime-free.

## Testing Guidelines

Vitest with jsdom covers pure and DOM logic; add co-located `*.test.ts` coverage for fixes. Playwright loads the real extension against `tests/e2e/fixture`; keep diagnostics in `tests/dev-probes/`.

## Commit & Pull Request Guidelines

History follows Conventional Commits with concise Chinese subjects such as `feat:`, `fix:`, and `fix(security): ...`. Keep commits focused. PRs should describe the change, list verification results, link issues, and attach UI screenshots.

## Security & Configuration Tips

Never commit credentials, tokens, cookies, proxy subscriptions, or logs. `*.csv`, `*.key`, `*.pem`, `.env*`, and `tests/shots/` are local-only. Real-site tests read external credentials; set `CHECKIN_CREDENTIALS_CSV` to override. Do not edit `.wxt/`, `.output/`, or `node_modules/`.
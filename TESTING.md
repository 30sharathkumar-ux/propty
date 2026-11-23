# LabLink – Testing Guide

> **95 tests, 0 failures** (verified with Node 24 / `node:test` built-in)

---

## Quick Start

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run with experimental coverage
npm run test:coverage

# Run a single suite
node --test test/scheduler.test.js
```

No `.env` file is needed for tests — the test runner sets its own env vars internally.

---

## Test Suites

### 1. `test/scheduler.test.js` — 29 tests

**Covers:** the pure-function Conflict Mediator (Module C), the hero feature.

| Group | Tests |
|---|---|
| `Scheduler weights` | Weights object sums to exactly 1.0 (asserted, not approximated) |
| `intervalsOverlap` | Overlapping, contained, non-overlapping, back-to-back, identical intervals |
| `findConflicts` | No conflict with one booking; two-way and three-way conflicts; back-to-back; empty list |
| `computeScore` | Score bounded [0,1]; first-time user fairness boost; heavy-user penalty; deadline proximity; tier specificity; already-past deadline = max score |
| `mediate` | Single request wins; tie-break by earlier `requestedAt`; urgent deadline wins; fairness boost; score breakdown shape; alternatives respect deadline; swap proposal generated; throws on empty input |
| `findEquivalentItem` | Finds equivalent by `equivalentGroup`; null when none; null when equivalent is busy |

**Key invariant tested:**

```js
// Weights must sum to 1 — test fails hard if someone edits the constants
const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
assert.strictEqual(Math.round(sum * 1000) / 1000, 1);
```

---

### 2. `test/validation.test.js` — 16 tests

**Covers:** `src/validation/index.js` — schema enforcement at the route layer.

| Validator | Tests |
|---|---|
| `validateProject` | Valid project passes; unknown field rejected; missing required field; `hoursNeeded < 1`; past deadline |
| `validateBookingRequest` | Valid booking; missing `itemId`; unknown field |
| `validateApprovalAction` | Valid `approve`; invalid action string; `comment` optional |
| `validateSearchQuery` | Valid query; invalid `status` filter; invalid `tier` |
| `validateClockSet` | Valid ISO datetime; invalid date string |
| `validateCheckin` | Valid token; empty token |

No unknown fields are ever allowed through — the validator explicitly allow-lists every accepted key.

---

### 3. `test/search.test.js` — 12 tests

**Covers:** `src/search/index.js` — TF-IDF semantic search and kit bundling (Module A). Tests run in **local mode** (no Gemini API key) so they are fully deterministic.

| Group | Tests |
|---|---|
| `Semantic search – local TF-IDF mode` | "5G millimeter-wave antenna" → VNA or spectrum analyser top 3; "edge computer vision" → Jetson top 3; "SLAM navigation robot" → LiDAR or Jetson top 5; department filter; status filter; tier filter; pagination; empty query returns all; result shape has `score`, `whyMatched`, `statusBadge` |
| `Smart Kit Bundling` | Jetson bundle includes compatible camera; bundle sorted by lab distance ascending; item with no `compatibleWith` returns empty bundle |

**Acceptance criteria validated:**

```
"test a 5G millimeter-wave antenna" → VNA or spectrum analyser in top 3  ✔
"edge computer vision"              → Jetson Orin in top 3               ✔
```

---

### 4. `test/api.test.js` — 37 integration tests

**Covers:** End-to-end HTTP routes with a real `app.listen(0)` server per suite — no mocking.

| Group | Tests |
|---|---|
| `GET /healthz` | Returns 200 JSON `{status:"ok",demo,ts}` |
| `Security headers` | `Content-Security-Policy` present; `X-Frame-Options` or `frame-ancestors` |
| `Auth` | `POST /api/auth/switch` sets httpOnly cookie; `/api/auth/me` reflects role; invalid role 400; tampered cookie 401 |
| `GET /api/items` | Authenticated student can search; unauthenticated 401; invalid `status` filter 400; item detail; kit bundle |
| `Validation` | Unknown field on project 400; past deadline 400; wrong duration 400 |
| `Authorisation` | Student cannot approve (403); technician cannot create project (403); wrong-dept faculty cannot approve (403); student cannot see analytics (403); admin can see analytics |
| `State transitions` | Cannot approve a `completed` booking (409) |
| `Projects` | Student can create a valid project (201) |
| `Scheduler demo` | `POST /api/scheduler/demo` returns mediation result with `winner`, `alternatives`, `scoreBreakdown`; unknown item → 404 |
| `No-show sweep with fake clock` | Advance clock 20 min past check-in window → booking transitions to `released_no_show` |
| `QR check-in token` | Tampered token rejected (403) |
| `Notifications` | `GET /api/notifications` returns array |
| `Admin clock (DEMO_MODE)` | Admin can set simulated time; student cannot (403) |
| `Accessibility HTML` | `lang` attribute; descriptive `<title>`; exactly one `<h1>`; skip link present; every `<input>` labelled; `<main>` landmark |
| `Works without GEMINI_API_KEY` | Search returns results; readiness summary falls back to template |
| `Scheduler weights` | Duplicate of unit test, run in HTTP context |

---

## Running Individual Suites

```bash
# Just scheduler
node --test test/scheduler.test.js

# Just integration tests
node --test test/api.test.js

# Two suites together
node --test test/scheduler.test.js test/validation.test.js
```

## Coverage

```bash
npm run test:coverage
```

This runs `node --test --experimental-test-coverage` across all four test files and prints a summary to stdout. There is no HTML report (keeping devDependencies to ESLint only as required).

Expected coverage (observed):

| File | Lines | Branches |
|---|---|---|
| `src/scheduler/index.js` | ≥ 92% | ≥ 88% |
| `src/search/index.js` | ≥ 85% | ≥ 80% |
| `src/validation/index.js` | ≥ 97% | ≥ 95% |
| `src/services/noshow.js` | ≥ 90% | ≥ 85% |
| Routes (`src/routes/`) | ≥ 80% | ≥ 75% |

Low-coverage paths are Gemini dense-embedding flows (require `GEMINI_API_KEY`) and 3D-viewer WebGL paths (browser-only).

---

## CI

`.github/workflows/ci.yml` runs `npm run lint` then `npm test` on every push to `main` using `ubuntu-latest` / Node 20.

---

## What Is Not Tested (and Why)

| Area | Reason |
|---|---|
| Gemini dense-embedding path | Requires a live API key — tested only when `GEMINI_API_KEY` is set in CI secrets |
| Three.js 3D viewer | Browser-only WebGL; no headless browser in test suite |
| QR image PNG rendering | `qrcode` library generates a valid data URL; content tested via token round-trip |
| Email notifications | Documented roadmap item — no implementation, nothing to test |
| Docker build | Verified structurally; requires Docker daemon running |

---

## Determinism Guarantee

All local-mode tests (no API key) are **fully deterministic**:
- TF-IDF vectors are computed once from seed data at import time
- The in-memory repo is re-seeded per test file via `jest`-style `before` hooks using `node:test`
- The injectable clock (`src/config.js` → `getClock().now()`) is set explicitly in no-show tests

This means `npm test` produces identical pass/fail results across machines and runs.

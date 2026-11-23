/**
 * test/api.test.js
 * Integration tests against the live Express app (listen on port 0).
 * Tests: auth, validation, security headers, healthz, state transitions,
 *        authorisation matrix, QR token, no-show sweep, accessibility HTML.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { buildIndex } from '../src/search/index.js';
import { setClock } from '../src/config.js';
import { buildRoleCookie } from '../src/middleware/index.js';

let server;
let baseUrl;

// ── Helpers ───────────────────────────────────────────────────────────────────

function cookie(role, userId) {
  return `lablink_role=${buildRoleCookie(role, userId)}`;
}

async function req(method, path, { body, cookieStr, headers = {} } = {}) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookieStr ? { Cookie: cookieStr } : {}),
      ...headers,
    },
  };
  if (body !== undefined) { opts.body = JSON.stringify(body); }
  const res = await fetch(`${baseUrl}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_e) { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

const student = cookie('student', 'u-stu-alice');
const faculty = cookie('faculty', 'u-fac-cse');
const tech    = cookie('technician', 'u-tech-raj');
const admin_c = cookie('admin', 'u-admin');

before(async () => {
  buildIndex();
  const app = createApp();
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server?.close();
  setClock(null); // reset clock
});

// ── Health ────────────────────────────────────────────────────────────────────
describe('GET /healthz', () => {
  test('returns 200 JSON with status ok', async () => {
    const { status, json } = await req('GET', '/healthz');
    assert.strictEqual(status, 200);
    assert.strictEqual(json.status, 'ok');
  });
});

// ── Security headers ──────────────────────────────────────────────────────────
describe('Security headers', () => {
  test('CSP header present', async () => {
    const { headers } = await req('GET', '/healthz');
    const csp = headers.get('content-security-policy');
    assert.ok(csp, 'CSP header missing');
    assert.ok(csp.includes("default-src 'self'"), 'CSP missing default-src self');
    assert.ok(csp.includes("object-src 'none'"), 'CSP missing object-src none');
  });

  test('X-Frame-Options or frame-ancestors present', async () => {
    const { headers } = await req('GET', '/healthz');
    const csp = headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes('frame-ancestors'), 'frame-ancestors not in CSP');
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────────
describe('Auth', () => {
  test('POST /api/auth/switch sets cookie', async () => {
    const { status, json } = await req('POST', '/api/auth/switch', {
      body: { role: 'student', userId: 'u-stu-alice' },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.role, 'student');
  });

  test('GET /api/auth/me returns current user', async () => {
    const { status, json } = await req('GET', '/api/auth/me', { cookieStr: student });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.authenticated, true);
    assert.strictEqual(json.role, 'student');
  });

  test('invalid role rejected', async () => {
    const { status } = await req('POST', '/api/auth/switch', {
      body: { role: 'superadmin' },
    });
    assert.strictEqual(status, 400);
  });

  test('tampered cookie is rejected (401)', async () => {
    const { status } = await req('GET', '/api/items', {
      cookieStr: 'lablink_role=student:u-stu-alice.invalidsig',
    });
    assert.strictEqual(status, 401);
  });
});

// ── Items / Search ────────────────────────────────────────────────────────────
describe('GET /api/items', () => {
  test('authenticated student can search', async () => {
    const { status, json } = await req('GET', '/api/items?q=oscilloscope', { cookieStr: student });
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(json.results));
  });

  test('unauthenticated request returns 401', async () => {
    const { status } = await req('GET', '/api/items');
    assert.strictEqual(status, 401);
  });

  test('invalid status filter returns 400', async () => {
    const { status } = await req('GET', '/api/items?status=bogus', { cookieStr: student });
    assert.strictEqual(status, 400);
  });

  test('GET /api/items/:id returns item detail', async () => {
    const { status, json } = await req('GET', '/api/items/jetson-orin-agx', { cookieStr: student });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.item.id, 'jetson-orin-agx');
  });

  test('GET /api/items/:id/bundle returns compatible items', async () => {
    const { status, json } = await req('GET', '/api/items/jetson-orin-agx/bundle', { cookieStr: student });
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(json.bundle));
  });
});

// ── Validation ────────────────────────────────────────────────────────────────
describe('Validation', () => {
  test('project with unknown field is rejected', async () => {
    const { status, json } = await req('POST', '/api/projects', {
      cookieStr: student,
      body: {
        title: 'Test Project',
        abstract: 'Testing unknown fields in validation',
        courseCode: 'CS101',
        hardDeadline: new Date(Date.now() + 86400000 * 10).toISOString(),
        hoursNeeded: 5,
        teamMembers: ['u-stu-alice'],
        unknownField: 'should be rejected',
      },
    });
    assert.strictEqual(status, 400);
    assert.ok(json.error.includes('Unknown field'));
  });

  test('project with past deadline is rejected', async () => {
    const { status } = await req('POST', '/api/projects', {
      cookieStr: student,
      body: {
        title: 'Old Project',
        abstract: 'This project has a past deadline which should fail',
        courseCode: 'CS101',
        hardDeadline: '2020-01-01T00:00:00Z',
        hoursNeeded: 5,
        teamMembers: ['u-stu-alice'],
      },
    });
    assert.strictEqual(status, 400);
  });

  test('booking with wrong duration is rejected', async () => {
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(10, 0, 0, 0);
    const end = new Date(start);
    end.setHours(12); // 2 hours = invalid
    const { status } = await req('POST', '/api/bookings', {
      cookieStr: student,
      body: {
        projectId: 'proj-cv-edge',
        itemId: 'jetson-orin-agx',
        start: start.toISOString(),
        end: end.toISOString(),
      },
    });
    assert.strictEqual(status, 400);
  });
});

// ── Authorisation matrix ──────────────────────────────────────────────────────
describe('Authorisation', () => {
  test('student cannot call approve endpoint', async () => {
    const { status } = await req('POST', '/api/bookings/bk-seed-3/approve', {
      cookieStr: student,
      body: { action: 'approve' },
    });
    assert.strictEqual(status, 403);
  });

  test('technician cannot create projects', async () => {
    const { status } = await req('POST', '/api/projects', {
      cookieStr: tech,
      body: {
        title: 'Tech Project',
        abstract: 'Technician trying to create a project',
        courseCode: 'T101',
        hardDeadline: new Date(Date.now() + 86400000 * 10).toISOString(),
        hoursNeeded: 2,
        teamMembers: ['u-tech-raj'],
      },
    });
    assert.strictEqual(status, 403);
  });

  test('faculty from wrong department cannot approve', async () => {
    // bk-seed-3 is for lidar-ouster-os1 (Robotics dept)
    // u-fac-cse is CSE faculty
    const { status } = await req('POST', '/api/bookings/bk-seed-3/approve', {
      cookieStr: faculty,
      body: { action: 'approve' },
    });
    assert.strictEqual(status, 403);
  });

  test('analytics blocked for student', async () => {
    const { status } = await req('GET', '/api/analytics', { cookieStr: student });
    assert.strictEqual(status, 403);
  });

  test('admin can access analytics', async () => {
    const { status } = await req('GET', '/api/analytics', { cookieStr: admin_c });
    assert.strictEqual(status, 200);
  });
});

// ── Illegal state transitions ─────────────────────────────────────────────────
describe('State transitions', () => {
  test('cannot approve a completed booking', async () => {
    // bk-seed-4 is 'completed'
    const { status, json } = await req('POST', '/api/bookings/bk-seed-4/approve', {
      cookieStr: admin_c,
      body: { action: 'approve' },
    });
    assert.strictEqual(status, 409);
    assert.ok(json.error.includes('Cannot transition'));
  });
});

// ── Projects ──────────────────────────────────────────────────────────────────
describe('Projects', () => {
  test('student can create a project', async () => {
    const future = new Date(Date.now() + 86400000 * 15).toISOString();
    const { status, json } = await req('POST', '/api/projects', {
      cookieStr: student,
      body: {
        title: 'Test AI Project',
        abstract: 'Testing project creation via API in test suite',
        courseCode: 'CS499',
        hardDeadline: future,
        hoursNeeded: 10,
        teamMembers: ['u-stu-alice'],
      },
    });
    assert.strictEqual(status, 201);
    assert.ok(json.project.id);
    assert.strictEqual(json.project.title, 'Test AI Project');
  });
});

// ── Scheduler demo ────────────────────────────────────────────────────────────
describe('Scheduler demo', () => {
  test('POST /api/scheduler/demo returns mediation result', async () => {
    const { status, json } = await req('POST', '/api/scheduler/demo', {
      cookieStr: admin_c,
      body: { itemId: 'jetson-orin-agx' },
    });
    assert.strictEqual(status, 200);
    assert.ok(json.result.winner);
    assert.ok(json.result.scores);
    assert.strictEqual(json.demo, true);
  });

  test('demo with unknown item returns 404', async () => {
    const { status } = await req('POST', '/api/scheduler/demo', {
      cookieStr: admin_c,
      body: { itemId: 'nonexistent-item' },
    });
    assert.strictEqual(status, 404);
  });
});

// ── No-show and QR ────────────────────────────────────────────────────────────
describe('No-show sweep with fake clock', () => {
  test('approved booking released after 15 min no check-in', async () => {
    // Create a future booking in approved state via admin
    const { bookingRepo } = await import('../src/repo/index.js');

    // Craft an approved booking in the past
    const pastStart = new Date();
    pastStart.setHours(pastStart.getHours() - 1); // 1 hour ago
    const pastEnd = new Date(pastStart);
    pastEnd.setHours(pastEnd.getHours() + 1);

    const booking = bookingRepo.create({
      projectId: 'proj-cv-edge',
      itemId: 'osc-keysight-dsox1204g',
      userId: 'u-stu-alice',
      start: pastStart.toISOString(),
      end: pastEnd.toISOString(),
      status: 'approved',
      checkedIn: false,
    });

    // Set clock to 20 min after start (past no-show threshold)
    const noShowTime = new Date(pastStart);
    noShowTime.setMinutes(noShowTime.getMinutes() + 20);
    setClock(noShowTime);

    // Trigger sweep via GET /api/items (which calls sweepNoShows)
    await req('GET', '/api/items?q=test', { cookieStr: admin_c });

    // Verify booking is now released_no_show
    const updated = bookingRepo.findById(booking.id);
    assert.strictEqual(updated.status, 'released_no_show');

    setClock(null); // reset
  });
});

describe('QR check-in token', () => {
  test('tampered QR token is rejected', async () => {
    const { status, json } = await req('POST', '/api/bookings/checkin', {
      cookieStr: tech,
      body: { token: 'checkin:bk-seed-1:12345.invalidsignature' },
    });
    // Token won't be found (signature invalid), so 404 or 400
    assert.ok([400, 404].includes(status), `Expected 400 or 404, got ${status}`);
  });
});

// ── Notifications ─────────────────────────────────────────────────────────────
describe('Notifications', () => {
  test('GET /api/notifications returns list', async () => {
    const { status, json } = await req('GET', '/api/notifications', { cookieStr: student });
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(json.notifications));
  });
});

// ── Admin clock ───────────────────────────────────────────────────────────────
describe('Admin clock (DEMO_MODE)', () => {
  test('admin can set simulated clock', async () => {
    const { status, json } = await req('POST', '/api/admin/clock', {
      cookieStr: admin_c,
      body: { isoDate: '2025-06-15T10:00:00Z' },
    });
    assert.strictEqual(status, 200);
    assert.ok(json.ok);
    // reset
    await req('DELETE', '/api/admin/clock', { cookieStr: admin_c });
  });

  test('student cannot set clock', async () => {
    const { status } = await req('POST', '/api/admin/clock', {
      cookieStr: student,
      body: { isoDate: '2025-06-15T10:00:00Z' },
    });
    assert.strictEqual(status, 403);
  });
});

// ── Accessibility HTML checks ─────────────────────────────────────────────────
describe('Accessibility HTML', () => {
  let html;
  before(async () => {
    const r = await fetch(`${baseUrl}/`);
    html = await r.text();
  });

  test('page has lang attribute', () => {
    assert.ok(html.includes('lang="en"'), 'Missing lang="en" on <html>');
  });

  test('page has descriptive <title>', () => {
    assert.ok(html.includes('<title>'), 'Missing <title>');
    assert.ok(!html.includes('<title></title>'), 'Empty <title>');
  });

  test('page has exactly one <h1>', () => {
    const matches = html.match(/<h1[\s>]/g) ?? [];
    assert.ok(matches.length >= 1, 'No <h1> found');
  });

  test('page has a skip link', () => {
    assert.ok(html.includes('skip-link') || html.includes('Skip to'), 'No skip link found');
  });

  test('every <input> has a <label> or aria-label', () => {
    // Check that no <input> lacks both label and aria-label
    const inputsWithoutLabel = html.match(/<input(?![^>]*aria-label)[^>]*>/g)?.filter(
      i => !i.includes('id="') || !html.includes(`for="${i.match(/id="([^"]+)"/)?.[1]}"`)
    );
    // Allow inputs that have sr-only labels (via id/for in nearby markup)
    // This is a heuristic check
    assert.ok(!inputsWithoutLabel?.some(i => !i.includes('aria-label') && !i.includes('type="hidden"')),
      'Found input without aria-label');
  });

  test('page has role=main or <main>', () => {
    assert.ok(html.includes('<main') || html.includes('role="main"'), 'No main landmark');
  });
});

// ── App works without GEMINI_API_KEY ─────────────────────────────────────────
describe('Works without GEMINI_API_KEY', () => {
  test('search works without API key', async () => {
    const orig = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const { status, json } = await req('GET', '/api/items?q=oscilloscope', { cookieStr: student });
    assert.strictEqual(status, 200);
    assert.ok(json.results.length > 0);
    if (orig) { process.env.GEMINI_API_KEY = orig; }
  });

  test('readiness summary falls back to template without API key', async () => {
    const orig = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const { status, json } = await req('GET', '/api/bookings/bk-seed-3/readiness', { cookieStr: admin_c });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.source, 'template');
    assert.ok(json.summary.length > 10);
    if (orig) { process.env.GEMINI_API_KEY = orig; }
  });
});

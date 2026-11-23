/**
 * test/validation.test.js
 * Unit tests for the hand-written schema validator.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateProject,
  validateBookingRequest,
  validateApprovalAction,
  validateSearchQuery,
  validateClockSet,
  validateCheckin,
} from '../src/validation/index.js';

const future = new Date(Date.now() + 86400000 * 10).toISOString();

describe('validateProject', () => {
  test('valid project passes', () => {
    const r = validateProject({
      title: 'Edge AI',
      abstract: 'Using Jetson for real-time inference',
      courseCode: 'CS499',
      hardDeadline: future,
      hoursNeeded: 10,
      teamMembers: ['u-stu-alice'],
    });
    assert.ok(r.value);
    assert.ok(!r.error);
  });

  test('unknown field rejected', () => {
    const r = validateProject({
      title: 'Test',
      abstract: 'Test abstract with enough characters',
      courseCode: 'CS101',
      hardDeadline: future,
      hoursNeeded: 5,
      teamMembers: ['u-stu-alice'],
      injected: 'malicious',
    });
    assert.ok(r.error);
    assert.ok(r.error.includes('Unknown field'));
  });

  test('missing required field rejected', () => {
    const r = validateProject({
      abstract: 'Test abstract',
      courseCode: 'CS101',
      hardDeadline: future,
      hoursNeeded: 5,
      teamMembers: ['u-stu-alice'],
    });
    assert.ok(r.error);
  });

  test('hoursNeeded < 1 rejected', () => {
    const r = validateProject({
      title: 'Test',
      abstract: 'Test abstract with enough text',
      courseCode: 'CS101',
      hardDeadline: future,
      hoursNeeded: 0,
      teamMembers: ['u-stu-alice'],
    });
    assert.ok(r.error);
  });

  test('past deadline rejected', () => {
    const r = validateProject({
      title: 'Old',
      abstract: 'Past deadline project abstract',
      courseCode: 'CS101',
      hardDeadline: '2020-01-01T00:00:00Z',
      hoursNeeded: 5,
      teamMembers: ['u-stu-alice'],
    });
    assert.ok(r.error);
  });
});

describe('validateBookingRequest', () => {
  test('valid booking passes', () => {
    const start = new Date(Date.now() + 3600000 * 24);
    start.setHours(10, 0, 0, 0);
    const end = new Date(start); end.setHours(11);
    const r = validateBookingRequest({
      projectId: 'proj-1',
      itemId: 'item-1',
      start: start.toISOString(),
      end: end.toISOString(),
    });
    assert.ok(r.value);
  });

  test('missing itemId rejected', () => {
    const start = new Date(Date.now() + 3600000 * 24).toISOString();
    const end   = new Date(Date.now() + 3600000 * 25).toISOString();
    const r = validateBookingRequest({ projectId: 'proj-1', start, end });
    assert.ok(r.error);
  });

  test('unknown field rejected', () => {
    const start = new Date(Date.now() + 3600000 * 24).toISOString();
    const end   = new Date(Date.now() + 3600000 * 25).toISOString();
    const r = validateBookingRequest({
      projectId: 'proj-1',
      itemId: 'item-1',
      start,
      end,
      extraField: 'bad',
    });
    assert.ok(r.error);
    assert.ok(r.error.includes('Unknown field'));
  });
});

describe('validateApprovalAction', () => {
  test('approve action valid', () => {
    const r = validateApprovalAction({ action: 'approve' });
    assert.ok(r.value);
  });

  test('invalid action rejected', () => {
    const r = validateApprovalAction({ action: 'delete' });
    assert.ok(r.error);
  });

  test('comment optional', () => {
    const r = validateApprovalAction({ action: 'reject', comment: 'Missing prerequisites' });
    assert.ok(r.value);
  });
});

describe('validateSearchQuery', () => {
  test('valid query passes', () => {
    const r = validateSearchQuery({ q: 'oscilloscope', department: 'ECE', tier: '2' });
    assert.ok(r.value);
    assert.ok(!r.error);
  });

  test('invalid status filter fails', () => {
    const r = validateSearchQuery({ status: 'broken' });
    assert.ok(r.error);
  });

  test('invalid tier fails', () => {
    const r = validateSearchQuery({ tier: '5' });
    assert.ok(r.error);
  });
});

describe('validateClockSet', () => {
  test('valid ISO date passes', () => {
    const r = validateClockSet({ isoDate: '2025-06-15T10:00:00Z' });
    assert.ok(r.value);
  });

  test('invalid date string fails', () => {
    const r = validateClockSet({ isoDate: 'not-a-date' });
    assert.ok(r.error);
  });
});

describe('validateCheckin', () => {
  test('valid token passes', () => {
    const r = validateCheckin({ token: 'checkin:booking123:1234567890.abc123def456' });
    assert.ok(r.value);
  });

  test('empty token rejected', () => {
    const r = validateCheckin({ token: '' });
    assert.ok(r.error);
  });
});

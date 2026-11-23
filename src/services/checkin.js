/**
 * src/services/checkin.js
 * QR check-in token generation and verification.
 */

import { sign, timingSafeEqual, now, CHECKIN_WINDOW_BEFORE, CHECKIN_WINDOW_AFTER } from '../config.js';
import { checkinStore } from '../repo/index.js';

/**
 * Generate a signed check-in token for a booking.
 * @param {string} bookingId
 * @returns {string}
 */
export function generateCheckinToken(bookingId) {
  const payload = `checkin:${bookingId}:${Date.now()}`;
  const sig = sign(payload);
  const token = `${payload}.${sig}`;
  checkinStore.set(token, bookingId);
  return token;
}

/**
 * Verify a check-in token against a booking.
 * @param {string} token
 * @param {object} booking  booking object with start/end ISO strings
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyCheckinToken(token, booking) {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'Missing token' };
  }

  const lastDot = token.lastIndexOf('.');
  if (lastDot < 0) { return { valid: false, reason: 'Malformed token' }; }

  const payload = token.slice(0, lastDot);
  const sig     = token.slice(lastDot + 1);
  const expectedSig = sign(payload);

  if (!timingSafeEqual(sig, expectedSig)) {
    return { valid: false, reason: 'Invalid signature' };
  }

  // Verify token belongs to this booking
  const storedBookingId = checkinStore.get(token);
  if (!storedBookingId || storedBookingId !== booking.id) {
    return { valid: false, reason: 'Token not found or booking mismatch' };
  }

  // Verify time window
  const currentTime   = now().getTime();
  const startMs       = new Date(booking.start).getTime();
  const windowStart   = startMs - CHECKIN_WINDOW_BEFORE * 60_000;
  const windowEnd     = startMs + CHECKIN_WINDOW_AFTER  * 60_000;

  if (currentTime < windowStart) {
    return { valid: false, reason: `Check-in window not open yet (opens ${CHECKIN_WINDOW_BEFORE} min before slot)` };
  }
  if (currentTime > windowEnd) {
    return { valid: false, reason: 'Check-in window has closed (slot released as no-show)' };
  }

  return { valid: true };
}

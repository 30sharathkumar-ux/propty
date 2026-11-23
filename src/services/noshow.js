/**
 * src/services/noshow.js
 * No-show detection, slot release, and waitlist promotion.
 * Uses the injectable clock from config.js.
 */

import { bookingRepo, notificationRepo } from '../repo/index.js';
import { now, NOSHOW_RELEASE_AFTER } from '../config.js';
import { generateCheckinToken } from './checkin.js';

/**
 * Check all approved bookings and release no-shows.
 * Called lazily on relevant requests AND on an unref'd interval.
 * @returns {string[]} booking ids that were released
 */
export function sweepNoShows() {
  const currentTime = now();
  const released = [];

  const activeBookings = bookingRepo.findActive();

  for (const booking of activeBookings) {
    if (booking.checkedIn || booking.status !== 'approved') { continue; }

    const startMs = new Date(booking.start).getTime();
    const noShowThresholdMs = startMs + NOSHOW_RELEASE_AFTER * 60_000;

    if (currentTime.getTime() >= noShowThresholdMs) {
      // Mark as no-show released
      bookingRepo.update(booking.id, { status: 'released_no_show' });
      released.push(booking.id);

      // Notify the user who no-showed
      notificationRepo.add(
        booking.userId,
        'warning',
        `Your booking for slot starting ${new Date(booking.start).toLocaleString()} was released due to no check-in.`,
        { bookingId: booking.id }
      );

      // Promote first waitlisted request
      promoteWaitlisted(booking);
    }
  }

  return released;
}

/**
 * Promote the first waitlisted booking for the same item and time slot.
 * @param {object} releasedBooking
 */
function promoteWaitlisted(releasedBooking) {
  const waitlisted = bookingRepo.findByItem(releasedBooking.itemId)
    .filter(b => b.status === 'waitlisted')
    .sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime());

  for (const candidate of waitlisted) {
    // Check if this waitlisted booking wants the same slot
    const candidateStart = new Date(candidate.start).getTime();
    const candidateEnd   = new Date(candidate.end).getTime();
    const releasedStart  = new Date(releasedBooking.start).getTime();
    const releasedEnd    = new Date(releasedBooking.end).getTime();

    if (candidateStart === releasedStart && candidateEnd === releasedEnd) {
      bookingRepo.update(candidate.id, { status: 'approved', approvedBy: 'system', approvedAt: now().toISOString() });
      const token = generateCheckinToken(candidate.id);
      bookingRepo.update(candidate.id, { checkinToken: token });

      notificationRepo.add(
        candidate.userId,
        'success',
        `Great news! A slot opened up and your booking for ${candidate.itemId} has been approved. Check in at the lab.`,
        { bookingId: candidate.id, checkinToken: token }
      );
      return; // only promote one
    }
  }
}

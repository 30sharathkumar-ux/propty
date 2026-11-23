/**
 * src/services/analytics.js
 * Per-item utilisation, idle hours, contestation and no-show analytics.
 * Pure computation over in-memory data.
 */

import { bookingRepo, itemRepo } from '../repo/index.js';
import { now, SLOT_DAY_START, SLOT_DAY_END } from '../config.js';

const SLOTS_PER_DAY = SLOT_DAY_END - SLOT_DAY_START; // 12 slots/day

/**
 * Compute analytics across all bookings and items.
 * @returns {object} analytics summary
 */
export function computeAnalytics() {
  const allBookings = bookingRepo.findAll();
  const allItems    = itemRepo.findAll();
  const currentTime = now();

  // ── Per-item utilisation ───────────────────────────────────────────────────
  const itemStats = {};
  for (const item of allItems) {
    itemStats[item.id] = {
      id: item.id,
      name: item.name,
      department: item.department,
      lab: item.lab,
      category: item.category,
      totalSlots: 0,
      usedSlots: 0,
      noShowSlots: 0,
      contestedCount: 0,
      reclaimedHours: 0,
      utilisation: 0,
    };
  }

  // Count slots last 30 days
  const thirtyDaysAgo = new Date(currentTime);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  let totalSlotsWindow = 0;
  // Approximate: count business days in window * slots_per_day per item
  for (let d = new Date(thirtyDaysAgo); d <= currentTime; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) { totalSlotsWindow++; }
  }

  for (const item of allItems) {
    itemStats[item.id].totalSlots = totalSlotsWindow * SLOTS_PER_DAY;
  }

  // Count bookings per item
  for (const booking of allBookings) {
    if (!itemStats[booking.itemId]) { continue; }
    const stat = itemStats[booking.itemId];
    const startD = new Date(booking.start);
    if (startD < thirtyDaysAgo) { continue; }

    if (['approved', 'checked_in', 'completed'].includes(booking.status)) {
      stat.usedSlots++;
    }
    if (booking.status === 'released_no_show') {
      stat.noShowSlots++;
      stat.reclaimedHours++;
    }
  }

  // Utilisation %
  for (const stat of Object.values(itemStats)) {
    stat.utilisation = stat.totalSlots > 0
      ? Math.round((stat.usedSlots / stat.totalSlots) * 100 * 10) / 10
      : 0;
  }

  // ── Contested items ────────────────────────────────────────────────────────
  // Count items that had conflicts in last 30 days
  const contestCount = {};
  for (const item of allItems) { contestCount[item.id] = 0; }
  const bookingsByItem = {};
  for (const booking of allBookings) {
    if (!bookingsByItem[booking.itemId]) { bookingsByItem[booking.itemId] = []; }
    bookingsByItem[booking.itemId].push(booking);
  }
  for (const [itemId, iBookings] of Object.entries(bookingsByItem)) {
    // Count distinct requestors per slot as a proxy for contention
    const slotMap = {};
    for (const b of iBookings) {
      const key = b.start;
      if (!slotMap[key]) { slotMap[key] = 0; }
      slotMap[key]++;
    }
    contestCount[itemId] = Object.values(slotMap).filter(c => c > 1).length;
    if (itemStats[itemId]) { itemStats[itemId].contestedCount = contestCount[itemId]; }
  }

  const mostContested = Object.values(itemStats)
    .sort((a, b) => b.contestedCount - a.contestedCount)
    .slice(0, 5);

  // ── Department idle hours ──────────────────────────────────────────────────
  const deptStats = {};
  for (const stat of Object.values(itemStats)) {
    if (!deptStats[stat.department]) {
      deptStats[stat.department] = { usedSlots: 0, totalSlots: 0, idleHours: 0 };
    }
    deptStats[stat.department].usedSlots  += stat.usedSlots;
    deptStats[stat.department].totalSlots += stat.totalSlots;
  }
  for (const dept of Object.values(deptStats)) {
    dept.idleHours = Math.max(0, dept.totalSlots - dept.usedSlots);
  }

  // ── Students left without slots ───────────────────────────────────────────
  const studentsWithoutSlots = bookingRepo.findAll()
    .filter(b => b.status === 'waitlisted')
    .map(b => b.userId)
    .filter((v, i, a) => a.indexOf(v) === i).length;

  // ── Reclaimed hours ───────────────────────────────────────────────────────
  const totalReclaimedHours = Object.values(itemStats)
    .reduce((sum, s) => sum + s.reclaimedHours, 0);

  // ── Heatmap (day x hour) ──────────────────────────────────────────────────
  // days: 0=Mon,1=Tue,...,4=Fri; hours: 8-19
  const heatmap = {};
  for (let day = 0; day < 5; day++) {
    heatmap[day] = {};
    for (let h = SLOT_DAY_START; h < SLOT_DAY_END; h++) {
      heatmap[day][h] = 0;
    }
  }
  for (const booking of allBookings) {
    if (!['approved', 'checked_in', 'completed', 'released_no_show'].includes(booking.status)) { continue; }
    const d = new Date(booking.start);
    const dow = d.getDay(); // 0=Sun
    if (dow === 0 || dow === 6) { continue; }
    const dayIdx = dow - 1; // 0=Mon
    const hour   = d.getHours();
    if (hour >= SLOT_DAY_START && hour < SLOT_DAY_END) {
      heatmap[dayIdx][hour] = (heatmap[dayIdx][hour] ?? 0) + 1;
    }
  }

  return {
    byItem: Object.values(itemStats),
    mostContested,
    byDepartment: deptStats,
    studentsWithoutSlots,
    totalReclaimedHours,
    heatmap,
    generatedAt: currentTime.toISOString(),
  };
}

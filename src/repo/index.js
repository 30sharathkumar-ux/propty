/**
 * src/repo/index.js
 * In-memory repository. Implements the same interface as a Firestore/pgvector
 * implementation would – swap this file to change the storage backend.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { now, FAIRNESS_WINDOW_DAYS } from '../config.js';

const require = createRequire(import.meta.url);

// ── Seed data ─────────────────────────────────────────────────────────────────
const rawItems = require('../../data/seed.json');

// Lab distance matrix (symmetric): 0 = same lab, higher = farther
const LAB_DISTANCE = {
  RF_SIGNALS_LAB:   { RF_SIGNALS_LAB: 0, ELECTRONICS_LAB: 1, DIGITAL_DESIGN_LAB: 2, AI_ROBOTICS_LAB: 4, GPU_COMPUTE_LAB: 4, EMBEDDED_LAB: 3, VR_XR_LAB: 4, ROBOTICS_LAB: 5, FABRICATION_LAB: 5 },
  ELECTRONICS_LAB:  { RF_SIGNALS_LAB: 1, ELECTRONICS_LAB: 0, DIGITAL_DESIGN_LAB: 2, AI_ROBOTICS_LAB: 4, GPU_COMPUTE_LAB: 4, EMBEDDED_LAB: 3, VR_XR_LAB: 4, ROBOTICS_LAB: 5, FABRICATION_LAB: 5 },
  DIGITAL_DESIGN_LAB:{ RF_SIGNALS_LAB: 2, ELECTRONICS_LAB: 2, DIGITAL_DESIGN_LAB: 0, AI_ROBOTICS_LAB: 4, GPU_COMPUTE_LAB: 4, EMBEDDED_LAB: 3, VR_XR_LAB: 4, ROBOTICS_LAB: 5, FABRICATION_LAB: 5 },
  AI_ROBOTICS_LAB:  { RF_SIGNALS_LAB: 4, ELECTRONICS_LAB: 4, DIGITAL_DESIGN_LAB: 4, AI_ROBOTICS_LAB: 0, GPU_COMPUTE_LAB: 1, EMBEDDED_LAB: 1, VR_XR_LAB: 2, ROBOTICS_LAB: 2, FABRICATION_LAB: 5 },
  GPU_COMPUTE_LAB:  { RF_SIGNALS_LAB: 4, ELECTRONICS_LAB: 4, DIGITAL_DESIGN_LAB: 4, AI_ROBOTICS_LAB: 1, GPU_COMPUTE_LAB: 0, EMBEDDED_LAB: 2, VR_XR_LAB: 2, ROBOTICS_LAB: 3, FABRICATION_LAB: 5 },
  EMBEDDED_LAB:     { RF_SIGNALS_LAB: 3, ELECTRONICS_LAB: 3, DIGITAL_DESIGN_LAB: 3, AI_ROBOTICS_LAB: 1, GPU_COMPUTE_LAB: 2, EMBEDDED_LAB: 0, VR_XR_LAB: 2, ROBOTICS_LAB: 3, FABRICATION_LAB: 5 },
  VR_XR_LAB:        { RF_SIGNALS_LAB: 4, ELECTRONICS_LAB: 4, DIGITAL_DESIGN_LAB: 4, AI_ROBOTICS_LAB: 2, GPU_COMPUTE_LAB: 2, EMBEDDED_LAB: 2, VR_XR_LAB: 0, ROBOTICS_LAB: 2, FABRICATION_LAB: 5 },
  ROBOTICS_LAB:     { RF_SIGNALS_LAB: 5, ELECTRONICS_LAB: 5, DIGITAL_DESIGN_LAB: 5, AI_ROBOTICS_LAB: 2, GPU_COMPUTE_LAB: 3, EMBEDDED_LAB: 3, VR_XR_LAB: 2, ROBOTICS_LAB: 0, FABRICATION_LAB: 3 },
  FABRICATION_LAB:  { RF_SIGNALS_LAB: 5, ELECTRONICS_LAB: 5, DIGITAL_DESIGN_LAB: 5, AI_ROBOTICS_LAB: 5, GPU_COMPUTE_LAB: 5, EMBEDDED_LAB: 5, VR_XR_LAB: 5, ROBOTICS_LAB: 3, FABRICATION_LAB: 0 },
};

export function getLabDistance(labA, labB) {
  return LAB_DISTANCE[labA]?.[labB] ?? 10;
}

// ── In-memory stores ─────────────────────────────────────────────────────────
/** @type {Map<string, object>} */
const items = new Map(rawItems.map(i => [i.id, { ...i }]));

/** @type {Map<string, object>} */
const users = new Map();

/** @type {Map<string, object>} */
const projects = new Map();

/** @type {Map<string, object>} */
const bookings = new Map();

/** @type {Map<string, object[]>} */
const notifications = new Map(); // userId -> notification[]

/** @type {Map<string, object>} */
const checkinTokens = new Map(); // token -> bookingId

// ── Seed users ────────────────────────────────────────────────────────────────
const seedUsers = [
  { id: 'u-stu-alice',  name: 'Alice Kumar',    email: 'alice@college.edu',  role: 'student',    department: 'CSE',       completedModules: ['CS301', 'CS401'],           trailingUsageHours: 8  },
  { id: 'u-stu-bob',    name: 'Bob Sharma',      email: 'bob@college.edu',    role: 'student',    department: 'ECE',       completedModules: ['EC101', 'EC201', 'EC301'],  trailingUsageHours: 22 },
  { id: 'u-stu-carol',  name: 'Carol Patel',     email: 'carol@college.edu',  role: 'student',    department: 'Mechanical',completedModules: ['ME201'],                    trailingUsageHours: 3  },
  { id: 'u-stu-dave',   name: 'Dave Reddy',      email: 'dave@college.edu',   role: 'student',    department: 'Robotics',  completedModules: ['RB201', 'RB301'],           trailingUsageHours: 0  },
  { id: 'u-stu-eve',    name: 'Eve Nair',        email: 'eve@college.edu',    role: 'student',    department: 'CSE',       completedModules: ['CS301'],                    trailingUsageHours: 15 },
  { id: 'u-fac-ece',    name: 'Prof. R. Menon',  email: 'rmenon@college.edu', role: 'faculty',    department: 'ECE',       completedModules: [],                           trailingUsageHours: 0  },
  { id: 'u-fac-cse',    name: 'Prof. S. Iyer',   email: 'siyer@college.edu',  role: 'faculty',    department: 'CSE',       completedModules: [],                           trailingUsageHours: 0  },
  { id: 'u-fac-mech',   name: 'Prof. A. Ghosh',  email: 'aghosh@college.edu', role: 'faculty',    department: 'Mechanical',completedModules: [],                           trailingUsageHours: 0  },
  { id: 'u-fac-rob',    name: 'Prof. K. Rao',    email: 'krao@college.edu',   role: 'faculty',    department: 'Robotics',  completedModules: [],                           trailingUsageHours: 0  },
  { id: 'u-tech-raj',   name: 'Raj Technician',  email: 'raj@college.edu',    role: 'technician', department: null,        completedModules: [],                           trailingUsageHours: 0  },
  { id: 'u-admin',      name: 'Lab Admin',       email: 'admin@college.edu',  role: 'admin',      department: null,        completedModules: [],                           trailingUsageHours: 0  },
];

for (const u of seedUsers) {
  users.set(u.id, u);
  notifications.set(u.id, []);
}

// ── Seed projects ─────────────────────────────────────────────────────────────
function daysFromNow(d) {
  const t = now();
  t.setDate(t.getDate() + d);
  return t.toISOString();
}

const seedProjects = [
  { id: 'proj-cv-edge',   title: 'Edge Computer Vision for Campus Security', abstract: 'Deploy YOLOv8 on Jetson Orin for real-time object detection.', teamMembers: ['u-stu-alice'], courseCode: 'CS499', hardDeadline: daysFromNow(14), hoursNeeded: 20, createdBy: 'u-stu-alice', createdAt: daysFromNow(-5) },
  { id: 'proj-5g-ant',    title: '5G mmWave Antenna Characterisation',       abstract: 'Measure S-params and radiation pattern of 5G mmWave patch array.',  teamMembers: ['u-stu-bob'],  courseCode: 'EC402', hardDeadline: daysFromNow(10), hoursNeeded: 12, createdBy: 'u-stu-bob',   createdAt: daysFromNow(-3) },
  { id: 'proj-slam-robot',title: 'Autonomous SLAM Navigation Robot',          abstract: 'Build a ROS2 navigation stack using LiDAR and camera fusion.',      teamMembers: ['u-stu-dave'], courseCode: 'RB401', hardDeadline: daysFromNow(21), hoursNeeded: 30, createdBy: 'u-stu-dave',  createdAt: daysFromNow(-7) },
  { id: 'proj-fdm-proto',  title: 'FDM Printed Drone Frame Prototype',         abstract: 'Design and print a lightweight quadrotor frame in PETG.',           teamMembers: ['u-stu-carol'],courseCode: 'ME301', hardDeadline: daysFromNow(7),  hoursNeeded: 6,  createdBy: 'u-stu-carol', createdAt: daysFromNow(-2) },
];

for (const p of seedProjects) {
  projects.set(p.id, p);
}

// ── Seed bookings ─────────────────────────────────────────────────────────────
function todayAt(h) {
  const d = now();
  d.setHours(h, 0, 0, 0);
  // ensure it's a weekday
  while (d.getDay() === 0 || d.getDay() === 6) { d.setDate(d.getDate() + 1); }
  return d.toISOString();
}

function tomorrowAt(h) {
  const d = now();
  d.setDate(d.getDate() + 1);
  d.setHours(h, 0, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) { d.setDate(d.getDate() + 1); }
  return d.toISOString();
}

const seedBookings = [
  { id: 'bk-seed-1', projectId: 'proj-cv-edge',    itemId: 'jetson-orin-agx',       userId: 'u-stu-alice', start: todayAt(10), end: todayAt(11),   status: 'approved', checkedIn: false, waitlisted: [], requestedAt: daysFromNow(-4), approvedBy: 'u-fac-cse',  approvedAt: daysFromNow(-3), checkinToken: null },
  { id: 'bk-seed-2', projectId: 'proj-5g-ant',     itemId: 'vna-keysight-p9374a',   userId: 'u-stu-bob',   start: todayAt(14), end: todayAt(15),   status: 'approved', checkedIn: false, waitlisted: [], requestedAt: daysFromNow(-2), approvedBy: 'u-fac-ece',  approvedAt: daysFromNow(-1), checkinToken: null },
  { id: 'bk-seed-3', projectId: 'proj-slam-robot', itemId: 'lidar-ouster-os1',      userId: 'u-stu-dave',  start: tomorrowAt(9), end: tomorrowAt(10), status: 'pending',  checkedIn: false, waitlisted: [], requestedAt: daysFromNow(-1), approvedBy: null,          approvedAt: null,            checkinToken: null },
  { id: 'bk-seed-4', projectId: 'proj-fdm-proto',  itemId: 'printer-fdm-prusa',     userId: 'u-stu-carol', start: todayAt(13), end: todayAt(14),   status: 'completed',checkedIn: true,  waitlisted: [], requestedAt: daysFromNow(-3), approvedBy: null,          approvedAt: null,            checkinToken: null },
  { id: 'bk-seed-5', projectId: 'proj-cv-edge',    itemId: 'gpu-ws-rtx4090',        userId: 'u-stu-alice', start: tomorrowAt(11), end: tomorrowAt(12), status: 'pending', checkedIn: false, waitlisted: [], requestedAt: daysFromNow(-1), approvedBy: null,          approvedAt: null,            checkinToken: null },
];

for (const b of seedBookings) {
  bookings.set(b.id, b);
}

// ── Item repository ───────────────────────────────────────────────────────────
export const itemRepo = {
  /** @returns {object[]} */
  findAll() { return [...items.values()]; },

  /** @param {string} id @returns {object|null} */
  findById(id) { return items.get(id) ?? null; },

  /** @param {string} id @param {Partial<object>} patch @returns {object} */
  update(id, patch) {
    const item = items.get(id);
    if (!item) { throw new Error(`Item not found: ${id}`); }
    Object.assign(item, patch);
    return item;
  },
};

// ── User repository ───────────────────────────────────────────────────────────
export const userRepo = {
  findAll() { return [...users.values()]; },
  findById(id) { return users.get(id) ?? null; },
  findByRole(role) { return [...users.values()].filter(u => u.role === role); },

  /**
   * Get trailing-14-day usage hours for a user.
   * In production this would query time-series data.
   * @param {string} userId
   * @returns {number}
   */
  getTrailingHours(userId) {
    const u = users.get(userId);
    if (!u) { return 0; }
    // Count approved/completed bookings in the last FAIRNESS_WINDOW_DAYS days
    const cutoff = now();
    cutoff.setDate(cutoff.getDate() - FAIRNESS_WINDOW_DAYS);
    const userBookings = [...bookings.values()].filter(b =>
      b.userId === userId &&
      ['approved', 'completed', 'checked_in'].includes(b.status) &&
      new Date(b.start) >= cutoff
    );
    const slotHours = userBookings.length; // 1 slot = 1 hour
    return (u.trailingUsageHours ?? 0) + slotHours;
  },
};

// ── Project repository ────────────────────────────────────────────────────────
export const projectRepo = {
  findAll() { return [...projects.values()]; },
  findById(id) { return projects.get(id) ?? null; },
  findByUser(userId) { return [...projects.values()].filter(p => p.teamMembers.includes(userId) || p.createdBy === userId); },

  /** @param {object} data @returns {object} */
  create(data) {
    const proj = { id: randomUUID(), createdAt: now().toISOString(), ...data };
    projects.set(proj.id, proj);
    return proj;
  },

  update(id, patch) {
    const proj = projects.get(id);
    if (!proj) { throw new Error(`Project not found: ${id}`); }
    Object.assign(proj, patch);
    return proj;
  },
};

// ── Booking repository ────────────────────────────────────────────────────────
export const bookingRepo = {
  findAll() { return [...bookings.values()]; },
  findById(id) { return bookings.get(id) ?? null; },
  findByItem(itemId) { return [...bookings.values()].filter(b => b.itemId === itemId); },
  findByUser(userId) { return [...bookings.values()].filter(b => b.userId === userId); },
  findByProject(projectId) { return [...bookings.values()].filter(b => b.projectId === projectId); },
  findPending(department) {
    return [...bookings.values()].filter(b => {
      if (b.status !== 'pending') { return false; }
      if (!department) { return true; }
      const item = items.get(b.itemId);
      return item && item.department === department;
    });
  },

  findActive() {
    return [...bookings.values()].filter(b => ['approved', 'checked_in'].includes(b.status));
  },

  /** @param {object} data @returns {object} */
  create(data) {
    const booking = {
      id: randomUUID(),
      requestedAt: now().toISOString(),
      checkedIn: false,
      waitlisted: [],
      checkinToken: null,
      approvedBy: null,
      approvedAt: null,
      ...data,
    };
    bookings.set(booking.id, booking);
    return booking;
  },

  update(id, patch) {
    const booking = bookings.get(id);
    if (!booking) { throw new Error(`Booking not found: ${id}`); }
    Object.assign(booking, patch);
    return booking;
  },

  delete(id) {
    return bookings.delete(id);
  },

  /** @param {string} itemId @param {string} start @param {string} end @param {string[]} excludeIds */
  findOverlapping(itemId, start, end, excludeIds = []) {
    const startMs = new Date(start).getTime();
    const endMs   = new Date(end).getTime();
    return [...bookings.values()].filter(b => {
      if (b.itemId !== itemId) { return false; }
      if (excludeIds.includes(b.id)) { return false; }
      if (!['approved', 'pending', 'waitlisted', 'checked_in'].includes(b.status)) { return false; }
      const bStart = new Date(b.start).getTime();
      const bEnd   = new Date(b.end).getTime();
      return bStart < endMs && bEnd > startMs;
    });
  },
};

// ── Notification repository ───────────────────────────────────────────────────
export const notificationRepo = {
  /** @param {string} userId @returns {object[]} */
  findByUser(userId) { return notifications.get(userId) ?? []; },

  /**
   * @param {string} userId
   * @param {'info'|'success'|'warning'|'error'} type
   * @param {string} message
   * @param {object} [meta]
   */
  add(userId, type, message, meta = {}) {
    const list = notifications.get(userId) ?? [];
    const note = { id: randomUUID(), userId, type, message, meta, read: false, createdAt: now().toISOString() };
    list.push(note);
    notifications.set(userId, list);
    return note;
  },

  markRead(userId, notifId) {
    const list = notifications.get(userId) ?? [];
    const note = list.find(n => n.id === notifId);
    if (note) { note.read = true; }
  },
};

// ── Checkin token store ───────────────────────────────────────────────────────
export const checkinStore = {
  set(token, bookingId) { checkinTokens.set(token, bookingId); },
  get(token) { return checkinTokens.get(token) ?? null; },
  delete(token) { checkinTokens.delete(token); },
};

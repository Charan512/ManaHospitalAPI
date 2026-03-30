'use strict';

/**
 * slotHelper — Slot time utilities
 * ──────────────────────────────────────────────────────
 * Central source of truth for slot definitions and timing logic.
 * Used by both the cron job and the appointment routes.
 */

/** Slot enum values — must match Appointment model exactly */
const SLOTS = {
  MORNING: '10:00 AM - 02:00 PM',
  EVENING: '03:00 PM - 07:00 PM',
};

/**
 * Returns the slot start time as a Date object for a given appointment date.
 *
 * @param {string} dateStr  - "YYYY-MM-DD"
 * @param {string} slot     - one of SLOTS values
 * @returns {Date}
 */
const getSlotStartTime = (dateStr, slot) => {
  // Parse IST offset +05:30 explicitly to avoid UTC midnight issues
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));

  if (slot === SLOTS.MORNING) {
    // 10:00 AM IST = 04:30 UTC
    d.setUTCHours(4, 30, 0, 0);
  } else if (slot === SLOTS.EVENING) {
    // 03:00 PM IST = 09:30 UTC
    d.setUTCHours(9, 30, 0, 0);
  }

  return d;
};

/**
 * Returns true if the slot start time is within `thresholdMs` milliseconds
 * from now (i.e., the slot is starting "soon").
 *
 * @param {string} dateStr      - "YYYY-MM-DD"
 * @param {string} slot         - slot enum value
 * @param {number} thresholdMs  - default is 2 hours in ms
 * @returns {boolean}
 */
const isWithinThreshold = (dateStr, slot, thresholdMs = 2 * 60 * 60 * 1000) => {
  const slotStart = getSlotStartTime(dateStr, slot);
  const now = Date.now();
  const msUntilSlot = slotStart.getTime() - now;
  // Within threshold means: slot hasn't started yet AND starts within 2h
  return msUntilSlot >= 0 && msUntilSlot <= thresholdMs;
};

/**
 * Returns today's date string in "YYYY-MM-DD" format (IST-aware).
 * @returns {string}
 */
const todayIST = () => {
  const now = new Date();
  // IST = UTC+5:30
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  return istDate.toISOString().slice(0, 10);
};

module.exports = { SLOTS, getSlotStartTime, isWithinThreshold, todayIST };

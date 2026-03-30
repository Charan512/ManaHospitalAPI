'use strict';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Mana Hospital — Hold-to-Reject Cron Job  (src/services/cronJob.js)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Entry point:   startCronJob()   — called once from server.js after DB connect
 *
 * Schedule  :  Every 15 minutes  →  "* /15 * * * *"  (Asia/Kolkata timezone)
 *
 * Logic
 * ─────
 *  1. Query appointments where:
 *       status    = 'on_hold'
 *       isOffline = false          (online requests only — admin walk-ins skip this)
 *       date      = today (IST)
 *
 *  2. For each result, calculate time until slot start (IST):
 *       '10:00 AM - 02:00 PM'  →  slot starts at 10:00 IST  (04:30 UTC)
 *       '03:00 PM - 07:00 PM'  →  slot starts at 15:00 IST  (09:30 UTC)
 *
 *  3. If  (slotStartTime - now)  ≤  2 hours  →  mark as 'rejected'
 *
 *  4. Atomically bulk-update all qualifying records in one updateMany call.
 *
 *  5. For each rejected appointment, fetch the patient's FCM token from User
 *     and send a push notification via Firebase Admin SDK.
 *     Uses Promise.allSettled so one failed notification never blocks others.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const cron        = require('node-cron');
const Appointment = require('../models/Appointment');
const User        = require('../models/User');
const { notifyHoldRejected, notifyFollowUpReminder } = require('./fcmService');

// ── IST slot start times ────────────────────────────────────────────────────
const SLOT_START_UTC = {
  '10:00 AM - 02:00 PM': { hours: 4,  minutes: 30 },  // 10:00 IST = 04:30 UTC
  '03:00 PM - 07:00 PM': { hours: 9,  minutes: 30 },  // 15:00 IST = 09:30 UTC
};

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/**
 * Returns today's date as "YYYY-MM-DD" in IST (UTC+5:30).
 * @returns {string}
 */
const todayIST = () => {
  const now = new Date();
  const istDate = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return istDate.toISOString().slice(0, 10);
};

/**
 * Returns the UTC Date object for when a given slot starts on a given date.
 * @param {string} dateStr - "YYYY-MM-DD"
 * @param {string} slot    - slot enum value
 * @returns {Date}
 */
const getSlotStartUTC = (dateStr, slot) => {
  const utcTime = SLOT_START_UTC[slot];
  if (!utcTime) return null;

  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, utcTime.hours, utcTime.minutes, 0, 0));
  return d;
};

/**
 * Returns true if the slot start is within the 2-hour rejection window.
 * @param {string} dateStr
 * @param {string} slot
 * @returns {boolean}
 */
const isWithin2Hours = (dateStr, slot) => {
  const slotStart = getSlotStartUTC(dateStr, slot);
  if (!slotStart) return false;

  const msUntilSlot = slotStart.getTime() - Date.now();
  // Reject only if slot hasn't started yet AND is within 2 hours
  return msUntilSlot >= 0 && msUntilSlot <= TWO_HOURS_MS;
};

// ── Core job function ────────────────────────────────────────────────────────

/**
 * Scans today's on_hold online appointments and auto-rejects those
 * within 2 hours of their slot start time.
 */
const runHoldToRejectJob = async () => {
  const today = todayIST();
  console.log(`\n⏱  [CronJob] Running hold→reject scan at ${new Date().toISOString()} | Date(IST): ${today}`);

  try {
    // ── Step 1: Fetch candidates ─────────────────────────────────────────
    const candidates = await Appointment.find({
      status:    'on_hold',
      isOffline: false,
      date:      today,
    }).lean();

    if (!candidates.length) {
      console.log('   ✅ No on_hold appointments found for today.');
      return;
    }

    console.log(`   🔍 Found ${candidates.length} on_hold appointment(s).`);

    // ── Step 2: Filter by 2-hour window ──────────────────────────────────
    const toReject = candidates.filter(a => isWithin2Hours(a.date, a.slot));

    if (!toReject.length) {
      console.log('   ✅ None are within the 2-hour rejection window yet.');
      return;
    }

    console.log(`   ⚠️  ${toReject.length} appointment(s) within 2h window — rejecting...`);

    // ── Step 3: Atomic bulk update ────────────────────────────────────────
    const ids = toReject.map(a => a._id);

    await Appointment.updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'rejected', notifiedOfRejection: true } }
    );

    console.log(`   ✅ ${ids.length} appointment(s) updated to 'rejected'.`);

    // ── Step 4: FCM notifications ─────────────────────────────────────────
    const notifyJobs = toReject.map(async (appt) => {
      try {
        const user = await User.findById(appt.bookedBy).select('phone fcmToken').lean();

        if (!user?.fcmToken) {
          console.warn(`   ⚠️  No FCM token for user ${user?.phone ?? appt.bookedBy}. Skipping.`);
          return;
        }

        await notifyHoldRejected(user.fcmToken, appt.slot, appt.date);
        console.log(`   📲 Notified ${user.phone} of hold rejection.`);
      } catch (err) {
        console.error(`   ❌ Failed to notify for appointment ${appt._id}:`, err.message);
      }
    });

    // allSettled: one failure never blocks the others
    await Promise.allSettled(notifyJobs);

    console.log('   🏁 [CronJob] hold→reject scan complete.\n');
  } catch (err) {
    console.error('   ❌ [CronJob] Fatal error in hold→reject job:', err.message);
  }
};

/**
 * Reminds patients of follow-up appointments scheduled for tomorrow.
 * Runs daily at 10:00 AM IST.
 */
const runFollowUpReminderJob = async () => {
  console.log(`\n⏱  [CronJob] Running follow-up reminder scan at ${new Date().toISOString()}`);

  const now = new Date();
  const tomorrow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  try {
    const candidates = await Appointment.find({
      status: 'accepted',
      isFollowUp: true,
      date: tomorrowStr,
    }).lean();

    if (!candidates.length) {
      console.log(`   ✅ No follow-up appointments found for tomorrow (${tomorrowStr}).`);
      return;
    }

    console.log(`   🔍 Found ${candidates.length} follow-up appointments for tomorrow. Sending Reminders...`);

    const notifyJobs = candidates.map(async (appt) => {
      try {
        const user = await User.findById(appt.bookedBy).select('phone fcmToken').lean();
        if (!user?.fcmToken) return;

        await notifyFollowUpReminder(user.fcmToken, appt.slot, appt.date);
        console.log(`   📲 Sent follow-up reminder to ${user.phone}.`);
      } catch (err) {
        console.error(`   ❌ Failed to remind for appointment ${appt._id}:`, err.message);
      }
    });

    await Promise.allSettled(notifyJobs);
    console.log('   🏁 [CronJob] follow-up reminder scan complete.\n');
  } catch (err) {
    console.error('   ❌ [CronJob] Fatal error in follow-up reminder job:', err.message);
  }
};

// ── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Initialises the cron schedule. Call once from server.js after DB connects.
 *
 * Pattern   :  "* /15 * * * *"     →  every 15 minutes
 * Timezone  :  "Asia/Kolkata"      →  IST-aware date boundary
 */
const startCronJob = () => {
  cron.schedule(
    '*/15 * * * *',
    () => runHoldToRejectJob().catch(err =>
      console.error('❌ [CronJob] Unhandled rejection:', err)
    ),
    { timezone: 'Asia/Kolkata' }
  );

  cron.schedule(
    '0 10 * * *',
    () => runFollowUpReminderJob().catch(err =>
      console.error('❌ [CronJob] Unhandled rejection:', err)
    ),
    { timezone: 'Asia/Kolkata' }
  );

  console.log('🗓️  [CronJob] Hold→Reject job scheduled — runs every 15 minutes (IST).');
  console.log('🗓️  [CronJob] Follow-up Reminder job scheduled — runs daily at 10:00 AM (IST).');
};

module.exports = { startCronJob, runHoldToRejectJob, runFollowUpReminderJob };

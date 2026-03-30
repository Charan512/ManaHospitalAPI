'use strict';
const cron = require('node-cron');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const { notifyHoldRejected } = require('./fcmService');
const { isWithinThreshold, todayIST, SLOTS } = require('../utils/slotHelper');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Mana Hospital — Hold-to-Reject Cron Job
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Frequency  : Every 15 minutes
 * Logic      : Finds all ONLINE on_hold appointments for today where the
 *              slot start time is ≤ 2 hours from now.
 *              Atomically updates them to 'rejected' and sends FCM notifications.
 *
 * Why today only?
 *   The 2-hour window only matters for the current day's slots. Future dates
 *   still have plenty of time. Past-date slots indicate historic records.
 *
 * Slot start times (IST):
 *   '10:00 AM - 02:00 PM' → starts 10:00 IST
 *   '03:00 PM - 07:00 PM' → starts 15:00 IST
 * ─────────────────────────────────────────────────────────────────────────────
 */

const runHoldToRejectJob = async () => {
  const today = todayIST();
  console.log(`\n🕐 [Cron] Hold→Reject job running at ${new Date().toISOString()}`);

  try {
    // ── Step 1: Fetch all on_hold online appointments for today ────────────
    const candidates = await Appointment.find({
      status: 'on_hold',
      isOffline: false,
      date: today,
    }).lean();

    if (candidates.length === 0) {
      console.log('✅ [Cron] No on_hold appointments found. Skipping.');
      return;
    }

    console.log(`🔍 [Cron] Found ${candidates.length} on_hold appointment(s) for ${today}.`);

    // ── Step 2: Filter by 2-hour threshold ────────────────────────────────
    const toReject = candidates.filter((appt) =>
      isWithinThreshold(appt.date, appt.slot)
    );

    if (toReject.length === 0) {
      console.log('✅ [Cron] None are within the 2-hour window yet.');
      return;
    }

    console.log(`⚠️  [Cron] ${toReject.length} appointment(s) within 2h window — rejecting...`);

    // ── Step 3: Atomic bulk update to 'rejected' ──────────────────────────
    const ids = toReject.map((a) => a._id);
    await Appointment.updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'rejected', notifiedOfRejection: true } }
    );

    console.log(`✅ [Cron] ${ids.length} appointment(s) updated to 'rejected'.`);

    // ── Step 4: Send FCM notifications to each affected patient ──────────
    const notificationPromises = toReject.map(async (appt) => {
      try {
        // Fetch the booking user's FCM token
        const user = await User.findById(appt.bookedBy).select('fcmToken phone').lean();
        if (!user) {
          console.warn(`⚠️  [Cron] No user found for bookedBy: ${appt.bookedBy}`);
          return;
        }

        if (!user.fcmToken) {
          console.warn(`⚠️  [Cron] User ${user.phone} has no FCM token. Skipping notification.`);
          return;
        }

        await notifyHoldRejected(user.fcmToken, appt.slot, appt.date);
        console.log(`📲 [Cron] Notified user ${user.phone} of rejection.`);
      } catch (notifyErr) {
        // Don't let one notification failure stop others
        console.error(`❌ [Cron] Failed to notify for appointment ${appt._id}:`, notifyErr.message);
      }
    });

    await Promise.allSettled(notificationPromises);
    console.log('🏁 [Cron] Hold→Reject job complete.\n');
  } catch (err) {
    console.error('❌ [Cron] Hold→Reject job encountered an error:', err.message);
  }
};

/**
 * Initializes and starts the cron schedule.
 * Call this once from server.js after DB is connected.
 *
 * Schedule: "*/15 * * * *"  →  every 15 minutes
 * Timezone: "Asia/Kolkata"  →  ensures IST-aware date comparison
 */
const startCronJobs = () => {
  cron.schedule(
    '*/15 * * * *',
    () => {
      runHoldToRejectJob().catch((err) =>
        console.error('❌ [Cron] Unhandled error in hold→reject job:', err)
      );
    },
    {
      timezone: 'Asia/Kolkata',
    }
  );

  console.log('🗓️  Cron job started: Hold→Reject check every 15 minutes (IST).');
};

module.exports = { startCronJobs, runHoldToRejectJob };

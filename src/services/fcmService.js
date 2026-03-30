'use strict';
const admin = require('firebase-admin');

/**
 * fcmService — Firebase Cloud Messaging helper
 * ─────────────────────────────────────────────
 * Firebase Admin SDK is initialized in server.js.
 * This service provides thin wrappers around the messaging API
 * for the specific notification types used by Mana Hospital.
 */

/**
 * Sends an FCM message to a single device token.
 *
 * @param {string} fcmToken  - Target device registration token
 * @param {string} title     - Notification title
 * @param {string} body      - Notification body text
 * @param {Object} data      - Optional key-value data payload for the app
 * @returns {Promise<string>} - FCM message ID on success
 */
const sendPushNotification = async (fcmToken, title, body, data = {}) => {
  if (!fcmToken) {
    console.warn('⚠️  fcmService: No FCM token provided, skipping notification.');
    return null;
  }

  const message = {
    token: fcmToken,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        channelId: 'mana_hospital_appointments',
      },
    },
    apns: {
      payload: {
        aps: { sound: 'default', badge: 1 },
      },
    },
  };

  try {
    const messageId = await admin.messaging().send(message);
    console.log(`📲 FCM sent to token ...${fcmToken.slice(-8)}: ${messageId}`);
    return messageId;
  } catch (err) {
    // Don't crash the server if FCM fails — log and continue
    console.error('❌ FCM send error:', err.message);
    return null;
  }
};

/**
 * Notifies a patient that their on_hold appointment has been auto-rejected
 * by the 2-hour cron job.
 *
 * @param {string} fcmToken
 * @param {string} slot       - e.g. "10:00 AM - 02:00 PM"
 * @param {string} date       - "YYYY-MM-DD"
 */
const notifyHoldRejected = async (fcmToken, slot, date) => {
  const title = 'Mana Hospital — Appointment Update';
  const body =
    `Sorry, your hold on the ${slot} slot on ${date} at Mana Hospital ` +
    `has expired and your appointment is now Rejected. Please book again.`;

  return sendPushNotification(fcmToken, title, body, {
    type: 'HOLD_REJECTED',
    slot,
    date,
  });
};

/**
 * Sends a notification to the Admin when a new online appointment is booked.
 *
 * @param {string} adminFcmToken
 * @param {string} patientName
 * @param {string} slot
 * @param {string} date
 */
const notifyAdminNewBooking = async (adminFcmToken, patientName, slot, date) => {
  const title = '🏥 New Appointment Request';
  const body = `${patientName} has requested the ${slot} slot on ${date}.`;

  return sendPushNotification(adminFcmToken, title, body, {
    type: 'NEW_BOOKING',
    patientName,
    slot,
    date,
  });
};

/**
 * Notifies a patient that their appointment was canceled/rejected by Admin.
 */
const notifyRejectedAppointment = async (fcmToken, slot, date, oldId) => {
  const title = 'Mana Hospital — Appointment Rejected';
  const body = `Your appointment for ${slot} on ${date} could not be confirmed. Tap here to re-book a free slot.`;

  return sendPushNotification(fcmToken, title, body, {
    type: 'RECOVERY_SUGGESTION',
    slot,
    date,
    oldId: String(oldId),
  });
};

/**
 * Notifies a patient that they missed their appointment.
 */
const notifyMissedAppointment = async (fcmToken, slot, date, oldId) => {
  const title = 'Mana Hospital — Appointment Missed';
  const body = `You missed your appointment at Mana Hospital scheduled for ${slot} on ${date}. Tap to re-book.`;

  return sendPushNotification(fcmToken, title, body, {
    type: 'RECOVERY_SUGGESTION',
    slot,
    date,
    oldId: String(oldId),
  });
};

/**
 * Reminds a patient about their follow-up appointment tomorrow.
 */
const notifyFollowUpReminder = async (fcmToken, slot, date) => {
  const title = 'Mana Hospital — Reminder';
  const body = `Reminder: You have a follow-up appointment at Mana Hospital tomorrow at ${slot}.`;

  return sendPushNotification(fcmToken, title, body, {
    type: 'FOLLOW_UP_REMINDER',
    slot,
    date,
  });
};

module.exports = { 
  sendPushNotification, 
  notifyHoldRejected, 
  notifyAdminNewBooking, 
  notifyMissedAppointment, 
  notifyRejectedAppointment,
  notifyFollowUpReminder 
};

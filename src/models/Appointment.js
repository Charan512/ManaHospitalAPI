'use strict';
const mongoose = require('mongoose');

/**
 * Appointment Schema
 * ──────────────────────────────────────────────────────
 * Slot Enum Values (display strings used across the app):
 *   '10:00 AM - 02:00 PM'   →  Morning slot, starts 10:00
 *   '03:00 PM - 07:00 PM'   →  Evening slot, starts 15:00
 *
 * Status Lifecycle:
 *   pending  → Admin reviews → accepted | rejected | on_hold
 *   on_hold  → Cron job auto-rejects 2h before slot start if still on_hold
 *
 * isOffline:
 *   true  → Walk-in entry by Admin, status set to 'accepted' immediately
 *   false → Online booking by Patient
 *
 * Atomic Booking Rule (enforced at route level with Mongoose session):
 *   COUNT(status IN ['pending', 'accepted', 'on_hold'] WHERE date=X AND slot=Y)
 *   must be < 5 before a new document can be inserted.
 *
 * Indexes:
 *   Compound index on { date, slot, status } — fast occupancy lookups
 *   Single index on { bookedBy }             — patient history queries
 */
const SLOTS = ['10:00 AM - 02:00 PM', '03:00 PM - 07:00 PM'];
const STATUSES = ['pending', 'accepted', 'rejected', 'on_hold', 'completed', 'missed'];

const appointmentSchema = new mongoose.Schema(
  {
    /* ── Who booked ─────────────────────────────────── */
    bookedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /* ── Patient details ────────────────────────────── */
    patientName: {
      type: String,
      required: true,
      trim: true,
    },
    patientPhone: {
      type: String,
      required: true,
      trim: true,
    },
    isSelf: {
      type: Boolean,
      default: true,
    },

    /* ── Clinical details (optional) ────────────────── */
    issueDescription: {
      type: String,
      trim: true,
      default: '',
    },
    comments: {
      type: String,
      trim: true,
      default: '',
    },
    prescription: {
      type: String,
      trim: true,
      default: '',
    },
    validUntil: {
      type: String,
      trim: true,
    },
    isFollowUp: {
      type: Boolean,
      default: false,
    },

    /* ── Slot details ────────────────────────────────── */
    isOffline: {
      type: Boolean,
      default: false,
    },
    date: {
      // Stored as "YYYY-MM-DD" string for simple daily grouping
      type: String,
      required: true,
    },
    slot: {
      type: String,
      enum: SLOTS,
      required: true,
    },

    /* ── Status ─────────────────────────────────────── */
    status: {
      type: String,
      enum: STATUSES,
      default: 'pending',
    },

    /* ── FCM notification tracking ──────────────────── */
    notifiedOfRejection: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  }
);

/* ── Indexes ──────────────────────────────────────────────────────────── */

// Primary occupancy-check index: fast slot availability query
appointmentSchema.index({ date: 1, slot: 1, status: 1 });

// Cron job index: quickly find on_hold + online appointments for rejection
appointmentSchema.index({ status: 1, isOffline: 1, date: 1 });

/* ── Static helper ───────────────────────────────────────────────────── */

/**
 * Returns the total number of "active" bookings for a given date+slot.
 * Active = any status that consumes one of the 5 available spots.
 *
 * @param {string} date  - "YYYY-MM-DD"
 * @param {string} slot  - one of SLOTS enum values
 * @param {ClientSession} [session] - optional Mongoose session for transactions
 * @returns {Promise<number>}
 */
appointmentSchema.statics.getSlotOccupancy = async function (date, slot, session = null) {
  const opts = session ? { session } : {};
  return this.countDocuments(
    {
      date,
      slot,
      status: { $in: ['pending', 'accepted', 'on_hold'] },
    },
    opts
  );
};

module.exports = mongoose.model('Appointment', appointmentSchema);

'use strict';
const mongoose = require('mongoose');

/**
 * User Schema
 * ──────────────────────────────────────────────────────
 * Roles:
 *   'patient' – Public user who books via OTP
 *   'admin'   – Hospital staff, matched against ADMIN_PHONE seed
 *
 * fcmToken is updated on every login so notifications always reach
 * the user's current device.
 */
const userSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
      // Stored in E.164 format, e.g. "+917989101146"
    },
    name: {
      type: String,
      trim: true,
      default: '',
    },
    role: {
      type: String,
      enum: ['patient', 'admin'],
      default: 'patient',
    },
    fcmToken: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
  }
);

module.exports = mongoose.model('User', userSchema);

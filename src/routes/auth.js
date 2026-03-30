'use strict';
const express = require('express');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

/**
 * POST /api/auth/firebase-login
 * ─────────────────────────────────────────────────────────────────────────────
 * Flow:
 *  1. Client completes Firebase Phone OTP on device.
 *  2. Client sends the Firebase ID token to this endpoint.
 *  3. Backend verifies the token with Firebase Admin SDK (cryptographic verify).
 *  4. Extracts phone number from the decoded token.
 *  5. Checks if phone matches ADMIN_PHONE env var → sets role accordingly.
 *  6. Upserts User record in MongoDB (creates if new, updates fcmToken).
 *  7. Issues a backend JWT with { id, phone, role }.
 *
 * Body: { idToken: string, fcmToken?: string, name?: string }
 * Response: { success: true, token: string, user: { id, phone, role, name } }
 */
router.post('/firebase-login', async (req, res) => {
  const { idToken, fcmToken, name } = req.body;

  if (!idToken) {
    return res.status(400).json({ success: false, message: 'Firebase ID token is required.' });
  }

  try {
    // ── Step 1: Verify Firebase ID Token ─────────────────────────────────
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (firebaseErr) {
      console.error('Firebase token verification failed:', firebaseErr.message);
      return res.status(401).json({ success: false, message: 'Invalid or expired Firebase token.' });
    }

    const firebasePhone = decodedToken.phone_number;

    if (!firebasePhone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number not found in Firebase token. Ensure Phone Auth is used.',
      });
    }

    // ── Step 2: Determine Role ────────────────────────────────────────────
    // ADMIN_PHONE in .env must be in E.164 format: +917989101146
    const adminPhone = process.env.ADMIN_PHONE;
    const role = firebasePhone === adminPhone ? 'admin' : 'patient';

    // ── Step 3: Upsert User in MongoDB ───────────────────────────────────
    const updateFields = { role };
    if (fcmToken) updateFields.fcmToken = fcmToken;
    if (name && name.trim()) updateFields.name = name.trim();

    const user = await User.findOneAndUpdate(
      { phone: firebasePhone },
      {
        $set: updateFields,
        $setOnInsert: { phone: firebasePhone, createdAt: new Date() },
      },
      { upsert: true, new: true, runValidators: true }
    );

    // ── Step 4: Issue Backend JWT ─────────────────────────────────────────
    const payload = { id: user._id, phone: user.phone, role: user.role };
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        phone: user.phone,
        role: user.role,
        name: user.name,
      },
    });
  } catch (err) {
    console.error('POST /api/auth/firebase-login error:', err);
    return res.status(500).json({ success: false, message: 'Server error during login.' });
  }
});

/**
 * PATCH /api/auth/fcm-token
 * ─────────────────────────────────────────────────────────────────────────────
 * Updates the FCM token for a logged-in user (called on app foreground).
 * Requires: Authorization: Bearer <jwt>
 * Body: { fcmToken: string }
 */
const verifyToken = require('../middleware/verifyToken');

router.patch('/fcm-token', verifyToken, async (req, res) => {
  const { fcmToken } = req.body;

  if (!fcmToken) {
    return res.status(400).json({ success: false, message: 'fcmToken is required.' });
  }

  try {
    await User.findByIdAndUpdate(req.user.id, { $set: { fcmToken } });
    return res.status(200).json({ success: true, message: 'FCM token updated.' });
  } catch (err) {
    console.error('PATCH /api/auth/fcm-token error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;

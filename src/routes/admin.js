'use strict';
const express = require('express');
const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const verifyToken = require('../middleware/verifyToken');
const verifyAdmin = require('../middleware/verifyAdmin');

const router = express.Router();

/**
 * Helper to get today's date string in IST
 */
function getTodayISTString() {
  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istNow = new Date(utcMs + (3600000 * 5.5));
  return `${istNow.getFullYear()}-${String(istNow.getMonth() + 1).padStart(2, '0')}-${String(istNow.getDate()).padStart(2, '0')}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/admin/dashboard-stats
   ───────────────────────────────────────────────────────────────────────────
   Fetches:
    1. Count of all 'pending' appointments (for Approval Triage Badge)
    2. 10 most recent appointments matching specific statuses (for recent logs list)
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/dashboard-stats', verifyAdmin, async (req, res) => {
  try {
    const today = getTodayISTString();

    const pendingCount = await Appointment.countDocuments({
      status: 'pending',
      date: { $gte: today }, // Only care about pending ones for today or future
    });

    const recentLogs = await Appointment.find({
      status: { $in: ['completed', 'accepted', 'pending'] }
    })
      .populate('bookedBy', 'phone name')
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean();

    return res.status(200).json({
      success: true,
      pendingCount,
      recentLogs,
    });
  } catch (err) {
    console.error('GET /api/admin/dashboard-stats error:', err);
    return res.status(500).json({ success: false, message: 'Server error fetching dashboard stats.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/admin/approvals
   ───────────────────────────────────────────────────────────────────────────
   Dedicated endpoint for the Triage Screen.
   Filters strictly `pending` status appointments that are for TODAY or FUTURE.
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/approvals', verifyAdmin, async (req, res) => {
  try {
    const today = getTodayISTString();

    const pendingAppointments = await Appointment.find({
      status: 'pending',
      date: { $gte: today },
    })
      .populate('bookedBy', 'phone name')
      .sort({ date: 1, slot: 1 }) // Chronological
      .lean();

    return res.status(200).json({
       success: true, 
       appointments: pendingAppointments 
    });
  } catch (err) {
    console.error('GET /api/admin/approvals error:', err);
    return res.status(500).json({ success: false, message: 'Server error fetching pending approvals.' });
  }
});

module.exports = router;

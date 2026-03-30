'use strict';
const express = require('express');
const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const verifyToken = require('../middleware/verifyToken');
const verifyAdmin = require('../middleware/verifyAdmin');
const { notifyAdminNewBooking, notifyMissedAppointment } = require('../services/fcmService');

const router = express.Router();

/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/appointments/slots?date=YYYY-MM-DD
   ───────────────────────────────────────────────────────────────────────────
   Returns occupancy count for both slots on a given date.
   Used by the Patient UI to render the SlotGradientCard.
   Public (no auth required) — patients need to see availability before login.
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/slots', async (req, res) => {
  const { date } = req.query;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, message: 'Query param "date" must be YYYY-MM-DD.' });
  }

  try {
    const SLOTS = ['10:00 AM - 02:00 PM', '03:00 PM - 07:00 PM'];

    const results = await Promise.all(
      SLOTS.map(async (slot) => {
        const count = await Appointment.getSlotOccupancy(date, slot);
        return { slot, booked: count, available: Math.max(0, 5 - count), isFull: count >= 5 };
      })
    );

    return res.status(200).json({ success: true, date, slots: results });
  } catch (err) {
    console.error('GET /api/appointments/slots error:', err);
    return res.status(500).json({ success: false, message: 'Server error fetching slot data.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/appointments/my
   ───────────────────────────────────────────────────────────────────────────
   Returns appointment history for the authenticated patient.
   Requires: Bearer JWT
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/my', verifyToken, async (req, res) => {
  try {
    const appointments = await Appointment.find({ bookedBy: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, appointments });
  } catch (err) {
    console.error('GET /api/appointments/my error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/appointments/admin/daily?date=YYYY-MM-DD
   ───────────────────────────────────────────────────────────────────────────
   Admin view: all appointments for a given date, grouped by slot.
   Requires: Admin JWT
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/admin/daily', verifyAdmin, async (req, res) => {
  const { date } = req.query;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, message: 'Query param "date" must be YYYY-MM-DD.' });
  }

  try {
    const appointments = await Appointment.find({ date })
      .populate('bookedBy', 'phone name')
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({ success: true, date, appointments });
  } catch (err) {
    console.error('GET /api/appointments/admin/daily error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/appointments/book
   ───────────────────────────────────────────────────────────────────────────
   ONLINE booking by a Patient.
   Requires: Bearer JWT (patient or admin)

   ATOMIC 5-SLOT ENFORCEMENT:
     Uses a MongoDB session + transaction so that two concurrent requests
     cannot both pass the occupancy check and both get saved (race condition).

   Body:
     { date, slot, isSelf, patientName?, patientPhone? }

   On success:
     - Creates appointment with status: 'pending'
     - Notifies Admin via FCM
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/book', verifyToken, async (req, res) => {
  const { date, slot, isSelf, patientName, patientPhone, issueDescription, comments } = req.body;

  // ── Input validation ─────────────────────────────────────────────────
  if (!date || !slot) {
    return res.status(400).json({ success: false, message: 'date and slot are required.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, message: 'date must be YYYY-MM-DD.' });
  }
  const validSlots = ['10:00 AM - 02:00 PM', '03:00 PM - 07:00 PM'];
  if (!validSlots.includes(slot)) {
    return res.status(400).json({ success: false, message: 'Invalid slot value.' });
  }

  // ── Duplicate booking guard ──────────────────────────────────────
  // A patient cannot book again until their last appointment is rejected.
  const existingActive = await Appointment.findOne({
    bookedBy: req.user.id,
    status: { $in: ['pending', 'accepted', 'on_hold'] },
  }).lean();

  if (existingActive) {
    return res.status(409).json({
      success: false,
      message: 'You already have an active appointment. You can only book again once your current appointment is rejected.',
      hasActiveAppointment: true,
    });
  }

  // ── Determine patient details ────────────────────────────────────────
  let resolvedName = patientName;
  let resolvedPhone = patientPhone;

  if (isSelf !== false) {
    // Fetch from logged-in user's profile
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    // If user has no stored name AND a name was submitted from the form, use it
    resolvedName = user.name || patientName || 'Patient';
    resolvedPhone = user.phone;
  } else {
    if (!patientName || !patientPhone) {
      return res.status(400).json({
        success: false,
        message: 'patientName and patientPhone are required when booking for someone else.',
      });
    }
  }

  // ── Mongoose Transaction for atomic booking ──────────────────────────
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // CRITICAL: Check occupancy INSIDE the transaction
    const occupancy = await Appointment.getSlotOccupancy(date, slot, session);

    if (occupancy >= 5) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({
        success: false,
        message: 'This slot is fully booked. Please choose another slot or date.',
        slotFull: true,
      });
    }

    // Safe to create the booking
    const [newAppointment] = await Appointment.create(
      [
        {
          bookedBy: req.user.id,
          patientName: resolvedName,
          patientPhone: resolvedPhone,
          isSelf: isSelf !== false,
          isOffline: false,
          date,
          slot,
          status: 'pending',
          issueDescription: issueDescription?.trim() || '',
          comments: comments?.trim() || '',
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    // ── Notify Admin (fire-and-forget, don't block response) ──────────
    User.findOne({ role: 'admin' })
      .then((adminUser) => {
        if (adminUser?.fcmToken) {
          notifyAdminNewBooking(adminUser.fcmToken, resolvedName, slot, date).catch(() => {});
        }
      })
      .catch(() => {});

    return res.status(201).json({
      success: true,
      message: 'Appointment booked successfully. Status: Pending.',
      appointment: newAppointment,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('POST /api/appointments/book error:', err);
    return res.status(500).json({ success: false, message: 'Server error during booking.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/appointments/offline
   ───────────────────────────────────────────────────────────────────────────
   OFFLINE walk-in entry by Admin ONLY.
   - Bypasses OTP (admin is already authenticated via JWT).
   - Status is immediately 'accepted'.
   - isOffline: true.
   - Still enforces the 5-patient limit atomically.

   Requires: Admin JWT
   Body: { date, slot, patientName, patientPhone }
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/offline', verifyAdmin, async (req, res) => {
  const { date, slot, patientName, patientPhone } = req.body;

  if (!date || !slot || !patientName || !patientPhone) {
    return res.status(400).json({
      success: false,
      message: 'date, slot, patientName, and patientPhone are all required.',
    });
  }

  const validSlots = ['10:00 AM - 02:00 PM', '03:00 PM - 07:00 PM'];
  if (!validSlots.includes(slot)) {
    return res.status(400).json({ success: false, message: 'Invalid slot value.' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Still enforce the 5-slot limit — offline doesn't mean unlimited
    const occupancy = await Appointment.getSlotOccupancy(date, slot, session);

    if (occupancy >= 5) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({
        success: false,
        message: 'Slot is full (5/5). Cannot add more patients even as walk-in.',
        slotFull: true,
      });
    }

    const [newAppointment] = await Appointment.create(
      [
        {
          bookedBy: req.user.id, // Admin's user ID
          patientName: patientName.trim(),
          patientPhone: patientPhone.trim(),
          isSelf: false,
          isOffline: true,    // ← Key distinction
          date,
          slot,
          status: 'accepted', // ← Immediately accepted, no pending review
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    return res.status(201).json({
      success: true,
      message: `Offline walk-in registered for ${patientName}. Status: Accepted.`,
      appointment: newAppointment,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('POST /api/appointments/offline error:', err);
    return res.status(500).json({ success: false, message: 'Server error during offline booking.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   PATCH /api/appointments/:id/status
   ───────────────────────────────────────────────────────────────────────────
   Admin updates appointment status (accept / reject / on_hold).
   Requires: Admin JWT
   Body: { status: 'accepted' | 'rejected' | 'on_hold' }
   ═══════════════════════════════════════════════════════════════════════════ */
router.patch('/:id/status', verifyAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['accepted', 'rejected', 'on_hold', 'missed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: `status must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const appointment = await Appointment.findByIdAndUpdate(
      id,
      { $set: { status } },
      { new: true }
    );

    if (!appointment) {
      return res.status(404).json({ success: false, message: 'Appointment not found.' });
    }

    if (status === 'missed') {
      const user = await User.findById(appointment.bookedBy).lean();
      if (user?.fcmToken) {
        notifyMissedAppointment(user.fcmToken, appointment.slot, appointment.date).catch(() => {});
      }
    }

    return res.status(200).json({ success: true, appointment });
  } catch (err) {
    console.error('PATCH /api/appointments/:id/status error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/appointments/:id/complete
   ───────────────────────────────────────────────────────────────────────────
   Admin completes an appointment and optionally books follow-up atomically.
   Body: { prescription, nextVisitDate, nextVisitSlot }
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/:id/complete', verifyAdmin, async (req, res) => {
  const { id } = req.params;
  const { prescription, nextVisitDate, nextVisitSlot } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const currentAppt = await Appointment.findById(id).session(session);
    if (!currentAppt) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: 'Appointment not found.' });
    }

    // Update current appointment
    currentAppt.status = 'completed';
    currentAppt.prescription = prescription?.trim() || '';
    if (nextVisitDate) {
      currentAppt.validUntil = nextVisitDate;
    }
    await currentAppt.save({ session });

    let newAppointment = null;

    // Follow up
    if (nextVisitDate && nextVisitSlot) {
      const occupancy = await Appointment.getSlotOccupancy(nextVisitDate, nextVisitSlot, session);
      if (occupancy >= 5) {
        await session.abortTransaction();
        session.endSession();
        return res.status(409).json({ success: false, message: 'Follow-up slot is completely full (5/5). Cannot book follow-up.', slotFull: true });
      }

      [newAppointment] = await Appointment.create([{
        bookedBy: currentAppt.bookedBy,
        patientName: currentAppt.patientName,
        patientPhone: currentAppt.patientPhone,
        isSelf: currentAppt.isSelf,
        isOffline: currentAppt.isOffline,
        date: nextVisitDate,
        slot: nextVisitSlot,
        status: 'accepted',
        isFollowUp: true,
      }], { session });
    }

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      success: true,
      message: 'Appointment completed successfully.',
      appointment: currentAppt,
      followUp: newAppointment
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('POST /api/appointments/:id/complete error:', err);
    return res.status(500).json({ success: false, message: 'Server error during completion flow.' });
  }
});

module.exports = router;

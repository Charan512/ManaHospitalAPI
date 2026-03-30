'use strict';
const express = require('express');
const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const verifyToken = require('../middleware/verifyToken');
const verifyAdmin = require('../middleware/verifyAdmin');
const { notifyAdminNewBooking, notifyMissedAppointment, notifyRejectedAppointment } = require('../services/fcmService');

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
    
    // Time-Gate logic based on IST
    const now = new Date();
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
    const istNow = new Date(utcMs + (3600000 * 5.5));
    
    // Check if the requested date is a Sunday
    const requestedDateObj = new Date(date);
    const isSunday = requestedDateObj.getUTCDay() === 0;

    const istString = `${istNow.getFullYear()}-${String(istNow.getMonth() + 1).padStart(2, '0')}-${String(istNow.getDate()).padStart(2, '0')}`;
    const todayHour = istNow.getHours();
    const todayMinute = istNow.getMinutes();

    const isToday = (date === istString);

    const results = await Promise.all(
      SLOTS.map(async (slot) => {
        let isExpired = false;
        
        if (isSunday) {
          isExpired = true;
        } else if (isToday) {
          if (slot === '10:00 AM - 02:00 PM' && (todayHour > 10 || (todayHour === 10 && todayMinute > 0))) {
            isExpired = true;
          } else if (slot === '03:00 PM - 07:00 PM' && (todayHour > 15 || (todayHour === 15 && todayMinute > 0))) {
            isExpired = true;
          }
        }

        const count = await Appointment.getSlotOccupancy(date, slot);
        return { 
          slot, 
          booked: count, 
          available: Math.max(0, 5 - count), 
          isFull: count >= 5,
          isExpired
        };
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
  const { date, slot, isSelf, patientName, patientPhone, age, issueDescription, comments } = req.body;

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

  // ── Time-Gate Validation ─────────────────────────────────────────────
  const requestedDateObj = new Date(date);
  if (requestedDateObj.getUTCDay() === 0) {
    return res.status(400).json({ success: false, message: 'Booking not allowed on Sundays.' });
  }

  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istNow = new Date(utcMs + (3600000 * 5.5));
  const istString = `${istNow.getFullYear()}-${String(istNow.getMonth() + 1).padStart(2, '0')}-${String(istNow.getDate()).padStart(2, '0')}`;
  
  // If the requested date is older than today, block it.
  if (date < istString) {
    return res.status(400).json({ success: false, message: 'Cannot book appointments for past dates.' });
  }

  if (date === istString) {
    const todayHour = istNow.getHours();
    const todayMinute = istNow.getMinutes();
    
    if (slot === '10:00 AM - 02:00 PM' && (todayHour > 10 || (todayHour === 10 && todayMinute > 0))) {
      return res.status(400).json({ success: false, message: '10:00 AM slot is expired for today.', isExpired: true });
    } else if (slot === '03:00 PM - 07:00 PM' && (todayHour > 15 || (todayHour === 15 && todayMinute > 0))) {
      return res.status(400).json({ success: false, message: '03:00 PM slot is expired for today.', isExpired: true });
    }
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
          age: age != null ? Number(age) : undefined,
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
  const { date, slot, patientName, patientPhone, age } = req.body;

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
          age: age != null ? Number(age) : undefined,
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
        notifyMissedAppointment(user.fcmToken, appointment.slot, appointment.date, id).catch(() => {});
      }
    } else if (status === 'rejected') {
      const user = await User.findById(appointment.bookedBy).lean();
      if (user?.fcmToken) {
        notifyRejectedAppointment(user.fcmToken, appointment.slot, appointment.date, id).catch(() => {});
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

/* ═══════════════════════════════════════════════════════════════════════════
   GET /api/appointments/suggest-next
   ───────────────────────────────────────────────────────────────────────────
   Scans starting from today IST forward to find the VERY FIRST date + slot
   that has fewer than 5 patients and is not a Sunday or expired.
   Returns: { date, slot }
   ═══════════════════════════════════════════════════════════════════════════ */
router.get('/suggest-next', verifyToken, async (req, res) => {
  try {
    const SLOTS = ['10:00 AM - 02:00 PM', '03:00 PM - 07:00 PM'];
    
    // Time boundaries (IST)
    const now = new Date();
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
    let currentIst = new Date(utcMs + (3600000 * 5.5));
    
    const todayHour = currentIst.getHours();
    const todayMinute = currentIst.getMinutes();
    
    // We scan up to 14 days ahead
    for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
      const scanDate = new Date(currentIst.getTime() + (dayOffset * 86400000));
      if (scanDate.getUTCDay() === 0) continue; // Skip Sundays
      
      const dateStr = `${scanDate.getFullYear()}-${String(scanDate.getMonth() + 1).padStart(2, '0')}-${String(scanDate.getDate()).padStart(2, '0')}`;
      const isToday = (dayOffset === 0);

      for (const slot of SLOTS) {
        if (isToday) {
          if (slot === '10:00 AM - 02:00 PM' && (todayHour > 10 || (todayHour === 10 && todayMinute > 0))) continue;
          if (slot === '03:00 PM - 07:00 PM' && (todayHour > 15 || (todayHour === 15 && todayMinute > 0))) continue;
        }

        const count = await Appointment.getSlotOccupancy(dateStr, slot);
        if (count < 5) {
          // Found the immediate next valid slot
          return res.status(200).json({ success: true, date: dateStr, slot });
        }
      }
    }

    return res.status(404).json({ success: false, message: 'No available slots found in the next 14 days.' });
  } catch (err) {
    console.error('GET /api/appointments/suggest-next error:', err);
    return res.status(500).json({ success: false, message: 'Server error parsing suggestions.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/appointments/recover/:oldId
   ───────────────────────────────────────────────────────────────────────────
   Receives a previous rejected/missed appointment ID and identical user metadata
   to seamlessly map into a brand new pending slot.
   Body: { date, slot }
   ═══════════════════════════════════════════════════════════════════════════ */
router.post('/recover/:oldId', verifyToken, async (req, res) => {
  const { date, slot } = req.body;
  const { oldId } = req.params;

  if (!date || !slot) return res.status(400).json({ success: false, message: 'date and slot are required.' });

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const oldAppt = await Appointment.findById(oldId).lean();
    if (!oldAppt) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: 'Original appointment not found.' });
    }

    if (oldAppt.bookedBy.toString() !== req.user.id) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ success: false, message: 'Unauthorized recovery access.' });
    }

    const occupancy = await Appointment.getSlotOccupancy(date, slot, session);
    if (occupancy >= 5) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({ success: false, message: 'Selected slot is fully booked.', slotFull: true });
    }

    const [newAppointment] = await Appointment.create([{
      bookedBy: req.user.id,
      patientName: oldAppt.patientName,
      patientPhone: oldAppt.patientPhone,
      age: oldAppt.age,
      isSelf: oldAppt.isSelf,
      isOffline: false,
      date,
      slot,
      status: 'pending',
      issueDescription: oldAppt.issueDescription,
      comments: oldAppt.comments,
    }], { session });

    // Mark the old one as acknowledged so it leaves the feed automatically
    await Appointment.findByIdAndUpdate(oldId, { recoveryAcknowledged: true }, { session });

    await session.commitTransaction();
    session.endSession();

    // Notify Admin natively of the new booking recovery
    User.findOne({ role: 'admin' }).then((adminUser) => {
      if (adminUser?.fcmToken) notifyAdminNewBooking(adminUser.fcmToken, oldAppt.patientName, slot, date).catch(() => {});
    }).catch(() => {});

    return res.status(201).json({ success: true, message: 'Recovered successfully.', appointment: newAppointment });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error('POST /api/appointments/recover error:', err);
    return res.status(500).json({ success: false, message: 'Server error recovering.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   PATCH /api/appointments/:id/dismiss-recovery
   ───────────────────────────────────────────────────────────────────────────
   Hides the missed/rejected appointment from the user's notification feed.
   ═══════════════════════════════════════════════════════════════════════════ */
router.patch('/:id/dismiss-recovery', verifyToken, async (req, res) => {
  try {
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, bookedBy: req.user.id },
      { $set: { recoveryAcknowledged: true } },
      { new: true }
    );
    if (!appointment) return res.status(404).json({ success: false, message: 'Appointment not found.' });
    
    return res.status(200).json({ success: true, appointment });
  } catch (err) {
    console.error('PATCH /dismiss-recovery error:', err);
    return res.status(500).json({ success: false, message: 'Server error dismissing.' });
  }
});

module.exports = router;

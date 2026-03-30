'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const admin = require('firebase-admin');
const fs = require('fs');

const connectDB = require('./src/config/db');
const { startCronJob } = require('./src/services/cronJob');   // ← specified entry point

const authRouter        = require('./src/routes/auth');
const appointmentsRouter = require('./src/routes/appointments');

/* ─────────────────────────────────────────────────────────────────────────
   Firebase Admin SDK Initialization
   ─────────────────────────────────────────────────────────────────────────
   Reads the service account JSON from the path in FIREBASE_SERVICE_ACCOUNT.
   If the file doesn't exist yet, Firebase features are disabled gracefully
   so the rest of the server can still start during development.
   ───────────────────────────────────────────────────────────────────────── */
const initFirebase = () => {
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!saPath || !fs.existsSync(saPath)) {
    console.warn(
      '⚠️  Firebase service account file not found at:',
      saPath,
      '\n   FCM notifications will be disabled. Download it from Firebase Console → Project Settings → Service Accounts.'
    );
    return;
  }

  try {
    const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase Admin SDK initialized.');
  } catch (err) {
    console.error('❌ Failed to initialize Firebase Admin SDK:', err.message);
  }
};

/* ─────────────────────────────────────────────────────────────────────────
   Express App Setup
   ───────────────────────────────────────────────────────────────────────── */
const app = express();

// Security headers
app.use(helmet());

// CORS — allow Flutter app and any local dev client
app.use(
  cors({
    origin: '*', // Restrict to your domain in production
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Request logging
app.use(morgan('dev'));

// JSON body parser
app.use(express.json());

/* ─────────────────────────────────────────────────────────────────────────
   Routes
   ───────────────────────────────────────────────────────────────────────── */
app.use('/api/auth', authRouter);
app.use('/api/appointments', appointmentsRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'Mana Hospital API',
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found.` });
});

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

/* ─────────────────────────────────────────────────────────────────────────
   Bootstrap: Connect DB → Init Firebase → Start Cron → Listen
   ───────────────────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;

const bootstrap = async () => {
  // 1. Connect to MongoDB first — exits if it fails
  await connectDB();

  // 2. Init Firebase Admin SDK
  initFirebase();

  // 3. Start the 15-minute cron job
  startCronJob();

  // 4. Start listening
  app.listen(PORT, () => {
    console.log(`\n🏥 Mana Hospital API running on http://localhost:${PORT}`);
    console.log(`   Admin phone: ${process.env.ADMIN_PHONE}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
  });
};

bootstrap().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});

module.exports = app; // For testing

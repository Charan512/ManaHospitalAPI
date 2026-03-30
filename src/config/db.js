'use strict';
const mongoose = require('mongoose');

/**
 * Connects to MongoDB using the URI in MONGODB_URI env var.
 * Exits the process on failure so the server doesn't start in a broken state.
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      // Keep the connection alive in serverless-ish environments
      serverSelectionTimeoutMS: 10000,
    });
    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;

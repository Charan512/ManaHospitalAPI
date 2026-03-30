'use strict';
const verifyToken = require('./verifyToken');

/**
 * verifyAdmin — Admin-only route guard
 * ─────────────────────────────────────
 * Chains verifyToken first, then checks role === 'admin'.
 * Use as: router.post('/offline', verifyAdmin, controller)
 */
const verifyAdmin = [
  verifyToken,
  (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
      return next();
    }
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin role required.',
    });
  },
];

module.exports = verifyAdmin;

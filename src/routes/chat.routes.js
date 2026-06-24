const express = require('express');
const {
  listMessagesForAppointment,
  postMessage,
} = require('../controllers/chat.controller');

const router = express.Router();

// GET  /api/chat/:appointmentId        → sorted message history
// POST /api/chat/:appointmentId        → HTTP fallback for sending
router.get('/:appointmentId', listMessagesForAppointment);
router.post('/:appointmentId', postMessage);

module.exports = router;

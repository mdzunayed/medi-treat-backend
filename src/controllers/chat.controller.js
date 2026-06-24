const mongoose = require('mongoose');
const Message = require('../models/Message');
const Account = require('../models/Account');
const { safeEmitNotification } = require('../services/notificationService');

async function notifyChatRecipient(io, savedMessage) {
  if (!savedMessage) return;
  let senderName = 'Someone';
  try {
    const acc = await Account.findById(savedMessage.senderId, 'full_name').lean();
    if (acc && acc.full_name) senderName = acc.full_name;
  } catch (_) {
    /* best-effort */
  }
  const preview = (savedMessage.messageText || '').slice(0, 120);
  await safeEmitNotification(io, {
    recipientId: savedMessage.receiverId,
    senderId: savedMessage.senderId,
    title: `New message from ${senderName}`,
    body: preview,
    type: 'chat',
    payload: {
      appointmentId: savedMessage.appointmentId?.toString(),
      messageId: savedMessage._id?.toString() || savedMessage.id,
      deepLink: 'chat',
    },
  });
}

// GET /api/chat/:appointmentId — full sorted message log for one
// appointment (a.k.a. care_request). Returns oldest-first so the
// Flutter ListView can render the conversation top-to-bottom without
// reversing.
async function listMessagesForAppointment(req, res) {
  try {
    const { appointmentId } = req.params;
    if (!mongoose.isValidObjectId(appointmentId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid appointmentId' });
    }
    const messages = await Message.find({ appointmentId })
      .sort({ timestamp: 1 })
      .lean({ getters: true });
    // `.lean()` skips the schema `toJSON` transform, so we normalise
    // ObjectId-shaped fields by hand to match the websocket payload.
    const out = messages.map((m) => ({
      id: m._id?.toString(),
      appointmentId: m.appointmentId?.toString(),
      senderId: m.senderId?.toString(),
      receiverId: m.receiverId?.toString(),
      messageText: m.messageText,
      timestamp: m.timestamp,
      isRead: m.isRead === true,
    }));
    res.json({ success: true, messages: out });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

// POST /api/chat/:appointmentId  { senderId, receiverId, messageText }
//
// Optional HTTP fallback for clients that can't open a websocket (e.g.
// background notifications retrying a queued send). Same persistence
// path as the socket handler; whichever endpoint writes first, the
// other one is safe to skip.
async function postMessage(req, res) {
  try {
    const { appointmentId } = req.params;
    const { senderId, receiverId, messageText } = req.body || {};
    if (!mongoose.isValidObjectId(appointmentId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid appointmentId' });
    }
    if (!senderId || !mongoose.isValidObjectId(senderId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid senderId' });
    }
    if (!receiverId || !mongoose.isValidObjectId(receiverId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid receiverId' });
    }
    const text = (messageText || '').toString().trim();
    if (!text) {
      return res
        .status(400)
        .json({ success: false, message: 'messageText is required' });
    }
    const saved = await Message.create({
      appointmentId,
      senderId,
      receiverId,
      messageText: text,
    });
    // Echo over the websocket too, if Socket.io is mounted, so any
    // open chat screens for this appointment receive the message in
    // real time without a refresh. The IO instance lives on the app
    // (`app.set('io', io)` in server.js) — gracefully skipped when
    // tests boot the router without a live socket layer.
    const io = req.app.get('io');
    if (io) {
      io.to(appointmentId.toString()).emit('receive_message', saved.toJSON());
    }
    await notifyChatRecipient(io, saved);
    res.status(201).json({ success: true, message: saved.toJSON() });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

module.exports = {
  notifyChatRecipient,
  listMessagesForAppointment,
  postMessage,
};

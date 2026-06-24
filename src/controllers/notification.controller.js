const mongoose = require('mongoose');
const Notification = require('../models/Notification');

// GET /api/notifications  →  every notification for the signed-in user,
// newest first. Lightweight pagination via ?limit / ?before is offered
// so the hub can lazy-load older pages if the conversation log grows
// beyond a screen-full.
async function listMyNotifications(req, res) {
  try {
    const recipientId = req.accountId;
    if (!recipientId) {
      return res
        .status(401)
        .json({ success: false, message: 'Authentication required' });
    }
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const beforeRaw = req.query.before;
    const filter = { recipientId };
    if (beforeRaw) {
      const before = new Date(beforeRaw);
      if (!Number.isNaN(before.getTime())) {
        filter.timestamp = { $lt: before };
      }
    }
    const rows = await Notification.find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
    const out = rows.map((n) => ({
      id: n._id?.toString(),
      recipientId: n.recipientId?.toString(),
      senderId: n.senderId?.toString() || null,
      title: n.title,
      body: n.body,
      type: n.type,
      payload: n.payload || {},
      isRead: n.isRead === true,
      timestamp: n.timestamp,
    }));
    const unreadCount = await Notification.countDocuments({
      recipientId,
      isRead: false,
    });
    res.json({
      success: true,
      notifications: out,
      unreadCount,
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

// PATCH /api/notifications/:id/read  →  flip a single row to read.
// Ownership-gated: a recipient can only mark their own notifications.
async function markOneRead(req, res) {
  try {
    const recipientId = req.accountId;
    if (!recipientId) {
      return res
        .status(401)
        .json({ success: false, message: 'Authentication required' });
    }
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid notification id' });
    }
    const doc = await Notification.findOneAndUpdate(
      { _id: id, recipientId },
      { $set: { isRead: true } },
      { new: true }
    );
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: 'Notification not found' });
    }
    res.json({ success: true, notification: doc.toJSON() });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

// PATCH /api/notifications/read-all  →  bulk mark everything in the
// recipient's inbox as read. Returns the updated count so the UI can
// reconcile its local counters without a follow-up GET.
async function markAllRead(req, res) {
  try {
    const recipientId = req.accountId;
    if (!recipientId) {
      return res
        .status(401)
        .json({ success: false, message: 'Authentication required' });
    }
    const result = await Notification.updateMany(
      { recipientId, isRead: false },
      { $set: { isRead: true } }
    );
    res.json({
      success: true,
      updated: result.modifiedCount ?? 0,
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

module.exports = {
  listMyNotifications,
  markOneRead,
  markAllRead,
};

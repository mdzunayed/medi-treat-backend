const mongoose = require('mongoose');

// Per-user notification record. One row per delivery — so the same
// event (e.g. "doctor assigned") that needs to land on both the
// patient and the doctor is written twice with the two different
// `recipientId` values. `senderId` is null for system-broadcast events
// (server-generated).
const NotificationSchema = new mongoose.Schema(
  {
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      default: null,
    },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    type: {
      type: String,
      enum: ['appointment', 'chat', 'payment', 'system_broadcast'],
      required: true,
      index: true,
    },
    // Free-form structured payload — links, ids, deep-link destinations.
    // The Flutter side uses `payload.appointmentId` to push directly to
    // the tracking screen, `payload.threadId` to open the chat, etc.
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    isRead: { type: Boolean, default: false, index: true },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  {
    toJSON: {
      versionKey: false,
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        ret.recipientId = ret.recipientId?.toString();
        ret.senderId = ret.senderId?.toString() || null;
        delete ret._id;
        return ret;
      },
    },
  }
);

// Compound index covering the hub list query (recipient + timestamp DESC).
NotificationSchema.index({ recipientId: 1, timestamp: -1 });

module.exports = mongoose.model('Notification', NotificationSchema);

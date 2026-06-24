const mongoose = require('mongoose');

// Chat messages exchanged between a patient and the doctor assigned to
// their care request. One document per message — the appointment id is
// indexed so the history endpoint can stream a single visit's log
// quickly even when the global `messages` collection grows large.
const MessageSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CareRequest',
      required: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },
    messageText: {
      type: String,
      required: true,
      trim: true,
      maxlength: 4000,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  {
    // Match the rest of the codebase: `toJSON` flattens `_id` and strips
    // the Mongo `__v` so clients see a clean shape.
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform: (_doc, ret) => {
        ret.id = ret._id?.toString();
        ret.appointmentId = ret.appointmentId?.toString();
        ret.senderId = ret.senderId?.toString();
        ret.receiverId = ret.receiverId?.toString();
        delete ret._id;
        return ret;
      },
    },
  }
);

// Compound index for the history query (timestamp-ordered by appointment).
MessageSchema.index({ appointmentId: 1, timestamp: 1 });

module.exports = mongoose.model('Message', MessageSchema);

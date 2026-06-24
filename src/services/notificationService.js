// Centralised notification dispatch. Other controllers (chat, admin
// assign, patient request submit, etc.) call `emitNotification(io, …)`
// to (a) persist a Notification row and (b) push the freshly-saved
// document into the recipient's personal Socket.io room so the bell
// badge updates instantly.
//
// Per-user rooms are simply `user:<accountId>`. The Socket.io
// connection handler in server.js joins each socket to this room on
// the `register_user` event so the lookup here is just a single
// `io.to(...)` emit.

const Notification = require('../models/Notification');

const ALLOWED_TYPES = new Set([
  'appointment',
  'chat',
  'payment',
  'system_broadcast',
]);

function userRoomFor(accountId) {
  return `user:${String(accountId)}`;
}

// Role broadcast rooms — `room:doctors`, `room:nurses`, `room:admins`,
// `room:patients`. Authenticated sockets are auto-joined to their role room
// on the JWT handshake (see server.js) so a single `io.to(roleRoomFor(role))`
// reaches every signed-in member of a role. Unknown roles collapse to a
// harmless `room:users` bucket.
function roleRoomFor(role) {
  const r = String(role || '').toLowerCase();
  switch (r) {
    case 'doctor':
      return 'room:doctors';
    case 'nurse':
      return 'room:nurses';
    case 'admin':
      return 'room:admins';
    case 'patient':
      return 'room:patients';
    default:
      return 'room:users';
  }
}

async function emitNotification(io, opts) {
  const {
    recipientId,
    senderId = null,
    title,
    body,
    type,
    payload = {},
  } = opts || {};

  if (!recipientId) throw new Error('emitNotification: recipientId required');
  if (!title) throw new Error('emitNotification: title required');
  if (!body) throw new Error('emitNotification: body required');
  if (!ALLOWED_TYPES.has(type)) {
    throw new Error(`emitNotification: invalid type "${type}"`);
  }

  const doc = await Notification.create({
    recipientId,
    senderId,
    title,
    body,
    type,
    payload,
  });
  const json = doc.toJSON();
  if (io) {
    io.to(userRoomFor(recipientId)).emit('new_notification', json);
  }
  return json;
}

// Best-effort wrapper for controllers that want to fire notifications
// without letting a notification failure tank the originating mutation.
// Logs the error and returns null instead of throwing.
async function safeEmitNotification(io, opts) {
  try {
    return await emitNotification(io, opts);
  } catch (err) {
    console.warn('[notifications] emit failed:', err.message);
    return null;
  }
}

module.exports = {
  userRoomFor,
  roleRoomFor,
  emitNotification,
  safeEmitNotification,
};

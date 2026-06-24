require('dotenv').config();

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { Server: SocketIOServer } = require('socket.io');

const servicesRouter = require('./routes/services');
const authRouter = require('./routes/auth');
const patientRouter = require('./routes/patient');
const adminRouter = require('./routes/admin');
const doctorRouter = require('./routes/doctor');
const appointmentsRouter = require('./routes/appointments');
const usersRouter = require('./routes/users');
const chatRouter = require('./routes/chat.routes');
const notificationRouter = require('./routes/notification.routes');
const prescriptionRouter = require('./routes/prescriptions');
const providerRouter = require('./routes/provider');
const addressRouter = require('./routes/addresses');
const dependentRouter = require('./routes/dependents');
const fcmService = require('./services/fcmService');
const { userRoomFor, roleRoomFor } = require('./services/notificationService');
const { verifyToken } = require('./utils/jwt');
const { notifyChatRecipient } = require('./controllers/chat.controller');
const Account = require('./models/Account');
const Provider = require('./models/Provider');
const Message = require('./models/Message');
const { normalizePhone } = require('./utils/phone');
const { UPLOAD_DIR } = require('./middleware/upload');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/api/services', servicesRouter);
// Auth is exposed under both prefixes:
//   • `/auth/*`     — legacy. The existing DioClient + legacy LoginScreen.
//   • `/api/auth/*` — canonical (matches the new spec).
// Same handlers either way; aliasing keeps in-flight clients happy
// while we migrate.
app.use('/auth', authRouter);
app.use('/api/auth', authRouter);
app.use('/patient', patientRouter);
app.use('/admin', adminRouter);
// Spec-named alias — every admin route is reachable under both
// `/admin/*` and `/api/admin/*`. The new POST /api/admin/appointments/
// assign endpoint lives here.
app.use('/api/admin', adminRouter);
app.use('/doctor', doctorRouter);
// Spec-named alias. Every doctor route is reachable under both
// prefixes — `/doctor/profile-status` and `/api/doctor/profile-status`
// hit the same handlers — so the production-spec URL contract works
// without rewriting any existing call sites.
app.use('/api/doctor', doctorRouter);
// Canonical appointment surface — same domain as care_requests, just
// under the spec's `/api/appointments/*` URL contract.
app.use('/api/appointments', appointmentsRouter);
// User-shaped surface — currently just the avatar upload endpoint;
// future profile-photo-related routes (delete avatar, etc.) live here.
app.use('/api/users', usersRouter);
// Chat history (`GET /api/chat/:appointmentId`) + HTTP fallback send.
// Real-time delivery rides on the Socket.io layer initialised below.
app.use('/api/chat', chatRouter);
// Multi-role notification hub. List + mark-read + bulk-read endpoints;
// live delivery rides on the Socket.io `new_notification` event below.
app.use('/api/notifications', notificationRouter);
// Digital prescription engine — doctor issues, patient reads /
// marks-as-taken. POST /api/prescriptions + GET /my-active +
// PATCH /:id/dose.
app.use('/api/prescriptions', prescriptionRouter);
// Shared provider (doctor / nurse / helper) self-service surface —
// session-resolved availability flip, default-fee update, and the
// settled/pending earnings ledger. Reachable under both prefixes.
app.use('/api/provider', providerRouter);
app.use('/provider', providerRouter);
// Patient lifecycle: saved-address ledger + family/dependents profiles.
app.use('/api/addresses', addressRouter);
app.use('/api/dependents', dependentRouter);

// Best-effort FCM warm-up. No-ops gracefully when the firebase-admin
// SDK or service-account credentials aren't configured.
fcmService.init();

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || 'Server error' });
});

const PORT = Number(process.env.PORT || 4000);
// Matches the database the team actually populates via Compass / Docker
// (collections: accounts, care_requests, providers). Override with the
// MONGO_URI env var for staging / prod.
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/medi_treat';

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log(`[mongo] connected to ${MONGO_URI}`);

    // Self-heal: drop the legacy `email_1` unique index from the
    // `accounts` collection if it's still hanging around. It was added
    // when email was the primary identifier; phone is now, and the
    // non-sparse old index treats every missing-email row as a
    // collision on `null`. The index drop is idempotent — if it
    // doesn't exist we silently move on.
    try {
      await mongoose.connection.db
        .collection('accounts')
        .dropIndex('email_1');
      console.log('[mongo] dropped legacy accounts.email_1 index');
    } catch (e) {
      // 27 = IndexNotFound, 26 = NamespaceNotFound (fresh DB) — both
      // safe to ignore. Anything else gets logged so it doesn't hide.
      if (e.code !== 27 && e.code !== 26) {
        console.warn('[mongo] email_1 drop skipped:', e.message);
      }
    }

    // Self-heal: canonicalise phone fields on every account so the
    // lookups in /auth/{login,verify-otp,reset-password} match
    // regardless of how the user typed their number originally. The
    // most common case: seeded accounts stored `+880 1700 000001`
    // (spaces + plus + leading-zero local prefix); the canonical
    // form is the digits-only international `8801700000001`. Idempotent
    // — rows already in canonical form are skipped without a write.
    try {
      const accounts = await Account.find({}, '_id phone').lean();
      let normalised = 0;
      for (const acc of accounts) {
        if (!acc.phone) continue;
        const canon = normalizePhone(acc.phone);
        if (canon && canon !== acc.phone) {
          await Account.updateOne({ _id: acc._id }, { $set: { phone: canon } });
          normalised++;
        }
      }
      if (normalised > 0) {
        console.log(`[mongo] canonicalised phone on ${normalised} account(s)`);
      }
    } catch (e) {
      console.warn('[mongo] phone canonicalisation skipped:', e.message);
    }

    // Self-heal: link Provider rows to their Account counterparts by
    // copying the Account's `email` onto any doctor-role Provider that
    // doesn't yet have one. This makes `GET /doctor/profile` find the
    // linked Provider via email when the Flutter session sends an
    // Account `_id` (which is the only id the patient/doctor app has
    // at hand). Idempotent — Providers already carrying an email are
    // skipped without a write. Match key: `full_name` + role='doctor'.
    try {
      const doctorAccounts = await Account.find(
        { role: 'doctor' },
        '_id full_name email'
      ).lean();
      let linked = 0;
      for (const acc of doctorAccounts) {
        if (!acc.email) continue;
        const res = await Provider.updateOne(
          {
            full_name: acc.full_name,
            role: 'doctor',
            $or: [{ email: { $exists: false } }, { email: '' }, { email: null }],
          },
          { $set: { email: acc.email } }
        );
        if (res.modifiedCount > 0) linked++;
      }
      if (linked > 0) {
        console.log(
          `[mongo] linked ${linked} provider(s) to their account by email`
        );
      }
    } catch (e) {
      console.warn('[mongo] provider email backfill skipped:', e.message);
    }

    // Explicit http.Server so Socket.io can share the listening port
    // with Express. The `app.listen()` shorthand would create a server
    // we couldn't pass into `new SocketIOServer(server)`.
    const server = http.createServer(app);

    // --- Socket.io engine layer -----------------------------------------
    //
    // One namespace, one event protocol:
    //   • `join_room`     — payload: appointmentId (string). Adds the
    //                       socket to the segregated room so it only
    //                       receives messages for that appointment.
    //   • `send_message`  — payload: { appointmentId, senderId,
    //                       receiverId, messageText }. Persists the row
    //                       and broadcasts `receive_message` with the
    //                       saved document (so every client — sender
    //                       included — sees the same canonical id +
    //                       timestamp).
    //   • `receive_message` — server-emitted; pushed to everyone in the
    //                       appointment room when a new message lands.
    //
    // CORS is wide-open here because the Flutter clients connect from
    // multiple origins (localhost dev, Android emulator, deployed
    // frontend). Tighten in production via the SOCKET_ORIGIN env var.
    const io = new SocketIOServer(server, {
      cors: {
        origin: process.env.SOCKET_ORIGIN || '*',
        methods: ['GET', 'POST'],
      },
    });
    // Expose the IO instance to Express handlers so the HTTP fallback
    // sender in chat.controller.js can broadcast over the socket too.
    app.set('io', io);

    // ── JWT handshake authentication ──────────────────────────────────────
    // Validate the bearer token presented in the connection handshake
    // (`auth.token`, preferred, or `?token=` query). A token that is present
    // but INVALID rejects the stream immediately. A connection with NO token
    // is still allowed through for backward compatibility with the existing
    // anonymous chat client (it identifies itself later via `join_room`);
    // such sockets simply stay unauthenticated until they do.
    io.use((socket, next) => {
      const raw =
        (socket.handshake.auth && socket.handshake.auth.token) ||
        (socket.handshake.query && socket.handshake.query.token) ||
        null;
      if (!raw) return next(); // anonymous (legacy) — allowed
      try {
        const payload = verifyToken(String(raw));
        if (!payload || !payload.sub) {
          return next(new Error('unauthorized'));
        }
        socket.data.accountId = String(payload.sub);
        socket.data.role = payload.role || null;
        return next();
      } catch (_err) {
        return next(new Error('unauthorized'));
      }
    });

    io.on('connection', (socket) => {
      console.log(`[socket] client connected: ${socket.id}`);

      // Track the rooms this socket has joined so the disconnect log
      // is informative even after the socket has left them. Socket.io
      // 4.x auto-cleans room membership on disconnect.
      socket.data.rooms = new Set();

      // Authenticated handshake — auto-join the user's private room and
      // their role broadcast room so dispatch / notification fan-outs reach
      // the right streams without waiting for a `register_user` round-trip.
      if (socket.data.accountId) {
        const userRoom = userRoomFor(socket.data.accountId);
        socket.join(userRoom);
        socket.data.rooms.add(userRoom);
        if (socket.data.role) {
          const role = roleRoomFor(socket.data.role);
          socket.join(role);
          socket.data.rooms.add(role);
        }
        console.log(
          `[socket] ${socket.id} authenticated as ${socket.data.accountId} (${socket.data.role || 'unknown'})`,
        );
      }

      // Per-user channel for notifications. The Flutter app emits
      // `register_user` with the signed-in account id immediately after
      // connecting, which puts this socket into the user's private
      // room. `emitNotification(io, …)` then delivers via
      // `io.to('user:<id>').emit('new_notification', …)`.
      socket.on('register_user', (accountId) => {
        if (!accountId) return;
        const room = userRoomFor(accountId);
        socket.join(room);
        socket.data.rooms.add(room);
        socket.data.accountId = String(accountId);
        console.log(`[socket] ${socket.id} registered as ${accountId}`);
      });

      socket.on('unregister_user', (accountId) => {
        if (!accountId) return;
        const room = userRoomFor(accountId);
        socket.leave(room);
        socket.data.rooms.delete(room);
      });

      socket.on('join_room', (appointmentId) => {
        if (!appointmentId) return;
        const room = String(appointmentId);
        socket.join(room);
        socket.data.rooms.add(room);
        console.log(`[socket] ${socket.id} joined room ${room}`);
      });

      socket.on('leave_room', (appointmentId) => {
        if (!appointmentId) return;
        const room = String(appointmentId);
        socket.leave(room);
        socket.data.rooms.delete(room);
      });

      socket.on('send_message', async (payload, ack) => {
        try {
          const { appointmentId, senderId, receiverId, messageText } =
            payload || {};
          if (
            !mongoose.isValidObjectId(appointmentId) ||
            !mongoose.isValidObjectId(senderId) ||
            !mongoose.isValidObjectId(receiverId)
          ) {
            const err = { ok: false, message: 'Invalid id in send_message' };
            if (typeof ack === 'function') ack(err);
            return;
          }
          const text = (messageText || '').toString().trim();
          if (!text) {
            const err = { ok: false, message: 'messageText is required' };
            if (typeof ack === 'function') ack(err);
            return;
          }

          const saved = await Message.create({
            appointmentId,
            senderId,
            receiverId,
            messageText: text,
          });
          const json = saved.toJSON();
          io.to(String(appointmentId)).emit('receive_message', json);
          // Fan out a `new_notification` to the receiver's private
          // room so their bell badge updates even if they aren't on
          // the chat screen.
          await notifyChatRecipient(io, saved);
          if (typeof ack === 'function') ack({ ok: true, message: json });
        } catch (err) {
          console.error('[socket] send_message failed:', err.message);
          if (typeof ack === 'function') {
            ack({ ok: false, message: err.message || 'Server error' });
          }
        }
      });

      socket.on('disconnect', (reason) => {
        console.log(
          `[socket] client disconnected: ${socket.id} (${reason})`
        );
      });
    });

    // server.listen(PORT, () =>
    //   console.log(`[api] listening on http://localhost:${PORT}`)
    // );

    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
    // Friendly diagnostic when something else is already holding the
    // port. The default Node trace dump leads people to think Express
    // crashed; the real cause is almost always a stale process (often
    // a Docker container — `docker ps` will show it).
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[api] port ${PORT} is already in use.\n` +
          `      Likely causes (in order):\n` +
          `        • A Docker container is mapping it — run \`docker ps\` and \`docker stop <name>\`.\n` +
          `        • A previous \`npm run dev\` didn't shut down cleanly — \`sudo fuser -k ${PORT}/tcp\`.\n`
        );
        process.exit(1);
      }
      console.error('[api] server error:', err);
      process.exit(1);
    });

    // Graceful shutdown. SIGINT (Ctrl+C in your terminal) and SIGTERM
    // (nodemon restart, `kill`, system shutdown) both trigger this so
    // the listening socket + Mongo connection always close cleanly.
    // Without this, an abrupt termination can leak the socket and the
    // next `npm run dev` greets you with EADDRINUSE.
    const shutdown = async (signal) => {
      console.log(`[api] ${signal} received, shutting down…`);
      // Stop accepting new connections; finish in-flight ones.
      await new Promise((resolve) => server.close(resolve));
      await mongoose.connection.close();
      console.log('[api] clean shutdown complete');
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  })
  .catch((err) => {
    console.error('[mongo] connection error:', err.message);
    process.exit(1);
  });

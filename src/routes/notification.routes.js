const express = require('express');
const { attachAccountId } = require('../middleware/auth');
const {
  listMyNotifications,
  markOneRead,
  markAllRead,
} = require('../controllers/notification.controller');

const router = express.Router();

// Identity resolution applies to every route in this surface. The
// individual handlers send a 401 themselves when no recipient could
// be resolved.
router.use(attachAccountId);

router.get('/', listMyNotifications);
router.patch('/read-all', markAllRead);
router.patch('/:id/read', markOneRead);

module.exports = router;

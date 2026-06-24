const express = require('express');
const mongoose = require('mongoose');
const Address = require('../models/Address');
const { requireAccountId } = require('../middleware/auth');

const router = express.Router();

// Coerce an incoming coordinate to a finite Number, or null. Guards against
// an explicit null / '' becoming a bogus 0,0 fix.
function coordOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Build the writable field patch from a request body (shared by create + update).
function pickAddressFields(b) {
  const out = {};
  if (b.label !== undefined) out.label = String(b.label).trim() || 'Home';
  if (b.full_address_text !== undefined) {
    out.full_address_text = String(b.full_address_text).trim();
  }
  if (b.flat_floor_holding !== undefined) {
    out.flat_floor_holding = String(b.flat_floor_holding).trim();
  }
  if (b.landmark_instructions !== undefined) {
    out.landmark_instructions = String(b.landmark_instructions).trim();
  }
  if (b.latitude !== undefined) out.latitude = coordOrNull(b.latitude);
  if (b.longitude !== undefined) out.longitude = coordOrNull(b.longitude);
  return out;
}

// GET /api/addresses — the signed-in patient's saved addresses, default first.
router.get('/', requireAccountId, async (req, res) => {
  try {
    const rows = await Address.find({ account_id: req.accountId }).sort({
      is_default: -1,
      updated_at: -1,
    });
    res.json({ success: true, addresses: rows.map((r) => r.toJSON()) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/addresses — create. If the body asks for default (or this is the
// account's first address), it becomes the sole default.
router.post('/', requireAccountId, async (req, res) => {
  try {
    const b = req.body || {};
    const fields = pickAddressFields(b);
    const existingCount = await Address.countDocuments({
      account_id: req.accountId,
    });
    const makeDefault = b.is_default === true || existingCount === 0;
    if (makeDefault) {
      await Address.updateMany(
        { account_id: req.accountId },
        { $set: { is_default: false } },
      );
    }
    const doc = await Address.create({
      account_id: req.accountId,
      ...fields,
      is_default: makeDefault,
    });
    res.status(201).json({ success: true, address: doc.toJSON() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/addresses/:id — edit fields (ownership-scoped).
router.patch('/:id', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const doc = await Address.findOne({ _id: id, account_id: req.accountId });
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Address not found' });
    }
    Object.assign(doc, pickAddressFields(req.body || {}));
    await doc.save();
    res.json({ success: true, address: doc.toJSON() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/addresses/:id/default — atomically make this the sole default.
router.patch('/:id/default', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const target = await Address.findOne({ _id: id, account_id: req.accountId });
    if (!target) {
      return res.status(404).json({ success: false, message: 'Address not found' });
    }
    await Address.updateMany(
      { account_id: req.accountId },
      { $set: { is_default: false } },
    );
    target.is_default = true;
    await target.save();
    res.json({ success: true, address: target.toJSON() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/addresses/:id — remove (ownership-scoped). If the deleted row
// was the default and others remain, promote the most-recent to default so an
// account is never left without one.
router.delete('/:id', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const doc = await Address.findOneAndDelete({
      _id: id,
      account_id: req.accountId,
    });
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Address not found' });
    }
    if (doc.is_default) {
      const next = await Address.findOne({ account_id: req.accountId }).sort({
        updated_at: -1,
      });
      if (next) {
        next.is_default = true;
        await next.save();
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

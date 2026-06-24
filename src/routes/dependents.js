const express = require('express');
const mongoose = require('mongoose');
const Dependent = require('../models/Dependent');
const { requireAccountId } = require('../middleware/auth');

const router = express.Router();

const GENDERS = new Set(['male', 'female', 'other', 'unspecified']);
const RELATIONSHIPS = new Set([
  'parent',
  'child',
  'spouse',
  'sibling',
  'other',
]);

function pickDependentFields(b) {
  const out = {};
  if (b.full_name !== undefined) out.full_name = String(b.full_name).trim();
  if (b.date_of_birth !== undefined) {
    out.date_of_birth = String(b.date_of_birth).trim();
  }
  if (b.gender !== undefined) {
    const g = String(b.gender).toLowerCase();
    out.gender = GENDERS.has(g) ? g : 'unspecified';
  }
  if (b.relationship_tag !== undefined) {
    const r = String(b.relationship_tag).toLowerCase();
    out.relationship_tag = RELATIONSHIPS.has(r) ? r : 'other';
  }
  if (b.critical_allergies_medical_history !== undefined) {
    out.critical_allergies_medical_history = String(
      b.critical_allergies_medical_history,
    ).trim();
  }
  return out;
}

// GET /api/dependents — the signed-in patient's saved family members.
router.get('/', requireAccountId, async (req, res) => {
  try {
    const rows = await Dependent.find({
      parent_account_id: req.accountId,
    }).sort({ created_at: 1 });
    res.json({ success: true, dependents: rows.map((r) => r.toJSON()) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/dependents — add a family member. `full_name` is required.
router.post('/', requireAccountId, async (req, res) => {
  try {
    const fields = pickDependentFields(req.body || {});
    if (!fields.full_name) {
      return res
        .status(400)
        .json({ success: false, message: 'full_name is required' });
    }
    const doc = await Dependent.create({
      parent_account_id: req.accountId,
      ...fields,
    });
    res.status(201).json({ success: true, dependent: doc.toJSON() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/dependents/:id — edit (ownership-scoped).
router.patch('/:id', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const doc = await Dependent.findOne({
      _id: id,
      parent_account_id: req.accountId,
    });
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: 'Dependent not found' });
    }
    Object.assign(doc, pickDependentFields(req.body || {}));
    await doc.save();
    res.json({ success: true, dependent: doc.toJSON() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/dependents/:id — remove (ownership-scoped).
router.delete('/:id', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }
    const doc = await Dependent.findOneAndDelete({
      _id: id,
      parent_account_id: req.accountId,
    });
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: 'Dependent not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

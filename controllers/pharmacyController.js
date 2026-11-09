const Pharmacy = require('../models/Pharmacy');
const Medicine = require('../models/Medicine');
const Inventory = require('../models/Inventory');
const asyncHandler = require('../utils/asyncHandler');
const { parseRadius } = require('../utils/radius');

// A row counts as available if the shop said so, or (legacy rows written before
// tri-state existed) if it still carries a positive count.
const AVAILABLE = { $or: [{ status: 'in_stock' }, { status: { $exists: false }, stock: { $gt: 0 } }] };

// GET /api/pharmacies  — list all (for the landing-page map)
exports.list = asyncHandler(async (_req, res) => {
  const items = await Pharmacy.find().limit(2000);
  res.json(items);
});

// GET /api/pharmacies/:id  — single pharmacy details
exports.getById = asyncHandler(async (req, res) => {
  const p = await Pharmacy.findById(req.params.id);
  if (!p) return res.status(404).json({ message: 'Pharmacy not found' });
  res.json(p);
});

// GET /api/pharmacies/nearby?lat=..&lon=..&radius=5000
exports.nearby = asyncHandler(async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = parseRadius(req.query.radius); // metres
  if (Number.isNaN(lat) || Number.isNaN(lon))
    return res.status(400).json({ message: 'lat and lon are required' });

  const items = await Pharmacy.find({
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: [lon, lat] },
        $maxDistance: radius,
      },
    },
  }).limit(100);
  res.json(items);
});

// GET /api/pharmacies/medicines/nearby?name=..&lat=..&lon=..&radius=5000
exports.nearbyMedicine = asyncHandler(async (req, res) => {
  const name = (req.query.name || '').trim();
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = parseRadius(req.query.radius);
  if (!name) return res.status(400).json({ message: 'medicine name is required' });
  if (Number.isNaN(lat) || Number.isNaN(lon))
    return res.status(400).json({ message: 'lat and lon are required' });

  // 1. Find matching medicine SKUs by name or brand or sku
  const meds = await Medicine.find({
    $or: [
      { name: { $regex: name, $options: 'i' } },
      { brand: { $regex: name, $options: 'i' } },
      { sku: { $regex: name, $options: 'i' } },
    ],
  }).select('_id sku name');
  if (!meds.length) return res.json([]);
  const skus = meds.map((m) => m.sku);

  // 2. Find pharmacies within radius
  const nearbyIds = await Pharmacy.find({
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: [lon, lat] },
        $maxDistance: radius,
      },
    },
  }).distinct('_id');

  // 3. Join via inventory
  const inv = await Inventory.find({
    sku: { $in: skus },
    pharmacy: { $in: nearbyIds },
    ...AVAILABLE,
  }).populate('pharmacy').populate('medicine');

  res.json(inv);
});

// GET /api/v1/pharmacies/:id/inventory
exports.inventory = asyncHandler(async (req, res) => {
  const inv = await Inventory.find({ pharmacy: req.params.id }).populate('medicine');
  res.json(inv);
});

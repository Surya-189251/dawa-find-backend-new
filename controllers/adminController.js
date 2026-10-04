const Pharmacy = require('../models/Pharmacy');
const Inventory = require('../models/Inventory');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /api/v1/admin/pharmacies?status=pending
exports.listPharmacies = asyncHandler(async (req, res) => {
  const filter = {};

  if (req.query.status) {
    filter.verificationStatus = req.query.status;
  }

  if (req.query.source) {
    filter.source = req.query.source;
  }

  const items = await Pharmacy.find(filter)
    .populate('owner', 'name email phone')
    .sort({ createdAt: -1 })
    .limit(200);

  res.json({
    count: items.length,
    items,
  });
});

// GET /api/v1/admin/users
// Optional query params:
//   role=user|pharmacy|admin
//   q=name/email/phone text search
//   limit=1..500
exports.listUsers = asyncHandler(async (req, res) => {
  const filter = {};

  const allowedRoles = ['user', 'pharmacy', 'admin'];

  if (req.query.role) {
    if (!allowedRoles.includes(req.query.role)) {
      return res.status(400).json({
        message: 'role must be user, pharmacy, or admin',
      });
    }

    filter.role = req.query.role;
  }

  const search = String(req.query.q || '').trim();

  if (search) {
    const safeSearch = escapeRegex(search);
    const pattern = new RegExp(safeSearch, 'i');

    filter.$or = [
      { name: pattern },
      { email: pattern },
      { phone: pattern },
    ];
  }

  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.floor(requestedLimit), 1), 500)
    : 300;

  const [items, roleRows, total] = await Promise.all([
    User.find(filter)
      .select('name email phone role pharmacy createdAt updatedAt')
      .populate(
        'pharmacy',
        'name address licenceNo verificationStatus'
      )
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),

    User.aggregate([
      {
        $group: {
          _id: '$role',
          n: { $sum: 1 },
        },
      },
    ]),

    User.countDocuments({}),
  ]);

  const roleCounts = {
    total,
    user: 0,
    pharmacy: 0,
    admin: 0,
  };

  roleRows.forEach((row) => {
    if (allowedRoles.includes(row._id)) {
      roleCounts[row._id] = row.n;
    }
  });

  res.json({
    count: items.length,
    roleCounts,
    items,
  });
});

// PATCH /api/v1/admin/pharmacies/:id/verify
// Body: { decision: 'verified' | 'rejected', reason? }
exports.verifyPharmacy = asyncHandler(async (req, res) => {
  const decision = req.body.decision || 'verified';

  if (!['verified', 'rejected'].includes(decision)) {
    return res.status(400).json({
      message: "decision must be 'verified' or 'rejected'",
    });
  }

  const shop = await Pharmacy.findById(req.params.id);

  if (!shop) {
    return res.status(404).json({
      message: 'Pharmacy not found',
    });
  }

  shop.verificationStatus = decision;
  shop.verifiedAt = new Date();
  shop.verifiedBy = req.user._id;

  if (decision === 'rejected') {
    shop.rejectionReason = req.body.reason || 'Not specified';
  } else {
    shop.rejectionReason = undefined;
  }

  await shop.save();

  res.json(shop);
});

// GET /api/v1/admin/metrics
// Admin dashboard statistics
exports.metrics = asyncHandler(async (_req, res) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    byVerification,
    byInventoryStatus,
    freshRows,
    totalInventoryRows,
    activeShops,
    totalPharmacies,
  ] = await Promise.all([
    Pharmacy.aggregate([
      {
        $group: {
          _id: '$verificationStatus',
          n: { $sum: 1 },
        },
      },
    ]),

    Inventory.aggregate([
      {
        $group: {
          _id: '$status',
          n: { $sum: 1 },
        },
      },
    ]),

    Inventory.countDocuments({
      lastUpdatedAt: { $gte: dayAgo },
      status: { $ne: 'unknown' },
    }),

    Inventory.countDocuments({}),

    Inventory.distinct('pharmacy', {
      lastUpdatedAt: { $gte: dayAgo },
    }),

    Pharmacy.countDocuments({}),
  ]);

  const toMap = (rows) =>
    rows.reduce(
      (result, row) => ({
        ...result,
        [row._id || 'none']: row.n,
      }),
      {}
    );

  const pharmacyStats = toMap(byVerification);
  const inventoryStats = toMap(byInventoryStatus);

  const pending = pharmacyStats.pending || 0;
  const unverified = pharmacyStats.unverified || 0;
  const verified = pharmacyStats.verified || 0;
  const rejected = pharmacyStats.rejected || 0;

  const needsAttention = pending + unverified;

  const verificationRate =
    totalPharmacies > 0
      ? Math.round((verified / totalPharmacies) * 100)
      : 0;

  const percentFresh =
    totalInventoryRows > 0
      ? Math.round((freshRows / totalInventoryRows) * 100)
      : 0;

  res.json({
    pharmacies: {
      total: totalPharmacies,
      pending,
      unverified,
      verified,
      rejected,
      needsAttention,
      verificationRate,
    },

    inventory: inventoryStats,

    freshness: {
      rowsUpdatedLast24h: freshRows,
      totalRows: totalInventoryRows,
      percentFresh,
      shopsActiveLast24h: activeShops.length,
    },
  });
});

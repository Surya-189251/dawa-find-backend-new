const router = require('express').Router();
const { protect, restrictTo } = require('../middleware/auth');
const c = require('../controllers/adminController');

router.use(protect, restrictTo('admin'));

router.get('/pharmacies', c.listPharmacies);
router.get('/users', c.listUsers);
router.patch('/pharmacies/:id/verify', c.verifyPharmacy);
router.get('/metrics', c.metrics);

module.exports = router;

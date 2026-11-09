const jwt = require('jsonwebtoken');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    pharmacy: user.pharmacy,
  };
}

exports.register = asyncHandler(async (req, res) => {
  const { name, password, phone, role } = req.body;
  // Emails are stored lower-cased (see models/User.js), so normalise before
  // looking them up or 'Ravi@Gmail.com' can never log in again.
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!name || !email || !password)
    return res.status(400).json({ message: 'name, email, password are required' });

  // Self-serve signup may only create customers or pharmacy partners.
  // Admins are created by scripts/seedAdmin, never over the wire.
  const requestedRole = role || 'user';
  if (!['user', 'pharmacy'].includes(requestedRole))
    return res.status(400).json({ message: "role must be 'user' or 'pharmacy'" });

  const exists = await User.findOne({ email });
  if (exists) return res.status(409).json({ message: 'Email already registered' });

  const user = await User.create({ name, email, password, phone, role: requestedRole });
  res.status(201).json({ token: signToken(user._id), user: publicUser(user) });
});

exports.login = asyncHandler(async (req, res) => {
  const { password } = req.body;
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ message: 'Invalid credentials' });
  const ok = await user.matchPassword(password);
  if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
  res.json({ token: signToken(user._id), user: publicUser(user) });
});

// Stateless JWT: logout is client-side (drop the token).
// Endpoint kept so the frontend can POST /logout uniformly.
exports.logout = asyncHandler(async (_req, res) => {
  res.json({ message: 'Logged out' });
});

exports.me = asyncHandler(async (req, res) => {
  res.json({ user: publicUser(req.user) });
});

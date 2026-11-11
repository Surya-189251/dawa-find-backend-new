const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6 },
    phone: { type: String, trim: true },
    // user     — B2C customer searching for medicine
    // pharmacy — B2B partner who owns a shop and maintains its inventory
    // admin    — verifies licences, sees metrics
    role: {
      type: String,
      enum: ['user', 'pharmacy', 'admin'],
      default: 'user',
      index: true,
    },
    // Set once a pharmacy-role user has registered their shop.
    pharmacy: { type: mongoose.Schema.Types.ObjectId, ref: 'Pharmacy', default: null },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = function (entered) {
  // A missing password is simply a failed login, not a bcrypt crash (500).
  if (typeof entered !== 'string' || !entered) return Promise.resolve(false);
  return bcrypt.compare(entered, this.password);
};

module.exports = mongoose.model('User', userSchema);

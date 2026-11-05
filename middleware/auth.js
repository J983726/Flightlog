// Every route registered after this middleware needs a logged-in session.
module.exports = function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.redirect('/login');
};

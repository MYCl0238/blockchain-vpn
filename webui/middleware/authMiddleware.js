export function requireLogin(req, res, next) {
  if (!req.session.loggedIn) {
    return res.redirect("/auth/login");
  }
  next();
}

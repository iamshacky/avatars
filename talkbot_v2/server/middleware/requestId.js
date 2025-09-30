/*
export const requestIdMw = () => (req, _res, next) => {
  req.id = req.headers['x-request-id'] || Math.random().toString(36).slice(2);
  next();
};
*/

// Return an X-Request-Id header so you can match browser errors to server logs.
export const requestIdMw = () => (req, res, next) => {
  req.id = req.headers['x-request-id'] || Math.random().toString(36).slice(2);
  res.setHeader('X-Request-Id', req.id); // ← add this line
  next();
};

export const errorMw = () => (err, _req, res, _next) => {
  console.error('ERR:', err);
  res.status(err.status || 500).json({ ok: false, error: String(err?.message || err) });
};

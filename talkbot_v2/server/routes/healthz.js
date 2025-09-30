export const healthzRoute = (req, res) => {
  res.json({ ok: true, provider: 'openai', ts: Date.now() });
};

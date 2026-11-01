// POST /api/anchor -- hosted anchoring. See _lib/hosted.js.
const { handleAnchor } = require("./_lib/hosted");
const { config, send } = require("./_lib/env");

module.exports = async (req, res) => {
  let cfg;
  try {
    cfg = config();
    if (!cfg.signer) throw new Error("no key");
  } catch (e) {
    return send(res, { status: 503, body: { error: "hosted anchoring is not configured" } });
  }
  send(res, await handleAnchor({ method: req.method, headers: req.headers, body: req.body }, cfg));
};

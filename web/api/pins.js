// GET /api/pins?logId=0x… -- the pins we publish for a hosted log.
const { handlePins } = require("./_lib/hosted");
const { config, send } = require("./_lib/env");

module.exports = async (req, res) => {
  let cfg;
  try {
    cfg = config();
    if (!cfg.anchorer) throw new Error("no anchorer");
  } catch (e) {
    return send(res, { status: 503, body: { error: "hosted anchoring is not configured" } });
  }
  send(res, await handlePins({ method: req.method, query: req.query }, cfg));
};

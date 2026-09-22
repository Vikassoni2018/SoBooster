const crypto = require("crypto");
const { normalizeShopDomain } = require("../utils/shop");

const MAX_CLOCK_SKEW_SECONDS = 300;

function proxySignature(url, secret) {
  const values = new Map();

  url.searchParams.forEach((value, key) => {
    if (key === "signature") return;
    const current = values.get(key) || [];
    current.push(value);
    values.set(key, current);
  });

  const message = [...values.entries()]
    .map(([key, entries]) => `${key}=${entries.join(",")}`)
    .sort()
    .join("");

  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyAppProxy(req, res, next) {
  const url = new URL(req.originalUrl, "https://app.invalid");
  const signature = url.searchParams.get("signature");
  const timestamp = Number(url.searchParams.get("timestamp"));
  const shop = normalizeShopDomain(url.searchParams.get("shop"));
  const expected = proxySignature(url, process.env.SHOPIFY_API_SECRET || "");
  const now = Math.floor(Date.now() / 1000);

  if (
    !signature ||
    !shop ||
    !Number.isFinite(timestamp) ||
    Math.abs(now - timestamp) > MAX_CLOCK_SKEW_SECONDS ||
    !safeEqual(signature, expected)
  ) {
    return res.status(401).json({ error: "Invalid app proxy request" });
  }

  req.shop = shop;
  return next();
}

module.exports = { verifyAppProxy, proxySignature, MAX_CLOCK_SKEW_SECONDS };

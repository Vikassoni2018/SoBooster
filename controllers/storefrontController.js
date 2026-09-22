const storeModel = require("../models/storeModel");
const {
  buildPublishedFilters,
  configEtag,
} = require("../services/publishedFilters");

exports.getFilters = async (req, res) => {
  try {
    const store = await storeModel.findByDomain(req.shop);

    if (!store || !store.is_active) {
      return res.status(404).json({ error: "Filter configuration not found" });
    }

    const config = await buildPublishedFilters(store.id, req.shop);
    const etag = configEtag(config);

    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.setHeader("ETag", etag);

    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    return res.json(config);
  } catch (err) {
    console.error("Storefront filter configuration failed:", err.message);
    return res.status(500).json({ error: "Could not load filter configuration" });
  }
};

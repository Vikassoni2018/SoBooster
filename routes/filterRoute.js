const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const filters = require("../controllers/filterController");

// Every route here is behind a verified Shopify session token, so req.storeId
// is the only store this request may read or write.
router.use(requireSession);

/* The screen. */
router.get("/", filters.getFilters);

/* The whole configuration, re-read after any change. */
router.get("/config", filters.getConfig);

/* What a storefront would consume: enabled groups, visible values, nothing
   else to decide. */
router.get("/published", filters.getPublicConfig);

/* Re-read the merchant's catalogue from Shopify. POST because it spends the
   shop's API rate limit -- this is an action, not a page a browser may
   prefetch or a proxy may repeat. */
router.post("/refresh", filters.refresh);

/* Groups. Reorder is declared before "/:id" so it is not read as an id. */
router.post("/groups", filters.createGroup);
router.post("/groups/reorder", filters.reorderGroups);
router.patch("/groups/:id", filters.updateGroup);
router.delete("/groups/:id", filters.deleteGroup);

/* Per-value overrides within a group. */
router.post("/groups/:id/options", filters.setOption);
router.post("/groups/:id/options/reset", filters.resetOptions);

module.exports = router;

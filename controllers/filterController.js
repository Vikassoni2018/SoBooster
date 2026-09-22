// controllers/filterController.js
//
// The Filter Settings screen: where the merchant decides which filters their
// storefront offers, what they are called, how they render, and which values
// appear.
//
// The screen renders once; every change after that is a small JSON call, so
// toggling one filter does not reload the page or lose the merchant's place.
const filterModel = require("../models/filterModel");
const catalogue = require("../services/shopifyCatalog");
const { buildPublishedFilters } = require("../services/publishedFilters");

/** Never leak an internal message; a ValidationError is written for a human. */
function fail(res, err, fallback) {
  const status = err.statusCode || 500;

  if (status >= 500) console.error(`${fallback}:`, err.message);

  return res.status(status).json({
    error: err.statusCode ? err.message : fallback,
  });
}

/**
 * First load.
 *
 * Three things have to be true before the screen is useful, and all three are
 * done here rather than being left to the merchant:
 *
 *   1. the store has its default groups
 *   2. the catalogue has been read from Shopify at least once
 *   3. the option names the shop actually uses are known, so "Color" can be
 *      offered as a filter without the merchant typing it
 */
exports.getFilters = async (req, res) => {
  try {
    await filterModel.ensureDefaults(req.storeId);

    // Only on a cold store. After that the merchant refreshes deliberately --
    // an Admin API round trip on every page load would be slow and would spend
    // the shop's rate limit for nothing.
    const seen = await filterModel.readCache(req.storeId, "option_catalogue", "");

    if (!seen) {
      try {
        await filterModel.refreshFromShopify(req.shop, req.storeId);
      } catch (err) {
        // A shop that cannot be read yet still gets a working screen; the
        // Refresh button reports the real problem.
        console.warn(`First catalogue read failed for ${req.shop}: ${err.message}`);
      }
    }

    const [groups, sources] = await Promise.all([
      filterModel.listGroupsWithValues(req.storeId),
      availableSources(req.storeId),
    ]);

    res.render("filters", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      groups,
      sources,
      allowedDisplay: filterModel.ALLOWED_DISPLAY,
    });
  } catch (err) {
    console.error("Filter settings failed:", err.message);
    res.status(500).send("Error loading filter settings");
  }
};

/**
 * What the merchant can build a new group from.
 *
 * Read out of the cache rather than from Shopify: the option names and tag
 * prefixes on offer are exactly the ones the last refresh found, so the list
 * cannot suggest a filter whose values would come back empty.
 */
async function availableSources(storeId) {
  const [optionCache, tagCache] = await Promise.all([
    filterModel.readCache(storeId, "option_catalogue", ""),
    filterModel.readCache(storeId, "tag", ""),
  ]);

  const options = Object.entries(optionCache?.values || {}).map(
    ([name, values]) => ({ name, count: values.length })
  );

  const tags = (tagCache?.values || []).map((entry) =>
    typeof entry === "string" ? entry : entry.value
  );

  return {
    options: options.sort((a, b) => b.count - a.count),
    tagPrefixes: catalogue.suggestTagPrefixes(tags),
    fetchedAt: optionCache?.fetchedAt || null,
  };
}

/** The whole configuration, for the screen to re-render after a change. */
exports.getConfig = async (req, res) => {
  try {
    const [groups, sources] = await Promise.all([
      filterModel.listGroupsWithValues(req.storeId),
      availableSources(req.storeId),
    ]);

    return res.json({ groups, sources });
  } catch (err) {
    return fail(res, err, "Could not load your filters.");
  }
};

exports.createGroup = async (req, res) => {
  try {
    await filterModel.createGroup(req.storeId, req.body || {});
    return exports.getConfig(req, res);
  } catch (err) {
    return fail(res, err, "Could not add that filter.");
  }
};

exports.updateGroup = async (req, res) => {
  try {
    await filterModel.updateGroup(req.storeId, Number(req.params.id), req.body || {});
    return exports.getConfig(req, res);
  } catch (err) {
    return fail(res, err, "Could not save that filter.");
  }
};

exports.deleteGroup = async (req, res) => {
  try {
    await filterModel.deleteGroup(req.storeId, Number(req.params.id));
    return exports.getConfig(req, res);
  } catch (err) {
    return fail(res, err, "Could not remove that filter.");
  }
};

exports.reorderGroups = async (req, res) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : [];
    await filterModel.reorderGroups(req.storeId, order);
    return exports.getConfig(req, res);
  } catch (err) {
    return fail(res, err, "Could not reorder your filters.");
  }
};

exports.setOption = async (req, res) => {
  try {
    await filterModel.setOption(
      req.storeId,
      Number(req.params.id),
      req.body?.value,
      req.body || {}
    );
    return exports.getConfig(req, res);
  } catch (err) {
    return fail(res, err, "Could not save that value.");
  }
};

exports.resetOptions = async (req, res) => {
  try {
    await filterModel.resetOptions(req.storeId, Number(req.params.id));
    return exports.getConfig(req, res);
  } catch (err) {
    return fail(res, err, "Could not reset that filter.");
  }
};

/**
 * Re-read the catalogue from Shopify.
 *
 * Reports which sources came back and which did not, rather than a bare
 * success: a shop where collections failed but vendors worked is a real state,
 * and the merchant needs to be told which half they are looking at.
 */
exports.refresh = async (req, res) => {
  try {
    const report = await filterModel.refreshFromShopify(req.shop, req.storeId);
    const [groups, sources] = await Promise.all([
      filterModel.listGroupsWithValues(req.storeId),
      availableSources(req.storeId),
    ]);

    return res.json({ groups, sources, report });
  } catch (err) {
    return fail(res, err, "Could not read your Shopify catalogue.");
  }
};

/**
 * The configuration a storefront would consume.
 *
 * Disabled groups and hidden values are already gone, so the consumer renders
 * what it is given without re-deciding anything. Nothing here is specific to
 * the settings screen -- this is the contract the rest of the app would build
 * against.
 */
exports.getPublicConfig = async (req, res) => {
  try {
    return res.json(await buildPublishedFilters(req.storeId, req.shop));
  } catch (err) {
    return fail(res, err, "Could not load the filter configuration.");
  }
};

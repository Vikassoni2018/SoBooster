const filterModel = require("../models/filterModel");

exports.getDashboard = async (req, res) => {
  try {
    const groups = await filterModel.listGroupsWithValues(req.store.id);
    const enabledGroups = groups.filter((group) => group.is_enabled);
    const visibleValues = enabledGroups.reduce(
      (total, group) =>
        total + group.values.filter((value) => !value.is_hidden && !value.missing).length,
      0
    );

    res.render("dashboard", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
      stats: {
        totalFilters: groups.length,
        enabledFilters: enabledGroups.length,
        visibleValues,
      },
    });
  } catch (err) {
    console.error("Dashboard load failed:", err.message);
    res.status(500).send("Error loading dashboard");
  }
};

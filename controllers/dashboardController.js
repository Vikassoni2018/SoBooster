// controllers/dashboardController.js
//
// The landing screen. Deliberately empty for now -- it renders the shell and
// nothing else, so the first real feature has somewhere obvious to land.
exports.getDashboard = async (req, res) => {
  try {
    res.render("dashboard", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
    });
  } catch (err) {
    console.error("Dashboard load failed:", err.message);
    res.status(500).send("Error loading dashboard");
  }
};

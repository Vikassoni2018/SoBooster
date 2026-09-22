// controllers/supportController.js
//
// Help and support. A heading only for now -- the contact details and the
// article list go here when there are some.
exports.getSupport = async (req, res) => {
  try {
    res.render("support", {
      shop: req.shop,
      apiKey: process.env.SHOPIFY_API_KEY,
      store: req.store,
    });
  } catch (err) {
    console.error("Support screen failed:", err.message);
    res.status(500).send("Error loading help and support");
  }
};

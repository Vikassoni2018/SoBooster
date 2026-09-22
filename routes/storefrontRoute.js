const express = require("express");
const { verifyAppProxy } = require("../middleware/verifyAppProxy");
const storefront = require("../controllers/storefrontController");

const router = express.Router();

router.get("/filters", verifyAppProxy, storefront.getFilters);

module.exports = router;

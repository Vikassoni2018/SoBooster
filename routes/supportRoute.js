const express = require("express");
const router = express.Router();

const { requireSession } = require("../middleware/auth");
const { getSupport } = require("../controllers/supportController");

router.get("/", requireSession, getSupport);

module.exports = router;

const express = require("express");
const router = express.Router();

const { verifyWebhook } = require("../middleware/verifyWebhook");
const webhookController = require("../controllers/webhookController");

// Raw body is required to compute the HMAC; it must not be JSON-parsed first.
const rawBody = express.raw({ type: "*/*", limit: "2mb" });

router.post(
  "/app/uninstalled",
  rawBody,
  verifyWebhook,
  webhookController.appUninstalled
);

/* Mandatory privacy webhooks, configured in the Partner Dashboard. */
router.post(
  "/customers/data_request",
  rawBody,
  verifyWebhook,
  webhookController.customersDataRequest
);
router.post(
  "/customers/redact",
  rawBody,
  verifyWebhook,
  webhookController.customersRedact
);
router.post("/shop/redact", rawBody, verifyWebhook, webhookController.shopRedact);
router.post("/compliance", rawBody, verifyWebhook, (req, res) => {
  const topic = String(req.headers["x-shopify-topic"] || "").toLowerCase();
  const handlers = {
    "customers/data_request": webhookController.customersDataRequest,
    "customers/redact": webhookController.customersRedact,
    "shop/redact": webhookController.shopRedact,
  };
  const handler = handlers[topic];
  if (!handler) return res.status(404).send("Unknown webhook topic");
  return handler(req, res);
});

module.exports = router;

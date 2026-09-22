// controllers/webhookController.js
//
// Every handler here runs behind middleware/verifyWebhook, so the request is
// proven to come from Shopify before any of this executes. Handlers reply 200
// first and do their bookkeeping afterwards -- Shopify retries on anything
// that is slow or non-200.
const storeModel = require("../models/storeModel");
const { normalizeShopDomain } = require("../utils/shop");

/* ===================== app/uninstalled ===================== */

exports.appUninstalled = async (req, res) => {
  const shop = normalizeShopDomain(req.webhookShop);

  // Acknowledge first; Shopify does not care about our bookkeeping.
  res.status(200).send("OK");

  if (!shop) {
    console.warn("Uninstall webhook had no usable shop domain");
    return;
  }

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) {
      console.log("Uninstall webhook for unknown shop:", shop);
      return;
    }

    // Deactivates, stamps uninstalled_at and drops the revoked tokens. The row
    // and its subscription history stay, so a reinstall resumes.
    await storeModel.markUninstalled(shop);

    console.log("App uninstalled for", shop);
  } catch (err) {
    console.error("Uninstall webhook processing failed:", err.message);
  }
};

/* ===================== mandatory privacy webhooks ===================== */
/*
 * Shopify requires all three endpoints to exist and to return 200, and checks
 * them during app review.
 *
 * This app stores no customer data at all -- the only personal detail it holds
 * is the shop owner's own email on the store row -- so the two customer topics
 * have nothing to hand over or erase. They are logged rather than silently
 * ignored, so a real request can still be answered by hand if that changes.
 */

exports.customersDataRequest = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};
  const customerId = payload.customer && payload.customer.id;

  console.log(
    `customers/data_request for ${shop || "unknown shop"}: ` +
      `no data is held for customer ${customerId || "unknown"}`
  );
};

exports.customersRedact = async (req, res) => {
  res.status(200).send("OK");

  const shop = normalizeShopDomain(req.webhookShop);
  const payload = req.webhookPayload || {};
  const customerId = payload.customer && payload.customer.id;

  console.log(
    `customers/redact for ${shop || "unknown shop"}: ` +
      `nothing to erase for customer ${customerId || "unknown"}`
  );
};

exports.shopRedact = async (req, res) => {
  const shop = normalizeShopDomain(req.webhookShop);

  res.status(200).send("OK");

  if (!shop) return;

  try {
    const store = await storeModel.findByDomain(shop);

    if (!store) return;

    // Every dependent table is ON DELETE CASCADE, so this also clears the
    // store's memberships and payment records.
    await storeModel.deleteStore(shop);

    console.log("shop/redact completed for", shop);
  } catch (err) {
    console.error("shop/redact processing failed:", err.message);
  }
};

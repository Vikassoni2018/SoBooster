// config/migrate.js
//
// Idempotent schema setup, applied on every boot so a fresh checkout and an
// existing database converge on the same shape.
//
// Order matters: a table has to exist before another table can point a foreign
// key at it. Creation runs parents-first, exactly as listed in runMigrations().
const { query, pool } = require("./db");

const DUPLICATE_COLUMN = "ER_DUP_FIELDNAME";
const DUPLICATE_KEY = "ER_DUP_KEYNAME";
const MISSING_COLUMN = "ER_CANT_DROP_FIELD_OR_KEY";

/** ALTER that shrugs off "already there". */
async function safeAlter(label, sql) {
  try {
    await query(sql);
    console.log(`Migration applied: ${label}`);
  } catch (err) {
    if (err.code === DUPLICATE_COLUMN || err.code === DUPLICATE_KEY) return;
    throw err;
  }
}

/** DROP that shrugs off "already gone". */
async function safeDrop(label, sql) {
  try {
    await query(sql);
    console.log(`Migration applied: ${label}`);
  } catch (err) {
    if (err.code === MISSING_COLUMN) return;
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 1. stores                                                           */
/* ------------------------------------------------------------------ */
// One row per installed Shopify store. Everything else in the schema hangs
// off this table, so it is created first.
const CREATE_STORES = `
  CREATE TABLE IF NOT EXISTS stores (
    id            INT AUTO_INCREMENT PRIMARY KEY,

    shop_domain   VARCHAR(255) NOT NULL,
    store_name    VARCHAR(255) DEFAULT NULL,

    -- AES-256-GCM ciphertext, never plaintext. See utils/crypto.js.
    access_token  TEXT DEFAULT NULL,

    -- Shopify issues EXPIRING offline tokens; without these the app cannot
    -- refresh and every store breaks an hour after install.
    access_token_expires_at  DATETIME DEFAULT NULL,
    refresh_token            TEXT DEFAULT NULL,
    refresh_token_expires_at DATETIME DEFAULT NULL,

    api_version   VARCHAR(16) NOT NULL DEFAULT '2025-01',
    currency      VARCHAR(8) DEFAULT NULL,
    email         VARCHAR(255) DEFAULT NULL,

    is_active     TINYINT(1) NOT NULL DEFAULT 1,
    installed_at  DATETIME DEFAULT NULL,
    uninstalled_at DATETIME DEFAULT NULL,

    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_shop_domain (shop_domain),
    KEY idx_stores_active (is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/**
 * A store used to be tagged as a sync "source" or "destination" and carried a
 * pairing code so two stores could be joined. None of that exists any more, so
 * an older database sheds those columns here rather than keeping dead fields
 * the model no longer writes.
 */
async function dropLegacyStoreColumns() {
  await safeDrop(
    "stores.idx_stores_type_active",
    "ALTER TABLE stores DROP INDEX idx_stores_type_active"
  );
  await safeDrop(
    "stores.idx_stores_group",
    "ALTER TABLE stores DROP INDEX idx_stores_group"
  );
  await safeDrop(
    "stores.uniq_pairing_code",
    "ALTER TABLE stores DROP INDEX uniq_pairing_code"
  );

  for (const column of [
    "store_type",
    "store_group_id",
    "pairing_code",
    "pairing_code_expires_at",
  ]) {
    await safeDrop(
      `stores.${column}`,
      `ALTER TABLE stores DROP COLUMN ${column}`
    );
  }

  await safeAlter(
    "stores.email",
    "ALTER TABLE stores ADD COLUMN email VARCHAR(255) DEFAULT NULL"
  );
}

/* ------------------------------------------------------------------ */
/* 2. dummy_shops                                                      */
/* ------------------------------------------------------------------ */
// Development and review stores. A shop listed here (status = 1) gets a
// Shopify TEST charge when it subscribes, so nobody is billed for real while
// the app is being built or reviewed.
const CREATE_DUMMY_SHOPS = `
  CREATE TABLE IF NOT EXISTS dummy_shops (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    shop_name VARCHAR(255) NULL,
    status    TINYINT(1) NULL DEFAULT 1,
    KEY idx_dummy_shop_active (shop_name, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* 3. plans                                                            */
/* ------------------------------------------------------------------ */
// What a merchant can subscribe to. `plan_content` is a JSON array of the
// bullet points the plans screen lists under each price.
const CREATE_PLANS = `
  CREATE TABLE IF NOT EXISTS plans (
    id                      INT AUTO_INCREMENT PRIMARY KEY,
    name                    VARCHAR(255) NOT NULL,
    price                   DOUBLE NOT NULL DEFAULT 0,
    is_popular              TINYINT(1) NULL DEFAULT 0,
    is_active               TINYINT(1) NULL DEFAULT 1,
    created_at              DATETIME NULL,
    updated_at              DATETIME NULL,
    days                    INT NULL,
    status                  TINYINT(1) NULL DEFAULT 0,
    plan_for                INT NULL,
    plan_content            LONGTEXT NULL,
    max_limit               INT NULL,
    UNIQUE KEY uniq_plan_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* 4. user_memberships + membership_payments                           */
/* ------------------------------------------------------------------ */
// `user_id` is the installed store's id. status = 1 marks the ONE membership
// currently in force; older rows stay at 0 as history.
const CREATE_USER_MEMBERSHIPS = `
  CREATE TABLE IF NOT EXISTS user_memberships (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    user_id       INT NULL,
    membership_id INT NULL,
    created_at    DATETIME NULL,
    updated_at    DATETIME NULL,
    status        TINYINT(1) NULL DEFAULT 1,
    KEY idx_membership_store (user_id, status),
    CONSTRAINT fk_membership_store FOREIGN KEY (user_id)
      REFERENCES stores(id) ON DELETE CASCADE,
    CONSTRAINT fk_membership_plan FOREIGN KEY (membership_id)
      REFERENCES plans(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

// One row per Shopify charge. status: 1 awaiting approval, 2 approved,
// 0 declined or expired.
const CREATE_MEMBERSHIP_PAYMENTS = `
  CREATE TABLE IF NOT EXISTS membership_payments (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    membership_id INT NULL,
    user_id       INT NULL,
    api_client_id BIGINT NULL,
    charge_id     BIGINT NULL,
    date_add      DATETIME NULL,
    date_update   DATETIME NULL,
    status        INT NULL,
    KEY idx_payment_membership (membership_id),
    KEY idx_payment_store (user_id),
    CONSTRAINT fk_payment_membership FOREIGN KEY (membership_id)
      REFERENCES user_memberships(id) ON DELETE CASCADE,
    CONSTRAINT fk_payment_store FOREIGN KEY (user_id)
      REFERENCES stores(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/* ------------------------------------------------------------------ */
/* 5. filter_groups + filter_options + filter_source_cache             */
/* ------------------------------------------------------------------ */
//
// The merchant's filter configuration. This app stores NO products: filter
// values are read live from the merchant's own Shopify catalogue, and what is
// kept here is only the decisions made about them -- which groups exist, what
// they are called, how they render, and which values to show or hide.
//
// Everything is scoped by store_id. A merchant's configuration is theirs, and
// nothing here is shared between shops.

/**
 * One configurable filter group -- Color, Vendor, Price, and so on.
 *
 * `source` says where the VALUES come from, and it is the field the whole
 * design turns on:
 *
 *   vendor | product_type | collection | tag   values come from a shop-level
 *                                              Shopify query
 *   option                                     values come from a product
 *                                              option, named by source_key
 *                                              ("Color", "Size")
 *   tag_prefix                                 a custom group built from tags
 *                                              sharing a prefix, e.g.
 *                                              "material:cotton" -> "Cotton"
 *   price | availability                       computed, no value list
 */
const CREATE_FILTER_GROUPS = `
  CREATE TABLE IF NOT EXISTS filter_groups (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    store_id      INT NOT NULL,

    -- Stable identifier used in the storefront query string (?color=black).
    filter_key    VARCHAR(64) NOT NULL,

    label         VARCHAR(128) NOT NULL,
    source        ENUM('vendor','product_type','collection','tag','option',
                       'tag_prefix','price','availability') NOT NULL,

    -- Which product option or tag prefix this group draws on. NULL for the
    -- sources that need no further pointing.
    source_key    VARCHAR(128) DEFAULT NULL,

    display_type  ENUM('checkbox','swatch','dropdown','button','range')
                    NOT NULL DEFAULT 'checkbox',

    is_enabled    TINYINT(1) NOT NULL DEFAULT 1,
    position      INT NOT NULL DEFAULT 0,

    /* behaviour */
    option_sort   ENUM('manual','alphabetical','count') NOT NULL DEFAULT 'alphabetical',
    collapsed     TINYINT(1) NOT NULL DEFAULT 0,
    max_visible   INT NOT NULL DEFAULT 10,
    hide_empty    TINYINT(1) NOT NULL DEFAULT 1,
    multi_select  TINYINT(1) NOT NULL DEFAULT 1,

    -- A built-in group cannot be deleted, only disabled: deleting Price would
    -- leave a merchant with no way to get it back.
    is_custom     TINYINT(1) NOT NULL DEFAULT 0,

    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_group_key (store_id, filter_key),
    KEY idx_group_order (store_id, position),
    CONSTRAINT fk_group_store FOREIGN KEY (store_id)
      REFERENCES stores(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/**
 * Per-value overrides.
 *
 * A row exists here only when the merchant has said something about that
 * value -- renamed it, hidden it, given it a swatch or pinned it. Values with
 * nothing said about them are not stored at all: the catalogue is the source
 * of truth for what EXISTS, and this table only records what was DECIDED.
 *
 * That is what keeps the table small and keeps a vendor being renamed in
 * Shopify from silently dropping its override.
 */
const CREATE_FILTER_OPTIONS = `
  CREATE TABLE IF NOT EXISTS filter_options (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    group_id    INT NOT NULL,

    -- The raw value exactly as Shopify reports it.
    value       VARCHAR(255) NOT NULL,

    -- Merchant's display override. NULL means "use the raw value".
    label       VARCHAR(255) DEFAULT NULL,

    -- #rrggbb for a swatch group. NULL means fall back to a name lookup.
    swatch      VARCHAR(16) DEFAULT NULL,

    is_hidden   TINYINT(1) NOT NULL DEFAULT 0,

    -- Manual ordering. Lower sorts first; NULL sorts after everything pinned.
    position    INT DEFAULT NULL,

    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_group_value (group_id, value),
    KEY idx_option_order (group_id, position),
    CONSTRAINT fk_option_group FOREIGN KEY (group_id)
      REFERENCES filter_groups(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/**
 * Values last read from Shopify, per store and source.
 *
 * Without this, opening the settings screen would call the Admin API five or
 * six times before anything rendered, and every reload would spend more of the
 * shop's rate limit. The merchant refreshes explicitly; `fetched_at` is shown
 * so they can see how old it is.
 */
const CREATE_FILTER_SOURCE_CACHE = `
  CREATE TABLE IF NOT EXISTS filter_source_cache (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    store_id    INT NOT NULL,
    source      VARCHAR(32) NOT NULL,
    source_key  VARCHAR(128) NOT NULL DEFAULT '',

    -- JSON array of { value, count }. LONGTEXT rather than JSON so the same
    -- DDL works on MariaDB and MySQL alike.
    values_json LONGTEXT NOT NULL,

    fetched_at  DATETIME NOT NULL,

    UNIQUE KEY uniq_source (store_id, source, source_key),
    CONSTRAINT fk_cache_store FOREIGN KEY (store_id)
      REFERENCES stores(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/**
 * The demo catalogue this app used to carry. Filter values now come from the
 * merchant's real Shopify products, so the tables are dropped rather than left
 * behind holding data nothing reads.
 */
async function dropDemoCatalogue() {
  // Child first: product_attributes has a foreign key into products.
  for (const table of ["product_attributes", "products"]) {
    try {
      await query(`DROP TABLE IF EXISTS ${table}`);
    } catch (err) {
      console.warn(`Could not drop ${table}: ${err.message}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Seeds                                                               */
/* ------------------------------------------------------------------ */

/**
 * Placeholder plans, so the plans screen has something to show on a fresh
 * install. Prices and copy are deliberately generic -- replace them with the
 * real offer once there is one.
 *
 * The free plan is where every store starts, so it stays first and stays at 0:
 * a zero-priced plan skips Shopify billing entirely.
 */
const SEED_PLANS = [
  {
    name: "Free",
    price: 0,
    isPopular: 0,
    maxLimit: 25,
    features: ["Core features included", "Up to 25 items", "Email support"],
  },
  {
    name: "Starter",
    price: 9,
    isPopular: 0,
    maxLimit: 250,
    features: ["Everything in Free", "Up to 250 items", "Priority email support"],
  },
  {
    name: "Pro",
    price: 29,
    isPopular: 1,
    maxLimit: 1000,
    features: ["Everything in Starter", "Up to 1,000 items", "Priority support"],
  },
];

async function seedPlans() {
  for (const plan of SEED_PLANS) {
    await query(
      `INSERT INTO plans
        (name, price, is_popular, is_active, created_at, updated_at,
         days, status, plan_for, plan_content, max_limit)
       VALUES (?, ?, ?, 1, NOW(), NOW(), 30, 1, 1, ?, ?)
       ON DUPLICATE KEY UPDATE
         price = VALUES(price),
         is_popular = VALUES(is_popular),
         is_active = 1,
         updated_at = NOW(),
         days = VALUES(days),
         status = VALUES(status),
         plan_for = VALUES(plan_for),
         plan_content = VALUES(plan_content),
         max_limit = VALUES(max_limit)`,
      [
        plan.name,
        plan.price,
        plan.isPopular,
        JSON.stringify(plan.features),
        plan.maxLimit,
      ]
    );
  }
}

/**
 * Development stores, taken from DUMMY_SHOPS in .env as a comma-separated
 * list. Keeping the list in the environment lets a developer add their own
 * test store without editing code, and production simply leaves it empty.
 */
async function seedDummyShops() {
  const shops = String(process.env.DUMMY_SHOPS || "")
    .split(",")
    .map((shop) => shop.trim().toLowerCase())
    .filter(Boolean);

  for (const shop of shops) {
    const [result] = await pool.query(
      "UPDATE dummy_shops SET status = 1 WHERE shop_name = ?",
      [shop]
    );

    if (result.affectedRows === 0) {
      await query("INSERT INTO dummy_shops (shop_name, status) VALUES (?, 1)", [
        shop,
      ]);
      console.log(`Migration: registered ${shop} as a billing test shop`);
    }
  }
}

/* ------------------------------------------------------------------ */

async function runMigrations() {
  // Parents before children -- a foreign key needs its target to exist.
  await query(CREATE_STORES);
  await dropLegacyStoreColumns();
  await query(CREATE_DUMMY_SHOPS);
  await query(CREATE_PLANS);
  await query(CREATE_USER_MEMBERSHIPS);
  await query(CREATE_MEMBERSHIP_PAYMENTS);
  await dropDemoCatalogue();
  await query(CREATE_FILTER_GROUPS);
  await query(CREATE_FILTER_OPTIONS);
  await query(CREATE_FILTER_SOURCE_CACHE);

  await seedPlans();
  await seedDummyShops();
}

module.exports = { runMigrations, safeAlter, safeDrop, SEED_PLANS };

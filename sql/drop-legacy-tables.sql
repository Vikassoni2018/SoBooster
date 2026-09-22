-- Removes the tables from the earlier product-sync version of this app,
-- leaving only the tables the current app uses: stores, dummy_shops, plans,
-- user_memberships and membership_payments.
--
-- DESTRUCTIVE. This permanently deletes the cached products, variants, product
-- mappings, orders, order lines and customer records that the sync features
-- kept. Run it only once you are sure none of that data is needed:
--
--   mysql -u root SoBooster < sql/drop-legacy-tables.sql
--
-- It is deliberately NOT run by config/migrate.js -- a migration should never
-- silently drop a table. (migrate.js does drop the dead sync COLUMNS from
-- `stores`, which hold no data of their own.)

USE SoBooster;

-- Children first: these carry foreign keys into the tables below them.
DROP TABLE IF EXISTS order_mappings;
DROP TABLE IF EXISTS order_line_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS customers;

DROP TABLE IF EXISTS mapping_variant_products;
DROP TABLE IF EXISTS source_variant_mappings;
DROP TABLE IF EXISTS product_mappings;
DROP TABLE IF EXISTS source_products;

DROP TABLE IF EXISTS sync_settings;
DROP TABLE IF EXISTS store_connections;

-- Tables from versions older still. Kept here so one script cleans up any
-- database that has been carried forward.
DROP TABLE IF EXISTS form_submissions;
DROP TABLE IF EXISTS form_fields;
DROP TABLE IF EXISTS forms;
DROP TABLE IF EXISTS page_settings;
DROP TABLE IF EXISTS pages;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS dummy_shop;
DROP TABLE IF EXISTS sync_jobs;
DROP TABLE IF EXISTS sync_logs;
DROP TABLE IF EXISTS webhook_events;

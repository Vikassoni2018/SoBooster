-- Schema for SoBooster.
--
-- config/migrate.js applies the same shape on every boot, so this file is a
-- reference and a fast path for a fresh install rather than the source of
-- truth.
--
--   mysql -u root -p < sql/schema.sql
--
-- Tables are listed in dependency order: a foreign key needs its target table
-- to exist already, so `stores` comes first.
--
-- Rules the DDL encodes, which the app relies on:
--   * one row per installed Shopify store, keyed on shop_domain.
--   * access_token / refresh_token hold AES-256-GCM ciphertext, never
--     plaintext. models/storeModel.js is the only place they are readable.
--   * an uninstall deactivates a store and clears its tokens; the row stays,
--     so a reinstall resumes with its subscription history intact.
--   * a shop listed in dummy_shops (status = 1) gets a Shopify TEST charge
--     instead of a real one -- that is how a development store subscribes.
--   * user_memberships holds one row per plan a store has been on. status = 1
--     marks the ONE currently in force; older rows stay at 0 as history.
--   * membership_payments records the Shopify charge behind a paid plan.
--     status: 1 awaiting approval, 2 approved, 0 declined or expired.
--   * every child cascades on delete, EXCEPT the plan a membership points at:
--     deleting a plan someone is on is refused rather than silently orphaning
--     their subscription.

CREATE DATABASE IF NOT EXISTS SoBooster
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE SoBooster;

CREATE TABLE IF NOT EXISTS `stores` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `shop_domain` varchar(255) NOT NULL,
  `store_name` varchar(255) DEFAULT NULL,
  `access_token` text DEFAULT NULL,
  `access_token_expires_at` datetime DEFAULT NULL,
  `refresh_token` text DEFAULT NULL,
  `refresh_token_expires_at` datetime DEFAULT NULL,
  `api_version` varchar(16) NOT NULL DEFAULT '2025-01',
  `currency` varchar(8) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `installed_at` datetime DEFAULT NULL,
  `uninstalled_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_shop_domain` (`shop_domain`),
  KEY `idx_stores_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Development and review stores: these subscribe with a Shopify TEST charge.
CREATE TABLE IF NOT EXISTS `dummy_shops` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `shop_name` varchar(255) DEFAULT NULL,
  `status` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `idx_dummy_shop_active` (`shop_name`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Subscription data. `user_id` is the installed store's id.
CREATE TABLE IF NOT EXISTS `plans` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `price` double NOT NULL DEFAULT 0,
  `is_popular` tinyint(1) DEFAULT 0,
  `is_active` tinyint(1) DEFAULT 1,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `days` int(11) DEFAULT NULL,
  `status` tinyint(1) DEFAULT 0,
  `plan_for` int(11) DEFAULT NULL,
  `plan_content` longtext DEFAULT NULL,
  `max_limit` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_plan_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `user_memberships` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) DEFAULT NULL,
  `membership_id` int(11) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  `status` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `idx_membership_store` (`user_id`,`status`),
  CONSTRAINT `fk_membership_store` FOREIGN KEY (`user_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_membership_plan` FOREIGN KEY (`membership_id`) REFERENCES `plans` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `membership_payments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `membership_id` int(11) DEFAULT NULL,
  `user_id` int(11) DEFAULT NULL,
  `api_client_id` bigint(20) DEFAULT NULL,
  `charge_id` bigint(20) DEFAULT NULL,
  `date_add` datetime DEFAULT NULL,
  `date_update` datetime DEFAULT NULL,
  `status` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_payment_membership` (`membership_id`),
  KEY `idx_payment_store` (`user_id`),
  CONSTRAINT `fk_payment_membership` FOREIGN KEY (`membership_id`) REFERENCES `user_memberships` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_payment_store` FOREIGN KEY (`user_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- The merchant's filter configuration.
--
-- This app stores NO products. Filter values are read live from the merchant's
-- own Shopify catalogue; what is kept here is only the decisions made about
-- them. Everything is scoped by store_id.
--
-- `source` says where a group's values come from:
--   vendor | product_type | collection | tag   a shop-level Shopify query
--   option                                     a product option, named by
--                                              source_key ("Color")
--   tag_prefix                                 tags sharing a prefix, e.g.
--                                              "material:cotton" -> "Cotton"
--   price | availability                       computed, no value list
CREATE TABLE IF NOT EXISTS `filter_groups` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `store_id` int(11) NOT NULL,
  `filter_key` varchar(64) NOT NULL,
  `label` varchar(128) NOT NULL,
  `source` enum('vendor','product_type','collection','tag','option','tag_prefix','price','availability') NOT NULL,
  `source_key` varchar(128) DEFAULT NULL,
  `display_type` enum('checkbox','swatch','dropdown','button','range') NOT NULL DEFAULT 'checkbox',
  `is_enabled` tinyint(1) NOT NULL DEFAULT 1,
  `position` int(11) NOT NULL DEFAULT 0,
  `option_sort` enum('manual','alphabetical','count') NOT NULL DEFAULT 'alphabetical',
  `collapsed` tinyint(1) NOT NULL DEFAULT 0,
  `max_visible` int(11) NOT NULL DEFAULT 10,
  `hide_empty` tinyint(1) NOT NULL DEFAULT 1,
  `multi_select` tinyint(1) NOT NULL DEFAULT 1,
  `is_custom` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_group_key` (`store_id`,`filter_key`),
  KEY `idx_group_order` (`store_id`,`position`),
  CONSTRAINT `fk_group_store` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Per-value overrides. A row exists ONLY for a value the merchant has said
-- something about -- renamed, hidden, given a swatch or pinned. Values with
-- nothing said about them are not stored, so a new colour in Shopify appears
-- in the panel automatically instead of waiting for a sync.
CREATE TABLE IF NOT EXISTS `filter_options` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `group_id` int(11) NOT NULL,
  `value` varchar(255) NOT NULL,
  `label` varchar(255) DEFAULT NULL,
  `swatch` varchar(16) DEFAULT NULL,
  `is_hidden` tinyint(1) NOT NULL DEFAULT 0,
  `position` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_group_value` (`group_id`,`value`),
  KEY `idx_option_order` (`group_id`,`position`),
  CONSTRAINT `fk_option_group` FOREIGN KEY (`group_id`) REFERENCES `filter_groups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Values last read from Shopify. Without this, opening the settings screen
-- would call the Admin API five or six times before anything rendered, and
-- every reload would spend more of the shop's rate limit.
CREATE TABLE IF NOT EXISTS `filter_source_cache` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `store_id` int(11) NOT NULL,
  `source` varchar(32) NOT NULL,
  `source_key` varchar(128) NOT NULL DEFAULT '',
  `values_json` longtext NOT NULL,
  `fetched_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_source` (`store_id`,`source`,`source_key`),
  CONSTRAINT `fk_cache_store` FOREIGN KEY (`store_id`) REFERENCES `stores` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Seed plans. config/migrate.js writes the same three on every boot, so these
-- are here only to make a hand-built database match a migrated one.
INSERT INTO `plans`
  (`name`, `price`, `is_popular`, `is_active`, `created_at`, `updated_at`,
   `days`, `status`, `plan_for`, `plan_content`, `max_limit`)
VALUES
  ('Free', 0, 0, 1, NOW(), NOW(), 30, 1, 1,
   '["Core features included","Up to 25 items","Email support"]', 25),
  ('Starter', 9, 0, 1, NOW(), NOW(), 30, 1, 1,
   '["Everything in Free","Up to 250 items","Priority email support"]', 250),
  ('Pro', 29, 1, 1, NOW(), NOW(), 30, 1, 1,
   '["Everything in Starter","Up to 1,000 items","Priority support"]', 1000)
ON DUPLICATE KEY UPDATE `updated_at` = NOW();

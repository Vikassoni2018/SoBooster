// models/filterModel.js
//
// The merchant's filter configuration.
//
// The split this file exists to maintain:
//
//   Shopify   owns what EXISTS -- which vendors, which colours, which tags
//   this app  owns what was DECIDED about it -- shown, renamed, reordered
//
// So `filter_options` holds a row only for a value the merchant has actually
// said something about. Values with nothing said about them are not stored,
// which keeps the table small and means a shop adding a new colour gets it in
// the panel automatically instead of waiting for a sync.
const { query, pool, withTransaction } = require("../config/db");
const catalogue = require("../services/shopifyCatalog");

/* ------------------------------------------------------------------ */
/* What a group may be                                                 */
/* ------------------------------------------------------------------ */

const SOURCES = [
  "vendor",
  "product_type",
  "collection",
  "tag",
  "option",
  "tag_prefix",
  "price",
  "availability",
];

const DISPLAY_TYPES = ["checkbox", "swatch", "dropdown", "button", "range"];
const OPTION_SORTS = ["manual", "alphabetical", "count"];

/** Sources whose values are computed at filter time, not listed. */
const VALUELESS = new Set(["price", "availability"]);

/** Sources that need a source_key to mean anything. */
const NEEDS_KEY = new Set(["option", "tag_prefix"]);

/**
 * Which display types make sense for which source.
 *
 * Price is a range and nothing else; availability is two fixed choices, so a
 * swatch would be meaningless. Offering every type for every source would let
 * a merchant build a filter that cannot render.
 */
const ALLOWED_DISPLAY = {
  vendor: ["checkbox", "dropdown", "button"],
  product_type: ["checkbox", "dropdown", "button"],
  collection: ["checkbox", "dropdown"],
  tag: ["checkbox", "dropdown", "button"],
  option: ["checkbox", "swatch", "dropdown", "button"],
  tag_prefix: ["checkbox", "swatch", "dropdown", "button"],
  price: ["range"],
  availability: ["checkbox", "button"],
};

/**
 * The groups a store starts with.
 *
 * Deliberately the ones that need no configuring to be useful -- every shop
 * has vendors, types, collections and prices. Colour and size are NOT here:
 * they depend on what the shop's products actually call their options, so they
 * are offered on the screen once the catalogue has been read.
 */
const DEFAULT_GROUPS = [
  { filter_key: "collection", label: "Collection", source: "collection", display_type: "checkbox" },
  { filter_key: "product_type", label: "Product type", source: "product_type", display_type: "checkbox" },
  { filter_key: "vendor", label: "Vendor", source: "vendor", display_type: "checkbox" },
  { filter_key: "price", label: "Price", source: "price", display_type: "range" },
  { filter_key: "availability", label: "Availability", source: "availability", display_type: "checkbox" },
];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** A URL-safe, stable key for the storefront query string. */
function toFilterKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function assertSource(source) {
  if (!SOURCES.includes(source)) {
    throw new ValidationError(`Unknown filter source: ${source}`);
  }
  return source;
}

function assertDisplay(source, displayType) {
  const allowed = ALLOWED_DISPLAY[source] || DISPLAY_TYPES;

  if (!allowed.includes(displayType)) {
    throw new ValidationError(
      `A ${source} filter cannot be shown as "${displayType}". ` +
        `Choose one of: ${allowed.join(", ")}.`
    );
  }

  return displayType;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

function toBool(value) {
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

function hydrateGroup(row) {
  return {
    id: row.id,
    filter_key: row.filter_key,
    label: row.label,
    source: row.source,
    source_key: row.source_key,
    display_type: row.display_type,
    is_enabled: Boolean(row.is_enabled),
    position: row.position,
    option_sort: row.option_sort,
    collapsed: Boolean(row.collapsed),
    max_visible: row.max_visible,
    hide_empty: Boolean(row.hide_empty),
    multi_select: Boolean(row.multi_select),
    is_custom: Boolean(row.is_custom),
    // Filled in by withValues(); a group is never shown without its values.
    values: [],
    overrides: [],
  };
}

async function listGroups(storeId) {
  const rows = await query(
    `SELECT * FROM filter_groups
      WHERE store_id = ?
      ORDER BY position ASC, id ASC`,
    [storeId]
  );

  return rows.map(hydrateGroup);
}

async function findGroup(storeId, groupId) {
  const rows = await query(
    "SELECT * FROM filter_groups WHERE store_id = ? AND id = ? LIMIT 1",
    [storeId, groupId]
  );

  return rows[0] ? hydrateGroup(rows[0]) : null;
}

async function listOverrides(groupIds) {
  if (!groupIds.length) return new Map();

  const rows = await query(
    `SELECT * FROM filter_options
      WHERE group_id IN (${groupIds.map(() => "?").join(", ")})
      ORDER BY position IS NULL, position ASC, id ASC`,
    groupIds
  );

  const byGroup = new Map();

  rows.forEach((row) => {
    const list = byGroup.get(row.group_id) || [];

    list.push({
      id: row.id,
      group_id: row.group_id,
      value: row.value,
      label: row.label,
      swatch: row.swatch,
      is_hidden: Boolean(row.is_hidden),
      position: row.position,
    });

    byGroup.set(row.group_id, list);
  });

  return byGroup;
}

/* ------------------------------------------------------------------ */
/* Cached catalogue values                                             */
/* ------------------------------------------------------------------ */

function cacheKeyFor(group) {
  // Every option group reads from one shared catalogue walk rather than
  // paging the products again per group.
  if (group.source === "option") return { source: "option_catalogue", key: "" };
  if (group.source === "tag_prefix") return { source: "tag", key: "" };
  return { source: group.source, key: group.source_key || "" };
}

async function readCache(storeId, source, sourceKey = "") {
  const rows = await query(
    `SELECT values_json, fetched_at FROM filter_source_cache
      WHERE store_id = ? AND source = ? AND source_key = ?
      LIMIT 1`,
    [storeId, source, sourceKey]
  );

  if (!rows[0]) return null;

  try {
    return {
      values: JSON.parse(rows[0].values_json),
      fetchedAt: rows[0].fetched_at,
    };
  } catch (err) {
    console.warn(`Unreadable filter cache for store ${storeId}/${source}`);
    return null;
  }
}

async function writeCache(storeId, source, sourceKey, values) {
  await query(
    `INSERT INTO filter_source_cache (store_id, source, source_key, values_json, fetched_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE values_json = VALUES(values_json), fetched_at = NOW()`,
    [storeId, source, sourceKey, JSON.stringify(values)]
  );
}

/**
 * Re-read every value list this store needs from Shopify.
 *
 * One pass: the shop-level lists are one query each, and the option catalogue
 * is a single walk that serves every option group at once. Each source is
 * caught on its own so one failure -- a permission the app was never granted,
 * say -- does not lose the sources that did work.
 */
async function refreshFromShopify(shop, storeId) {
  const report = { refreshed: [], failed: [], truncated: false, scanned: 0 };

  for (const source of ["vendor", "product_type", "tag"]) {
    try {
      await writeCache(storeId, source, "", await catalogue.fetchStringList(shop, source));
      report.refreshed.push(source);
    } catch (err) {
      report.failed.push({ source, message: err.message });
    }
  }

  try {
    await writeCache(storeId, "collection", "", await catalogue.fetchCollections(shop));
    report.refreshed.push("collection");
  } catch (err) {
    report.failed.push({ source: "collection", message: err.message });
  }

  try {
    const options = await catalogue.fetchOptionCatalogue(shop);

    await writeCache(storeId, "option_catalogue", "", options.options);

    report.refreshed.push("option_catalogue");
    report.truncated = options.truncated;
    report.scanned = options.scanned;
  } catch (err) {
    report.failed.push({ source: "option_catalogue", message: err.message });
  }

  return report;
}

/** Pull one group's values out of whatever its source cached. */
function valuesFromCache(group, cached) {
  if (!cached) return [];

  if (group.source === "option") {
    const wanted = String(group.source_key || "").trim().toLowerCase();
    const match = Object.keys(cached.values || {}).find(
      (name) => name.toLowerCase() === wanted
    );
    return match ? cached.values[match] : [];
  }

  if (group.source === "tag_prefix") {
    return catalogue.valuesFromTagPrefix(cached.values || [], group.source_key);
  }

  return cached.values || [];
}

/**
 * Merge a group's catalogue values with the merchant's overrides.
 *
 * Order of precedence, and the reason for each:
 *
 *   1. pinned values first, in their manual order   the merchant said so
 *   2. then whatever option_sort asks for           alphabetical / by count
 *   3. hidden values are kept and MARKED, not
 *      dropped                                      the settings screen has to
 *                                                   show them to unhide them
 *
 * An override whose value no longer exists in the shop is kept too, flagged
 * `missing` -- a colour deleted in Shopify should say so on this screen, not
 * silently take its swatch with it.
 */
function mergeValues(group, rawValues, overrides) {
  const byValue = new Map(
    (overrides || []).map((override) => [override.value.toLowerCase(), override])
  );

  const merged = (rawValues || []).map((entry) => {
    const value = typeof entry === "string" ? entry : entry.value;
    const count = typeof entry === "string" ? null : entry.count;
    const displayLabel = typeof entry === "string" ? value : entry.label || value;
    const valueKey = String(value).toLowerCase();
    const legacyCollectionKey = String(displayLabel).toLowerCase();
    const override =
      byValue.get(valueKey) ||
      (group.source === "collection" ? byValue.get(legacyCollectionKey) : null);

    if (override) {
      byValue.delete(valueKey);
      byValue.delete(legacyCollectionKey);
    }

    return {
      value,
      count: count === undefined ? null : count,
      label: override?.label || displayLabel,
      swatch: override?.swatch || null,
      handle: typeof entry === "string" ? null : entry.handle || null,
      url: typeof entry === "string" ? null : entry.url || null,
      is_hidden: Boolean(override?.is_hidden),
      position: override?.position ?? null,
      customised: Boolean(override),
      missing: false,
    };
  });

  // Whatever is left over is an override for a value the shop no longer has.
  byValue.forEach((override) => {
    merged.push({
      value: override.value,
      count: 0,
      label: override.label || override.value,
      swatch: override.swatch,
      is_hidden: Boolean(override.is_hidden),
      position: override.position ?? null,
      customised: true,
      missing: true,
    });
  });

  const pinned = merged.filter((entry) => entry.position !== null);
  const rest = merged.filter((entry) => entry.position === null);

  pinned.sort((a, b) => a.position - b.position);

  if (group.option_sort === "count") {
    rest.sort((a, b) => (b.count || 0) - (a.count || 0) || a.label.localeCompare(b.label));
  } else if (group.option_sort === "alphabetical") {
    rest.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }
  // "manual" leaves the unpinned remainder in catalogue order.

  return [...pinned, ...rest];
}

/**
 * Every group for a store, with values merged in. This is what both the
 * settings screen and the storefront configuration endpoint read.
 */
async function listGroupsWithValues(storeId) {
  const groups = await listGroups(storeId);
  const overrides = await listOverrides(groups.map((group) => group.id));

  // Read each distinct cache once, however many groups share it.
  const cacheReads = new Map();

  for (const group of groups) {
    if (VALUELESS.has(group.source)) continue;

    const { source, key } = cacheKeyFor(group);
    const cacheId = `${source}::${key}`;

    if (!cacheReads.has(cacheId)) {
      cacheReads.set(cacheId, await readCache(storeId, source, key));
    }
  }

  return groups.map((group) => {
    const groupOverrides = overrides.get(group.id) || [];

    if (VALUELESS.has(group.source)) {
      return { ...group, values: [], overrides: groupOverrides, fetchedAt: null };
    }

    const { source, key } = cacheKeyFor(group);
    const cached = cacheReads.get(`${source}::${key}`);

    return {
      ...group,
      overrides: groupOverrides,
      values: mergeValues(group, valuesFromCache(group, cached), groupOverrides),
      fetchedAt: cached ? cached.fetchedAt : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/** Give a store the starting set of groups, once. */
async function ensureDefaults(storeId) {
  const existing = await query(
    "SELECT COUNT(*) AS total FROM filter_groups WHERE store_id = ?",
    [storeId]
  );

  if (Number(existing[0].total) > 0) return false;

  for (const [index, group] of DEFAULT_GROUPS.entries()) {
    await query(
      `INSERT INTO filter_groups
         (store_id, filter_key, label, source, source_key, display_type,
          is_enabled, position, option_sort, is_custom)
       VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?, 0)`,
      [
        storeId,
        group.filter_key,
        group.label,
        group.source,
        group.display_type,
        index,
        group.source === "collection" ? "count" : "alphabetical",
      ]
    );
  }

  return true;
}

async function createGroup(storeId, input) {
  const source = assertSource(input.source);

  if (NEEDS_KEY.has(source) && !String(input.source_key || "").trim()) {
    throw new ValidationError(
      source === "option"
        ? "Choose which product option this filter reads from."
        : "Enter the tag prefix this filter reads from."
    );
  }

  const label = String(input.label || "").trim();

  if (!label) throw new ValidationError("Give the filter a name.");
  if (label.length > 128) throw new ValidationError("That name is too long.");

  const displayType = assertDisplay(source, input.display_type || "checkbox");

  // Derived from the label, then made unique -- two groups called "Colour"
  // must not fight over ?colour= in the storefront URL.
  const base = toFilterKey(input.filter_key || label) || "filter";
  const filterKey = await uniqueKey(storeId, base);

  const rows = await query(
    "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM filter_groups WHERE store_id = ?",
    [storeId]
  );

  const result = await query(
    `INSERT INTO filter_groups
       (store_id, filter_key, label, source, source_key, display_type,
        is_enabled, position, option_sort, collapsed, max_visible,
        hide_empty, multi_select, is_custom)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      storeId,
      filterKey,
      label,
      source,
      NEEDS_KEY.has(source) ? String(input.source_key).trim() : null,
      displayType,
      toBool(input.is_enabled === undefined ? true : input.is_enabled),
      Number(rows[0].next),
      OPTION_SORTS.includes(input.option_sort) ? input.option_sort : "alphabetical",
      toBool(input.collapsed),
      clampInt(input.max_visible, 1, 100, 10),
      toBool(input.hide_empty === undefined ? true : input.hide_empty),
      toBool(input.multi_select === undefined ? true : input.multi_select),
    ]
  );

  return findGroup(storeId, result.insertId);
}

async function uniqueKey(storeId, base) {
  const rows = await query(
    "SELECT filter_key FROM filter_groups WHERE store_id = ?",
    [storeId]
  );

  const taken = new Set(rows.map((row) => row.filter_key));

  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}_${suffix}`.slice(0, 64);
    if (!taken.has(candidate)) return candidate;
  }

  throw new ValidationError("Too many filters with that name.");
}

/**
 * Update one group. Only the fields present in `input` are touched, so the
 * screen can save a single toggle without sending the whole group back.
 *
 * `source` and `source_key` are deliberately NOT updatable: changing where a
 * group's values come from would strand every per-value override it has.
 * Delete and recreate instead.
 */
async function updateGroup(storeId, groupId, input) {
  const group = await findGroup(storeId, groupId);

  if (!group) throw new ValidationError("That filter no longer exists.");

  const sets = [];
  const params = [];

  const set = (column, value) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (input.label !== undefined) {
    const label = String(input.label).trim();
    if (!label) throw new ValidationError("Give the filter a name.");
    if (label.length > 128) throw new ValidationError("That name is too long.");
    set("label", label);
  }

  if (input.display_type !== undefined) {
    set("display_type", assertDisplay(group.source, input.display_type));
  }

  if (input.is_enabled !== undefined) set("is_enabled", toBool(input.is_enabled));
  if (input.collapsed !== undefined) set("collapsed", toBool(input.collapsed));
  if (input.hide_empty !== undefined) set("hide_empty", toBool(input.hide_empty));
  if (input.multi_select !== undefined) set("multi_select", toBool(input.multi_select));
  if (input.max_visible !== undefined) set("max_visible", clampInt(input.max_visible, 1, 100, 10));

  if (input.option_sort !== undefined) {
    if (!OPTION_SORTS.includes(input.option_sort)) {
      throw new ValidationError(`Unknown option order: ${input.option_sort}`);
    }
    set("option_sort", input.option_sort);
  }

  if (!sets.length) return group;

  params.push(storeId, groupId);

  await query(
    `UPDATE filter_groups SET ${sets.join(", ")} WHERE store_id = ? AND id = ?`,
    params
  );

  return findGroup(storeId, groupId);
}

/**
 * A built-in group is disabled, never deleted. Every shop has vendors and
 * prices; a merchant who deleted "Price" would have no way to bring it back,
 * and "off" is what they actually meant.
 */
async function deleteGroup(storeId, groupId) {
  const group = await findGroup(storeId, groupId);

  if (!group) return false;

  if (!group.is_custom) {
    throw new ValidationError(
      `"${group.label}" is a built-in filter. Turn it off instead of deleting it.`
    );
  }

  const [result] = await pool.query(
    "DELETE FROM filter_groups WHERE store_id = ? AND id = ?",
    [storeId, groupId]
  );

  return result.affectedRows > 0;
}

/**
 * Reorder groups from a list of ids.
 *
 * In one transaction: a half-applied reorder would leave two groups claiming
 * the same position, and the panel order would then depend on insertion order.
 */
async function reorderGroups(storeId, orderedIds) {
  const groups = await listGroups(storeId);
  const known = new Set(groups.map((group) => group.id));

  const ids = orderedIds
    .map((id) => Number(id))
    .filter((id) => known.has(id));

  if (ids.length !== groups.length || new Set(ids).size !== groups.length) {
    throw new ValidationError("The new order does not list every filter.");
  }

  await withTransaction(async (connection) => {
    for (const [index, id] of ids.entries()) {
      await connection.query(
        "UPDATE filter_groups SET position = ? WHERE store_id = ? AND id = ?",
        [index, storeId, id]
      );
    }
  });

  return listGroups(storeId);
}

/* ---- per-value overrides ---- */

/**
 * Record a decision about one value.
 *
 * Writes an override row on first use and updates it after. When every field
 * is back to its default the row is DELETED rather than left holding a row of
 * nulls -- that is what keeps "has the merchant customised this?" a question
 * the row's existence answers.
 */
async function setOption(storeId, groupId, value, input) {
  const group = await findGroup(storeId, groupId);

  if (!group) throw new ValidationError("That filter no longer exists.");

  if (VALUELESS.has(group.source)) {
    throw new ValidationError(
      `A ${group.source} filter has no values to customise.`
    );
  }

  const raw = String(value || "").trim();

  if (!raw) throw new ValidationError("Missing the value to update.");
  if (raw.length > 255) throw new ValidationError("That value is too long.");

  const existing = await query(
    "SELECT * FROM filter_options WHERE group_id = ? AND value = ? LIMIT 1",
    [groupId, raw]
  );

  const current = existing[0] || {};

  const next = {
    label: input.label === undefined ? current.label ?? null : cleanLabel(input.label),
    swatch: input.swatch === undefined ? current.swatch ?? null : cleanSwatch(input.swatch),
    is_hidden:
      input.is_hidden === undefined
        ? Number(current.is_hidden || 0)
        : toBool(input.is_hidden),
    position:
      input.position === undefined
        ? current.position ?? null
        : input.position === null
        ? null
        : clampInt(input.position, 0, 9999, 0),
  };

  const isDefault =
    next.label === null &&
    next.swatch === null &&
    next.is_hidden === 0 &&
    next.position === null;

  if (isDefault) {
    if (existing[0]) {
      await query("DELETE FROM filter_options WHERE id = ?", [existing[0].id]);
    }
    return null;
  }

  await query(
    `INSERT INTO filter_options (group_id, value, label, swatch, is_hidden, position)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       label = VALUES(label),
       swatch = VALUES(swatch),
       is_hidden = VALUES(is_hidden),
       position = VALUES(position)`,
    [groupId, raw, next.label, next.swatch, next.is_hidden, next.position]
  );

  return next;
}

function cleanLabel(value) {
  const label = String(value == null ? "" : value).trim();
  if (!label) return null;
  if (label.length > 255) throw new ValidationError("That label is too long.");
  return label;
}

/** #rgb or #rrggbb only -- this ends up in a style attribute. */
function cleanSwatch(value) {
  const swatch = String(value == null ? "" : value).trim();

  if (!swatch) return null;

  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(swatch)) {
    throw new ValidationError("A swatch colour must look like #1a1a1a.");
  }

  return swatch.toLowerCase();
}

/** Drop every customisation in a group and start over from the catalogue. */
async function resetOptions(storeId, groupId) {
  const group = await findGroup(storeId, groupId);

  if (!group) throw new ValidationError("That filter no longer exists.");

  const [result] = await pool.query(
    "DELETE FROM filter_options WHERE group_id = ?",
    [groupId]
  );

  return result.affectedRows;
}

module.exports = {
  SOURCES,
  DISPLAY_TYPES,
  OPTION_SORTS,
  ALLOWED_DISPLAY,
  DEFAULT_GROUPS,
  VALUELESS,
  NEEDS_KEY,
  ValidationError,

  toFilterKey,
  listGroups,
  findGroup,
  listGroupsWithValues,
  ensureDefaults,
  createGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
  setOption,
  resetOptions,

  readCache,
  writeCache,
  refreshFromShopify,
  mergeValues,
};

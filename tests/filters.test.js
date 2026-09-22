/* Filter configuration rules.
 *
 * The things protected here are the ones a merchant would notice going wrong:
 *
 *   - a filter cannot be given a display type its source cannot render
 *   - a built-in filter cannot be deleted, only turned off
 *   - two groups never share a storefront key
 *   - an override row exists only while there is something to say
 *   - Shopify owns what exists; this app owns what was decided about it
 *
 * The connection pool is stubbed, so no database and no Shopify are needed.
 */
const path = require("path");
const Module = require("module");

const SERVER = path.join(__dirname, "..");

process.env.SHOPIFY_API_KEY = "test_api_key";
process.env.SHOPIFY_API_SECRET = "test_api_secret";
process.env.HOST = "https://example.com";
process.env.TOKEN_ENCRYPTION_KEY = "0".repeat(64);

/* ---------- stub the DB ---------- */
const dbPath = require.resolve(path.join(SERVER, "config/db.js"));

const state = {
  queries: [],
  groups: [],
  options: [],
  cache: null,
};

function matchGroup(sql, params) {
  if (/WHERE store_id = \? AND id = \?/.test(sql)) {
    return state.groups.filter(
      (group) => group.store_id === params[0] && group.id === params[1]
    );
  }
  return state.groups;
}

const fakeDb = {
  pool: {
    query: async (sql, params) => {
      state.queries.push({ sql, params });
      return [{ affectedRows: 1 }, []];
    },
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      query: async () => [[], []],
    }),
  },
  async query(sql, params = []) {
    state.queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });

    if (/COUNT\(\*\) AS total FROM filter_groups/.test(sql)) {
      return [{ total: state.groups.length }];
    }
    if (/COALESCE\(MAX\(position\)/.test(sql)) {
      return [{ next: state.groups.length }];
    }
    if (/SELECT filter_key FROM filter_groups/.test(sql)) {
      return state.groups.map((group) => ({ filter_key: group.filter_key }));
    }
    if (/FROM filter_groups/.test(sql)) {
      return matchGroup(sql, params);
    }
    if (/FROM filter_options/.test(sql)) {
      return state.options;
    }
    if (/FROM filter_source_cache/.test(sql)) {
      return state.cache ? [state.cache] : [];
    }
    if (/INSERT INTO filter_groups/.test(sql)) {
      return { insertId: 99 };
    }
    return [];
  },
  async withTransaction(fn) {
    return fn({ query: async () => [[], []] });
  },
  async assertConnection() {},
};

require.cache[dbPath] = new Module(dbPath, null);
require.cache[dbPath].filename = dbPath;
require.cache[dbPath].loaded = true;
require.cache[dbPath].exports = fakeDb;

const filters = require(path.join(SERVER, "models/filterModel"));
const catalogue = require(path.join(SERVER, "services/shopifyCatalog"));

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

async function refuses(name, promise, expected) {
  try {
    await promise;
    check(name, false, "it was allowed");
  } catch (err) {
    check(
      name,
      err.statusCode === 400 && (!expected || expected.test(err.message)),
      err.message
    );
  }
}

/** The most recent INSERT into filter_groups, as recorded by the stub. */
function lastInsert() {
  return state.queries.filter((q) => /INSERT INTO filter_groups/.test(q.sql)).pop();
}

function group(overrides) {
  return {
    id: 1,
    store_id: 7,
    filter_key: "colour",
    label: "Colour",
    source: "option",
    source_key: "Color",
    display_type: "checkbox",
    is_enabled: 1,
    position: 0,
    option_sort: "alphabetical",
    collapsed: 0,
    max_visible: 10,
    hide_empty: 1,
    multi_select: 1,
    is_custom: 1,
    ...overrides,
  };
}

(async () => {
  console.log("\nStorefront keys");
  {
    check("a label becomes a URL-safe key", filters.toFilterKey("Product type") === "product_type");
    check("punctuation is collapsed", filters.toFilterKey("Size / Fit!!") === "size_fit");
    check("accents and symbols are stripped", filters.toFilterKey("Couleur — ✨") === "couleur");
    check("leading and trailing separators go", filters.toFilterKey("  -Color-  ") === "color");
    check("a key is capped", filters.toFilterKey("x".repeat(200)).length === 64);

    state.groups = [group({ filter_key: "colour" })];
    state.queries.length = 0;

    await filters.createGroup(7, { source: "vendor", label: "Colour" });

    // The model destructures `query` at require time, so the recorded calls
    // are the only way to see what was written.
    const insert = lastInsert();
    check("a clashing key is made unique", insert.params[1] === "colour_2", insert.params[1]);
  }

  console.log("\nDisplay types must suit the source");
  {
    state.groups = [group({ source: "vendor", display_type: "checkbox" })];
    await refuses(
      "a vendor cannot be a swatch",
      filters.updateGroup(7, 1, { display_type: "swatch" }),
      /cannot be shown as/
    );

    state.groups = [group({ source: "price", display_type: "range" })];
    await refuses(
      "price cannot be a checkbox",
      filters.updateGroup(7, 1, { display_type: "checkbox" })
    );

    state.groups = [group({ source: "option" })];
    const ok = await filters.updateGroup(7, 1, { display_type: "swatch" });
    check("a product option CAN be a swatch", Boolean(ok));

    check("price offers only a range",
      filters.ALLOWED_DISPLAY.price.length === 1 && filters.ALLOWED_DISPLAY.price[0] === "range");
    check("every source has an allow-list",
      filters.SOURCES.every((source) => Array.isArray(filters.ALLOWED_DISPLAY[source])));
  }

  console.log("\nCreating a group");
  {
    state.groups = [];

    await refuses("a name is required", filters.createGroup(7, { source: "vendor", label: "  " }));
    await refuses("an unknown source is refused", filters.createGroup(7, { source: "nope", label: "X" }));
    await refuses(
      "an option group needs an option name",
      filters.createGroup(7, { source: "option", label: "Colour" }),
      /which product option/
    );
    await refuses(
      "a tag-prefix group needs a prefix",
      filters.createGroup(7, { source: "tag_prefix", label: "Material" }),
      /tag prefix/
    );

    state.queries.length = 0;
    await filters.createGroup(7, { source: "vendor", label: "Brand", max_visible: 9999 });

    const created = lastInsert();
    check("max_visible is clamped on create", created.params[10] === 100, String(created.params[10]));
    // is_custom is written as a literal, not bound: anything created through
    // this path is by definition not built in.
    check("a new group is always custom", /multi_select, is_custom\)/.test(created.sql) &&
      /\?, \?, 1\)$/.test(created.sql.trim()), created.sql.slice(-60));
  }

  console.log("\nBuilt-in groups cannot be deleted");
  {
    state.groups = [group({ is_custom: 0, label: "Price", source: "price" })];
    await refuses(
      "deleting a built-in is refused",
      filters.deleteGroup(7, 1),
      /turn it off/i
    );

    state.groups = [group({ is_custom: 1 })];
    check("a custom group can be deleted", (await filters.deleteGroup(7, 1)) === true);
  }

  console.log("\nA group's source is immutable");
  {
    state.groups = [group({ source: "vendor" })];
    await filters.updateGroup(7, 1, { source: "collection", source_key: "x", label: "Brand" });

    const update = state.queries.filter((q) => /UPDATE filter_groups SET/.test(q.sql)).pop();
    check("source is never written by an update", !/source/.test(update.sql), update.sql);
    check("but the label is", /label/.test(update.sql));
  }

  console.log("\nValue overrides");
  {
    state.groups = [group({ source: "price" })];
    await refuses(
      "price has no values to customise",
      filters.setOption(7, 1, "x", { label: "y" }),
      /no values/
    );

    state.groups = [group({ source: "option" })];
    await refuses("a value is required", filters.setOption(7, 1, "  ", { label: "y" }));
    await refuses(
      "a swatch must be a hex colour",
      filters.setOption(7, 1, "Black", { swatch: "red" }),
      /#1a1a1a/
    );

    const shortHex = await filters.setOption(7, 1, "Black", { swatch: "#ABC" });
    check("#abc is accepted and lowercased", shortHex.swatch === "#abc", shortHex.swatch);

    // An override that says nothing should not exist.
    state.options = [{ id: 5, group_id: 1, value: "Black", label: "Ink", swatch: null, is_hidden: 0, position: null }];
    state.queries.length = 0;

    const cleared = await filters.setOption(7, 1, "Black", {
      label: "", swatch: "", is_hidden: false, position: null,
    });

    check("clearing every field returns nothing", cleared === null);
    check("and deletes the row",
      state.queries.some((q) => /DELETE FROM filter_options WHERE id/.test(q.sql)));

    // Partial updates must not wipe the fields they do not mention.
    state.options = [{ id: 5, group_id: 1, value: "Black", label: "Ink", swatch: "#111111", is_hidden: 0, position: 2 }];
    const kept = await filters.setOption(7, 1, "Black", { is_hidden: true });
    check("hiding keeps the existing label", kept.label === "Ink", JSON.stringify(kept));
    check("and the swatch", kept.swatch === "#111111");
    check("and the pin", kept.position === 2);
  }

  console.log("\nMerging catalogue values with overrides");
  {
    const base = group({ option_sort: "alphabetical" });

    const merged = filters.mergeValues(
      base,
      [
        { value: "Red", count: 4 },
        { value: "Black", count: 9 },
        { value: "Blue", count: 2 },
      ],
      [
        { value: "Black", label: "Ink", swatch: "#111111", is_hidden: false, position: null },
        { value: "Blue", label: null, swatch: null, is_hidden: true, position: null },
        { value: "Gone", label: "Old", swatch: null, is_hidden: false, position: null },
      ]
    );

    const find = (value) => merged.find((entry) => entry.value === value);

    check("a rename is applied", find("Black").label === "Ink");
    check("the raw value is kept", find("Black").value === "Black");
    check("an untouched value uses its own name", find("Red").label === "Red");
    check("an untouched value is not marked customised", find("Red").customised === false);
    check("a hidden value is kept and flagged",
      find("Blue") && find("Blue").is_hidden === true,
      "the settings screen has to show it to unhide it");
    check("an override for a value Shopify no longer has is kept",
      find("Gone") && find("Gone").missing === true);
    check("and reads as zero products", find("Gone").count === 0);
    check("alphabetical sorts by the DISPLAYED label",
      merged.map((entry) => entry.label).join(",") === "Blue,Ink,Old,Red",
      merged.map((entry) => entry.label).join(","));

    const byCount = filters.mergeValues(
      group({ option_sort: "count" }),
      [{ value: "Red", count: 4 }, { value: "Black", count: 9 }],
      []
    );
    check("count order is biggest first", byCount[0].value === "Black");

    const pinned = filters.mergeValues(
      group({ option_sort: "alphabetical" }),
      [{ value: "Red", count: 4 }, { value: "Black", count: 9 }, { value: "Zinc", count: 1 }],
      [{ value: "Zinc", label: null, swatch: null, is_hidden: false, position: 0 }]
    );
    check("a pinned value comes first whatever the sort", pinned[0].value === "Zinc");
    check("the rest still sort normally",
      pinned.slice(1).map((entry) => entry.value).join(",") === "Black,Red");
  }

  console.log("\nReading values from Shopify");
  {
    check("Shopify's placeholder option is ignored",
      catalogue.isSyntheticOption("Title", ["Default Title"]));
    check("case and spacing do not fool it",
      catalogue.isSyntheticOption(" title ", ["  DEFAULT TITLE "]));
    check("a real option called Title is kept",
      !catalogue.isSyntheticOption("Title", ["Ski Wax", "Special Ski Wax"]),
      "a product may genuinely name its option Title");
    check("a real option is kept", !catalogue.isSyntheticOption("Color", ["Black"]));

    check("blank values are dropped", catalogue.tidy(["Black", "", "  "]).length === 1);
    check("duplicates are folded case-insensitively",
      catalogue.tidy(["Black", "black", "BLACK"]).length === 1);
    check("the first spelling wins", catalogue.tidy(["Black", "BLACK"])[0] === "Black");

    const fromTags = catalogue.valuesFromTagPrefix(
      ["material:cotton", "material:silk", "occasion:prom", "sale"],
      "material:"
    );
    check("a tag prefix yields its values", fromTags.length === 2, JSON.stringify(fromTags));
    check("the prefix is stripped and capitalised",
      fromTags.map((entry) => entry.value).sort().join(",") === "Cotton,Silk",
      fromTags.map((entry) => entry.value).join(","));
    check("an empty prefix matches nothing",
      catalogue.valuesFromTagPrefix(["material:cotton"], "").length === 0);

    const suggested = catalogue.suggestTagPrefixes([
      "material:cotton", "material:silk", "occasion:prom", "sale", "new",
    ]);
    check("a repeated prefix is suggested",
      suggested.length === 1 && suggested[0].prefix === "material:",
      JSON.stringify(suggested));
    check("a one-off is not a convention",
      !suggested.some((entry) => entry.prefix === "occasion:"));
  }

  console.log("\nReordering");
  {
    state.groups = [group({ id: 1 }), group({ id: 2, filter_key: "b" }), group({ id: 3, filter_key: "c" })];

    await refuses(
      "a partial order is refused",
      filters.reorderGroups(7, [3, 1]),
      /every filter/
    );

    await refuses(
      "an unknown id is refused",
      filters.reorderGroups(7, [1, 2, 999]),
      /every filter/
    );

    const reordered = await filters.reorderGroups(7, [3, 1, 2]);
    check("a complete order is accepted", Array.isArray(reordered));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

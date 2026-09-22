// services/shopifyCatalog.js
//
// Where filter VALUES come from: the merchant's own Shopify catalogue.
//
// This app stores no products. The settings screen needs to know what exists
// in the shop -- which vendors, which collections, which colours -- so it asks
// Shopify, and models/filterModel.js caches the answer. Nothing here writes to
// the database; nothing here knows about filter groups.
//
// Two shapes of query, chosen per source because they cost very different
// amounts:
//
//   shop-level    vendors, product types, tags   ONE query, no paging. Shopify
//                                                already keeps these lists.
//   paged         product option values          There is no shop-level query
//                                                for "every value of the Color
//                                                option", so products have to
//                                                be walked. See the cap below.
const shopify = require("./shopify");

const PAGE_SIZE = 250;

/**
 * How many pages of products to walk when collecting option values.
 *
 * 250 x 20 = 5,000 products, which covers the overwhelming majority of shops
 * in about twenty requests. Past that the result is marked `truncated` and the
 * screen says so, rather than quietly showing a partial list as if it were
 * complete.
 *
 * The real fix at catalogue scale is a bulk operation feeding a stored index,
 * not a bigger number here -- see the README.
 */
const MAX_PRODUCT_PAGES = Number(process.env.FILTER_SCAN_PAGES || 20);

/**
 * Shopify gives every product an option even when it has none: a single
 * option called "Title" whose only value is "Default Title". It is an artefact
 * of the data model, not something a shopper would ever filter on.
 */
const SYNTHETIC_OPTION = "title";
const SYNTHETIC_VALUE = "default title";

function isSyntheticOption(name, values) {
  if (String(name).trim().toLowerCase() !== SYNTHETIC_OPTION) return false;

  // Only synthetic when it is ALSO the placeholder value -- a shop could
  // legitimately have an option called "Title" with real values.
  return values.every(
    (value) => String(value).trim().toLowerCase() === SYNTHETIC_VALUE
  );
}

/** Drop blanks, de-duplicate case-insensitively, keep the first spelling. */
function tidy(values) {
  const seen = new Map();

  values.forEach((raw) => {
    const value = String(raw == null ? "" : raw).trim();
    if (!value) return;

    const key = value.toLowerCase();
    if (!seen.has(key)) seen.set(key, value);
  });

  return [...seen.values()];
}

function asOptions(values) {
  return tidy(values).map((value) => ({ value, count: null }));
}

/* ------------------------------------------------------------------ */
/* Shop-level lists                                                    */
/* ------------------------------------------------------------------ */

const STRING_LISTS = {
  vendor: "productVendors",
  product_type: "productTypes",
  tag: "productTags",
};

/**
 * Vendors, product types or tags.
 *
 * Shopify maintains these lists itself, so each is one cheap query. They carry
 * no product counts, and counting would mean a productsCount query per value --
 * fine for six vendors, not fine for six hundred. The screen shows no count
 * for these rather than making that trade silently.
 */
async function fetchStringList(shop, source) {
  const field = STRING_LISTS[source];

  if (!field) throw new Error(`No shop-level list for source: ${source}`);

  const data = await shopify.forShop(shop, {
    query: `query FilterValues($first: Int!) {
      shop { ${field}(first: $first) { edges { node } } }
    }`,
    variables: { first: PAGE_SIZE },
  });

  const edges = data?.shop?.[field]?.edges || [];

  return asOptions(edges.map((edge) => edge.node));
}

/** Collections, which DO carry a product count worth showing. */
async function fetchCollections(shop) {
  const values = [];
  let cursor = null;
  let pages = 0;

  do {
    const data = await shopify.forShop(shop, {
      query: `query FilterCollections($first: Int!, $after: String) {
        collections(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { id title handle productsCount { count } } }
        }
      }`,
      variables: { first: PAGE_SIZE, after: cursor },
    });

    const connection = data?.collections;
    if (!connection) break;

    connection.edges.forEach((edge) => {
      const node = edge.node;
      if (!node?.title) return;

      values.push({
        value: node.handle,
        label: node.title,
        count: node.productsCount ? Number(node.productsCount.count) : null,
        handle: node.handle,
        url: `/collections/${node.handle}`,
      });
    });

    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    pages += 1;
  } while (cursor && pages < MAX_PRODUCT_PAGES);

  return values;
}

/* ------------------------------------------------------------------ */
/* Product option values                                               */
/* ------------------------------------------------------------------ */

/**
 * Every product option and its values, in ONE pass over the catalogue.
 *
 * Discovering the option names and collecting their values are the same walk,
 * so they are done together: doing them separately would page the whole
 * catalogue twice for one screen.
 *
 * Returns { options: { "Color": [{ value, count }] }, scanned, truncated }.
 */
async function fetchOptionCatalogue(shop) {
  // name (lowercased) -> { label, values: Map(lowercased -> { value, count }) }
  const options = new Map();

  let cursor = null;
  let pages = 0;
  let scanned = 0;
  let hasMore = false;

  do {
    const data = await shopify.forShop(shop, {
      query: `query FilterOptions($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { options { name optionValues { name } } } }
        }
      }`,
      variables: { first: PAGE_SIZE, after: cursor },
    });

    const connection = data?.products;
    if (!connection) break;

    connection.edges.forEach((edge) => {
      scanned += 1;

      (edge.node.options || []).forEach((option) => {
        const values = (option.optionValues || [])
          .map((entry) => entry.name)
          .filter(Boolean);

        if (!option.name || !values.length) return;
        if (isSyntheticOption(option.name, values)) return;

        const key = option.name.trim().toLowerCase();

        if (!options.has(key)) {
          options.set(key, { label: option.name.trim(), values: new Map() });
        }

        const bucket = options.get(key).values;

        tidy(values).forEach((value) => {
          const valueKey = value.toLowerCase();
          const existing = bucket.get(valueKey);

          // Counting products, not variants: one product either has the value
          // or it does not, however many variants carry it.
          if (existing) existing.count += 1;
          else bucket.set(valueKey, { value, count: 1 });
        });
      });
    });

    hasMore = connection.pageInfo.hasNextPage;
    cursor = hasMore ? connection.pageInfo.endCursor : null;
    pages += 1;
  } while (cursor && pages < MAX_PRODUCT_PAGES);

  const result = {};

  options.forEach((entry) => {
    result[entry.label] = [...entry.values.values()].sort(
      (a, b) => b.count - a.count || a.value.localeCompare(b.value)
    );
  });

  return {
    options: result,
    scanned,
    // True when the walk stopped at the cap with products still unread.
    truncated: Boolean(hasMore && pages >= MAX_PRODUCT_PAGES),
  };
}

/* ------------------------------------------------------------------ */
/* Custom groups from a tag prefix                                     */
/* ------------------------------------------------------------------ */

/**
 * A custom group built from tags sharing a prefix.
 *
 * Merchants routinely encode structured data in tags -- "material:cotton",
 * "occasion:wedding" -- because Shopify gives them nowhere else to put it.
 * This turns one of those conventions into a filter group: given "material:",
 * the tag "material:cotton" becomes the value "Cotton".
 */
function valuesFromTagPrefix(tags, prefix) {
  const needle = String(prefix || "").trim().toLowerCase();

  if (!needle) return [];

  const seen = new Set();
  const prefixLength = String(prefix).trim().length;

  return tags
    .map((entry) => (typeof entry === "string" ? entry : entry.value))
    .filter((tag) => String(tag).toLowerCase().startsWith(needle))
    .map((tag) => {
      const value = String(tag).trim();
      const suffix = value.slice(prefixLength).trim();

      return {
        value,
        label: suffix ? suffix.charAt(0).toUpperCase() + suffix.slice(1) : "",
        count: null,
      };
    })
    .filter((entry) => {
      const key = entry.value.toLowerCase();
      if (!entry.label || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Prefixes that look like a convention, offered when adding a custom group. */
function suggestTagPrefixes(tags) {
  const counts = new Map();

  tags.forEach((entry) => {
    const tag = String(typeof entry === "string" ? entry : entry.value);
    const separator = tag.search(/[:_]/);

    if (separator < 1) return;

    const prefix = tag.slice(0, separator + 1).toLowerCase();
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  });

  return [...counts.entries()]
    // One tag with a colon in it is not a convention.
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([prefix, count]) => ({ prefix, count }));
}

/* ------------------------------------------------------------------ */

/**
 * Values for one source, whatever kind it is.
 *
 * `price` and `availability` are computed at filter time and have no value
 * list to configure, so they return nothing rather than being special-cased at
 * every call site.
 */
async function fetchValues(shop, source, sourceKey) {
  switch (source) {
    case "vendor":
    case "product_type":
    case "tag":
      return fetchStringList(shop, source);

    case "collection":
      return fetchCollections(shop);

    case "option": {
      const catalogue = await fetchOptionCatalogue(shop);
      const wanted = String(sourceKey || "").trim().toLowerCase();

      const match = Object.keys(catalogue.options).find(
        (name) => name.toLowerCase() === wanted
      );

      return match ? catalogue.options[match] : [];
    }

    case "tag_prefix": {
      const tags = await fetchStringList(shop, "tag");
      return valuesFromTagPrefix(tags, sourceKey);
    }

    case "price":
    case "availability":
      return [];

    default:
      throw new Error(`Unknown filter source: ${source}`);
  }
}

module.exports = {
  PAGE_SIZE,
  MAX_PRODUCT_PAGES,
  fetchStringList,
  fetchCollections,
  fetchOptionCatalogue,
  fetchValues,
  valuesFromTagPrefix,
  suggestTagPrefixes,
  isSyntheticOption,
  tidy,
};

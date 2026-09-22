const crypto = require("crypto");
const filterModel = require("../models/filterModel");

async function buildPublishedFilters(storeId, shop) {
  const groups = await filterModel.listGroupsWithValues(storeId);

  return {
    shop,
    filters: groups
      .filter((group) => group.is_enabled)
      .map((group) => ({
        key: group.filter_key,
        label: group.label,
        source: group.source,
        source_key: group.source_key,
        display: group.display_type,
        collapsed: group.collapsed,
        max_visible: group.max_visible,
        hide_empty: group.hide_empty,
        multi_select: group.multi_select,
        values: group.values
          .filter((value) => !value.is_hidden && !value.missing)
          .map((value) => ({
            value: value.value,
            label: value.label,
            swatch: value.swatch,
            handle: value.handle,
            url: value.url,
          })),
      })),
  };
}

function configEtag(config) {
  return `"${crypto
    .createHash("sha256")
    .update(JSON.stringify(config))
    .digest("base64url")}"`;
}

module.exports = { buildPublishedFilters, configEtag };

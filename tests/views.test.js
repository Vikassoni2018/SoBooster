/* Renders every view with exactly the locals its controller passes.
 *
 * Compiling a template only catches syntax errors -- a variable the controller
 * stopped passing fails at RENDER time and reaches the merchant as a 500.
 * Add a case here for every screen you add.
 */
const path = require("path");
const ejs = require("ejs");

const SERVER = path.join(__dirname, "..");
const VIEWS = path.join(SERVER, "views");

process.env.SHOPIFY_API_KEY = "test_api_key";
process.env.SHOPIFY_API_SECRET = "test_api_secret";
process.env.HOST = "https://app.example.com";

const { serializeForScript } = require(path.join(SERVER, "utils/html"));
const { shopifyAdminUrl } = require(path.join(SERVER, "utils/shop"));

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

/** Render a view the way Express does: same locals, same `json` helper. */
function render(view, locals) {
  return ejs.renderFile(path.join(VIEWS, `${view}.ejs`), {
    json: serializeForScript,
    shopifyAdminUrl,
    ...locals,
  });
}

async function expectRenders(name, view, locals, mustContain = []) {
  try {
    const html = await render(view, locals);
    const missing = mustContain.filter((needle) => !html.includes(needle));

    if (missing.length) {
      check(name, false, `missing: ${missing.join(", ")}`);
      return;
    }

    check(name, html.length > 0);
  } catch (err) {
    check(name, false, err.message.split("\n").pop().trim());
  }
}

const BASE = { shop: "demo.myshopify.com", apiKey: "test_api_key" };

const STORE_ROW = {
  id: 1,
  shop_domain: "demo.myshopify.com",
  store_name: "Demo Store",
  currency: "USD",
  api_version: "2025-01",
  is_active: true,
};

const PLAN_ROWS = [
  {
    id: 1,
    name: "Free",
    price: 0,
    is_popular: 0,
    is_active: 1,
    plan_content: JSON.stringify(["Core features included", "Up to 25 items"]),
  },
  {
    id: 3,
    name: "Pro",
    price: 29,
    is_popular: 1,
    is_active: 1,
    plan_content: JSON.stringify(["Everything in Starter", "Priority support"]),
  },
];

(async () => {
  console.log("\nDashboard");
  await expectRenders(
    "the dashboard renders",
    "dashboard",
    { ...BASE, store: STORE_ROW },
    ["heading=\"Dashboard\"", "Enabled filters", "Store setup", "Quick actions", "s-app-nav"]
  );

  console.log("\nHelp and support");
  await expectRenders(
    "help and support renders",
    "support",
    { ...BASE, store: STORE_ROW },
    ["<h1>Help and support</h1>", "s-app-nav"]
  );

  console.log("\nPlans");
  {
    await expectRenders(
      "every plan is listed",
      "plans",
      {
        ...BASE,
        store: STORE_ROW,
        plans: PLAN_ROWS,
        currentPlan: null,
        billingResult: null,
        billingTest: false,
      },
      ["Free Plan", "Pro Plan", "$0", "$29", "Core features included"]
    );

    const html = await render("plans", {
      ...BASE,
      store: STORE_ROW,
      plans: PLAN_ROWS,
      currentPlan: { membership_id: 1, plan_name: "Free", plan_price: 0 },
      billingResult: "success",
      billingTest: true,
    });

    check("the current plan is marked, not offered again",
      html.includes("Current plan") &&
        !html.includes('data-plan="1"'));
    check("a paid plan is still buyable", html.includes('data-plan="3"'));
    check("the popular plan is badged", html.includes("plan__badge"));
    check("an approved subscription is confirmed",
      html.includes("Your Shopify subscription is active."));
    check("test billing is called out",
      html.includes("Billing test mode is on."));

    const declined = await render("plans", {
      ...BASE,
      store: STORE_ROW,
      plans: PLAN_ROWS,
      currentPlan: null,
      billingResult: "failed",
      billingTest: false,
    });

    check("a declined charge says the plan did not change",
      declined.includes("was not approved"));

    // A plan whose features never got filled in must not take the page down.
    const bare = await render("plans", {
      ...BASE,
      store: STORE_ROW,
      plans: [{ ...PLAN_ROWS[0], plan_content: null }],
      currentPlan: null,
      billingResult: null,
      billingTest: false,
    });

    check("a plan with no features still renders", bare.includes("Free Plan"));
  }

  console.log("\nFilters");
  {
    const GROUPS = [
      {
        id: 1,
        filter_key: "colour",
        label: "Colour",
        source: "option",
        source_key: "Color",
        display_type: "swatch",
        is_enabled: true,
        position: 0,
        option_sort: "alphabetical",
        collapsed: false,
        max_visible: 10,
        hide_empty: true,
        multi_select: true,
        is_custom: true,
        fetchedAt: "2026-09-22T12:00:00.000Z",
        overrides: [],
        values: [
          { value: "Black", label: "Ink", swatch: "#111111", count: 9, is_hidden: false, position: null, customised: true, missing: false },
          { value: "Red", label: "Red", swatch: null, count: 4, is_hidden: true, position: null, customised: true, missing: false },
        ],
      },
      {
        id: 2,
        filter_key: "price",
        label: "Price",
        source: "price",
        source_key: null,
        display_type: "range",
        is_enabled: true,
        position: 1,
        option_sort: "alphabetical",
        collapsed: false,
        max_visible: 10,
        hide_empty: true,
        multi_select: true,
        is_custom: false,
        fetchedAt: null,
        overrides: [],
        values: [],
      },
    ];

    const locals = {
      ...BASE,
      store: STORE_ROW,
      groups: GROUPS,
      sources: {
        options: [{ name: "Color", count: 5 }],
        tagPrefixes: [{ prefix: "material:", count: 3 }],
        fetchedAt: "2026-09-22T12:00:00.000Z",
      },
      allowedDisplay: {
        option: ["checkbox", "swatch", "dropdown", "button"],
        price: ["range"],
      },
    };

    await expectRenders("the filter settings screen renders", "filters", locals, [
      "<h1>Filters</h1>",
      'id="bootstrap"',
      "/javascript/filters.js",
      'id="add-dialog"',
    ]);

    // The screen is drawn from this payload; if it is not valid JSON the page
    // paints an empty shell and nothing else.
    const html = await render("filters", locals);
    const payload = html.match(
      /<script id="bootstrap" type="application\/json">([\s\S]*?)<\/script>/
    );

    let parsed = null;
    try {
      parsed = JSON.parse(payload[1]);
    } catch (err) {
      /* reported by the check below */
    }

    check("the bootstrap payload is valid JSON", parsed !== null);
    check("it carries the groups", parsed && parsed.groups.length === 2);
    check("it carries the values", parsed && parsed.groups[0].values.length === 2);
    check("it carries the option names found in the shop",
      parsed && parsed.sources.options[0].name === "Color");
    check("it carries the display rules",
      parsed && parsed.allowedDisplay.price.length === 1);

    // A vendor or colour named by the merchant's own Shopify data must arrive
    // as text, not as markup.
    const hostile = await render("filters", {
      ...locals,
      groups: [
        {
          ...GROUPS[0],
          label: '</script><img src=x onerror=alert(1)>',
          values: [{ ...GROUPS[0].values[0], value: '</script><b>x</b>' }],
        },
      ],
    });

    check("a hostile label cannot close the script block",
      !hostile.includes("</script><img"));
    check("a hostile value cannot either",
      !hostile.includes("</script><b>"));
  }

  console.log("\nInstall");
  await expectRenders(
    "the install page renders",
    "install",
    { error: null, value: "" },
    ["Install SoBooster", 'action="/api/auth/install"']
  );
  await expectRenders(
    "the install page shows a typo back to the merchant",
    "install",
    { error: "That does not look like a Shopify store address.", value: "nope" },
    ["notice--error", 'value="nope"']
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

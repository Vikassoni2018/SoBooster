/* Filter settings.
 *
 * Two panes: the groups on the left in storefront order, the selected group's
 * settings on the right.
 *
 * Every change is a small JSON call, and every response carries the WHOLE
 * configuration back, which the screen redraws from. That is deliberate: an
 * optimistic local update would eventually disagree with what was actually
 * saved -- a rejected label, a clamped number, a rule about which display
 * types a source allows -- and the merchant would be looking at a setting that
 * does not exist. Redrawing from the server's answer means the screen can only
 * ever show saved state.
 *
 * Built with createElement and textContent throughout: a vendor called
 * `<img onerror=...>` is a vendor name, not markup.
 */
(function () {
  "use strict";

  var boot = JSON.parse(document.getElementById("bootstrap").textContent);

  var groups = boot.groups;
  var sources = boot.sources;
  var allowedDisplay = boot.allowedDisplay;

  var selectedId = groups.length ? groups[0].id : null;

  var el = {
    list: document.getElementById("group-list"),
    editor: document.getElementById("editor"),
    error: document.getElementById("page-error"),
    warn: document.getElementById("page-warn"),
    refresh: document.getElementById("refresh"),
    age: document.getElementById("catalogue-age"),
    addGroup: document.getElementById("add-group"),
    dialog: document.getElementById("add-dialog"),
    addForm: document.getElementById("add-form"),
    addSource: document.getElementById("add-source"),
    addSourceHelp: document.getElementById("add-source-help"),
    addKeyField: document.getElementById("add-key-field"),
    addKey: document.getElementById("add-key"),
    addLabel: document.getElementById("add-label"),
    addError: document.getElementById("add-error"),
    addCancel: document.getElementById("add-cancel"),
    addSave: document.getElementById("add-save"),
  };

  var SOURCE_LABELS = {
    vendor: "Vendor",
    product_type: "Product type",
    collection: "Collection",
    tag: "Tag",
    option: "Product option",
    tag_prefix: "Tag prefix",
    price: "Price",
    availability: "Availability",
  };

  var DISPLAY_LABELS = {
    checkbox: "Checkbox list",
    swatch: "Colour swatches",
    dropdown: "Dropdown",
    button: "Buttons",
    range: "Price range",
  };

  var SORT_LABELS = {
    manual: "Manual (pinned first)",
    alphabetical: "A to Z",
    count: "Most products first",
  };

  /* ---------------- helpers ---------------- */

  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function selected() {
    return groups.filter(function (group) {
      return group.id === selectedId;
    })[0] || null;
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = !message;
    if (message) el.error.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function showWarning(message) {
    el.warn.textContent = message || "";
    el.warn.hidden = !message;
  }

  /**
   * Every write goes through here.
   *
   * On success the response IS the new configuration, so there is exactly one
   * place that adopts state and exactly one that redraws.
   */
  function save(path, options) {
    showError("");
    setBusy(true);

    return window
      .appFetch("/filters" + path, options)
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw new Error(body.error || "Could not save that.");
          return body;
        });
      })
      .then(function (body) {
        adopt(body);
        return body;
      })
      .catch(function (error) {
        showError(error.message);
        throw error;
      })
      .then(
        function (body) {
          setBusy(false);
          return body;
        },
        function (error) {
          setBusy(false);
          throw error;
        }
      );
  }

  function adopt(body) {
    groups = body.groups;
    if (body.sources) sources = body.sources;

    // The selected group may have just been deleted.
    if (!selected()) selectedId = groups.length ? groups[0].id : null;

    render();
  }

  function setBusy(busy) {
    document.body.classList.toggle("is-busy", Boolean(busy));
  }

  function json(method, body) {
    return {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    };
  }

  /* ---------------- the group list ---------------- */

  function render() {
    renderList();
    renderEditor();
    renderAge();
  }

  function renderList() {
    clear(el.list);

    if (!groups.length) {
      el.list.appendChild(h("li", "muted", "No filters yet. Add one to start."));
      return;
    }

    groups.forEach(function (group) {
      var item = h("li", "group" + (group.id === selectedId ? " group--on" : ""));
      item.draggable = true;
      item.dataset.id = String(group.id);

      var handle = h("span", "group__grip", "⠿");
      handle.setAttribute("aria-hidden", "true");
      item.appendChild(handle);

      var button = h("button", "group__pick");
      button.type = "button";
      button.appendChild(h("span", "group__name", group.label));

      var meta = SOURCE_LABELS[group.source] || group.source;
      if (group.source_key) meta += " · " + group.source_key;
      if (!group.is_enabled) meta += " · off";

      button.appendChild(h("span", "group__meta", meta));
      button.addEventListener("click", function () {
        selectedId = group.id;
        render();
      });

      item.appendChild(button);

      // The one control worth having without opening the group.
      var toggle = switchControl(group.is_enabled, function (on) {
        return save("/groups/" + group.id, json("PATCH", { is_enabled: on }));
      }, group.is_enabled ? "Turn off " + group.label : "Turn on " + group.label);

      item.appendChild(toggle);

      wireDrag(item);
      el.list.appendChild(item);
    });
  }

  function switchControl(isOn, onChange, label) {
    var wrap = h("label", "switch");

    var input = document.createElement("input");
    input.type = "checkbox";
    input.className = "switch__input";
    input.checked = Boolean(isOn);
    input.setAttribute("aria-label", label || "Enabled");

    input.addEventListener("change", function () {
      onChange(input.checked).catch(function () {
        // The screen redraws from the server on success; on failure put the
        // control back so it cannot show a state that was never saved.
        input.checked = !input.checked;
      });
    });

    wrap.appendChild(input);
    wrap.appendChild(h("span", "switch__track"));
    return wrap;
  }

  /* ---- drag to reorder ---- */

  var dragId = null;

  function wireDrag(item) {
    item.addEventListener("dragstart", function (event) {
      dragId = item.dataset.id;
      item.classList.add("group--dragging");
      event.dataTransfer.effectAllowed = "move";
      // Firefox will not start a drag without data on the transfer.
      event.dataTransfer.setData("text/plain", dragId);
    });

    item.addEventListener("dragend", function () {
      item.classList.remove("group--dragging");
      dragId = null;
    });

    item.addEventListener("dragover", function (event) {
      if (dragId === null || dragId === item.dataset.id) return;

      event.preventDefault();

      var box = item.getBoundingClientRect();
      var below = event.clientY > box.top + box.height / 2;
      var dragged = el.list.querySelector('[data-id="' + dragId + '"]');

      if (!dragged) return;

      // Move the element as the pointer passes the midpoint, so the list shows
      // the result before the drop rather than rearranging afterwards.
      el.list.insertBefore(dragged, below ? item.nextSibling : item);
    });

    item.addEventListener("drop", function (event) {
      event.preventDefault();

      var order = Array.prototype.map.call(
        el.list.querySelectorAll(".group"),
        function (node) {
          return Number(node.dataset.id);
        }
      );

      save("/groups/reorder", json("POST", { order: order })).catch(function () {
        render();
      });
    });
  }

  /* ---------------- the editor ---------------- */

  function renderEditor() {
    clear(el.editor);

    var group = selected();

    if (!group) {
      var blank = h("div", "empty");
      blank.appendChild(h("h2", null, "No filter selected"));
      blank.appendChild(h("p", null, "Add a filter to configure it."));
      el.editor.appendChild(blank);
      return;
    }

    el.editor.appendChild(editorHead(group));
    el.editor.appendChild(basicsPanel(group));
    el.editor.appendChild(behaviourPanel(group));

    // Price and availability have no value list -- there is nothing to rename,
    // hide or reorder, so the panel is omitted rather than shown empty.
    if (group.source !== "price" && group.source !== "availability") {
      el.editor.appendChild(valuesPanel(group));
    }
  }

  function editorHead(group) {
    var head = h("div", "editor__head");

    var text = h("div");
    text.appendChild(h("h2", "editor__title", group.label));

    var meta = SOURCE_LABELS[group.source] || group.source;
    if (group.source_key) meta += " · " + group.source_key;
    meta += group.is_custom ? " · custom filter" : " · built in";

    text.appendChild(h("p", "muted", meta));
    head.appendChild(text);

    if (group.is_custom) {
      var remove = h("button", "btn btn--danger btn--small", "Delete");
      remove.type = "button";
      remove.addEventListener("click", function () {
        if (!window.confirm('Delete the "' + group.label + '" filter?')) return;
        save("/groups/" + group.id, { method: "DELETE" });
      });
      head.appendChild(remove);
    }

    return head;
  }

  function panel(title) {
    var section = h("section", "panel editor__panel");
    section.appendChild(h("h3", "panel__title", title));
    return section;
  }

  /* ---- basics: name, display type, on/off ---- */

  function basicsPanel(group) {
    var section = panel("Basics");

    section.appendChild(
      textField("Name shown to shoppers", group.label, function (value) {
        return save("/groups/" + group.id, json("PATCH", { label: value }));
      })
    );

    var allowed = allowedDisplay[group.source] || Object.keys(DISPLAY_LABELS);

    if (allowed.length > 1) {
      section.appendChild(
        selectField(
          "Display as",
          allowed.map(function (type) {
            return { value: type, label: DISPLAY_LABELS[type] || type };
          }),
          group.display_type,
          function (value) {
            return save("/groups/" + group.id, json("PATCH", { display_type: value }));
          }
        )
      );
    } else {
      var fixed = h("div", "field");
      fixed.appendChild(h("span", "field__label", "Display as"));
      fixed.appendChild(h("p", "field__static", DISPLAY_LABELS[allowed[0]] || allowed[0]));
      fixed.appendChild(
        h("p", "field__help", "A " + (SOURCE_LABELS[group.source] || group.source).toLowerCase() +
          " filter only renders one way.")
      );
      section.appendChild(fixed);
    }

    section.appendChild(
      toggleField(
        "Show on the storefront",
        group.is_enabled,
        "Turn off to hide this filter without losing its settings.",
        function (on) {
          return save("/groups/" + group.id, json("PATCH", { is_enabled: on }));
        }
      )
    );

    return section;
  }

  /* ---- behaviour ---- */

  function behaviourPanel(group) {
    var section = panel("Behaviour");

    if (group.source !== "price") {
      section.appendChild(
        selectField(
          "Order values by",
          Object.keys(SORT_LABELS).map(function (key) {
            return { value: key, label: SORT_LABELS[key] };
          }),
          group.option_sort,
          function (value) {
            return save("/groups/" + group.id, json("PATCH", { option_sort: value }));
          }
        )
      );

      section.appendChild(
        numberField(
          "Values shown before “show more”",
          group.max_visible,
          1,
          100,
          function (value) {
            return save("/groups/" + group.id, json("PATCH", { max_visible: value }));
          }
        )
      );

      section.appendChild(
        toggleField(
          "Allow more than one at a time",
          group.multi_select,
          "Off means choosing a value replaces the previous one.",
          function (on) {
            return save("/groups/" + group.id, json("PATCH", { multi_select: on }));
          }
        )
      );

      section.appendChild(
        toggleField(
          "Hide values with no products",
          group.hide_empty,
          "Keeps the panel to what a shopper can actually pick.",
          function (on) {
            return save("/groups/" + group.id, json("PATCH", { hide_empty: on }));
          }
        )
      );
    }

    section.appendChild(
      toggleField(
        "Start collapsed",
        group.collapsed,
        "Shoppers open the filter themselves. Useful for long lists.",
        function (on) {
          return save("/groups/" + group.id, json("PATCH", { collapsed: on }));
        }
      )
    );

    return section;
  }

  /* ---- values ---- */

  function valuesPanel(group) {
    var section = panel("Values");

    var head = h("div", "values__head");
    var shown = group.values.filter(function (value) {
      return !value.is_hidden;
    }).length;

    head.appendChild(
      h("p", "muted",
        group.values.length
          ? shown + " of " + group.values.length + " shown to shoppers"
          : "No values found for this filter."
      )
    );

    var customised = group.values.some(function (value) {
      return value.customised;
    });

    if (customised) {
      var reset = h("button", "btn btn--quiet btn--small", "Reset all");
      reset.type = "button";
      reset.addEventListener("click", function () {
        if (!window.confirm("Undo every change to this filter's values?")) return;
        save("/groups/" + group.id + "/options/reset", json("POST"));
      });
      head.appendChild(reset);
    }

    section.appendChild(head);

    if (!group.values.length) {
      var help = h("p", "field__help");
      help.textContent =
        group.source === "option"
          ? 'No product uses an option called "' + group.source_key + '". ' +
            "Refresh from Shopify after adding one."
          : "Refresh from Shopify to read this list again.";
      section.appendChild(help);
      return section;
    }

    var list = h("ul", "values");

    group.values.forEach(function (value) {
      list.appendChild(valueRow(group, value));
    });

    section.appendChild(list);
    return section;
  }

  function valueRow(group, value) {
    var item = h("li", "value" + (value.is_hidden ? " value--off" : ""));

    /* show / hide */
    var visible = document.createElement("input");
    visible.type = "checkbox";
    visible.className = "value__show";
    visible.checked = !value.is_hidden;
    visible.setAttribute("aria-label", "Show " + value.label + " to shoppers");
    visible.addEventListener("change", function () {
      setValue(group, value, { is_hidden: !visible.checked });
    });
    item.appendChild(visible);

    /* swatch, for the groups that render as one */
    if (group.display_type === "swatch") {
      var colour = document.createElement("input");
      colour.type = "color";
      colour.className = "value__swatch";
      colour.value = value.swatch || guessSwatch(value.value);
      colour.setAttribute("aria-label", "Swatch colour for " + value.label);
      colour.addEventListener("change", function () {
        setValue(group, value, { swatch: colour.value });
      });
      item.appendChild(colour);
    }

    /* the raw value, and the label shown in its place */
    var text = h("div", "value__text");

    var label = document.createElement("input");
    label.type = "text";
    label.className = "field__input value__label";
    label.value = value.label;
    label.maxLength = 255;
    label.setAttribute("aria-label", "Label for " + value.value);
    commitOnBlur(label, value.label, function (next) {
      // Clearing the box means "go back to what Shopify calls it".
      setValue(group, value, { label: next === value.value ? "" : next });
    });
    text.appendChild(label);

    var meta = h("span", "value__meta");

    if (value.label !== value.value) {
      meta.appendChild(h("span", "value__raw", value.value));
    }
    if (value.count !== null && value.count !== undefined) {
      meta.appendChild(h("span", null, value.count + " products"));
    }
    if (value.missing) {
      meta.appendChild(h("span", "value__gone", "no longer in Shopify"));
    }

    if (meta.childNodes.length) text.appendChild(meta);

    item.appendChild(text);

    /* pin to the top of the list */
    var pin = h("button", "icon-btn value__pin" + (value.position !== null ? " is-on" : ""), "★");
    pin.type = "button";
    pin.title = value.position !== null ? "Unpin" : "Pin to the top";
    pin.setAttribute("aria-label", pin.title + " " + value.label);
    pin.addEventListener("click", function () {
      setValue(group, value, {
        position: value.position !== null ? null : pinnedCount(group),
      });
    });
    item.appendChild(pin);

    return item;
  }

  function pinnedCount(group) {
    return group.values.filter(function (value) {
      return value.position !== null;
    }).length;
  }

  function setValue(group, value, changes) {
    var body = { value: value.value };

    Object.keys(changes).forEach(function (key) {
      body[key] = changes[key];
    });

    return save("/groups/" + group.id + "/options", json("POST", body));
  }

  /* A colour input needs a value; give it a sensible starting point for the
     colours a clothing catalogue actually uses. */
  var KNOWN_COLOURS = {
    black: "#1a1a1a", white: "#f5f5f5", ivory: "#f2ead9", red: "#c02637",
    burgundy: "#6d1f2f", pink: "#e87ca4", blue: "#2f5fb3", navy: "#1c2a4d",
    green: "#1c7a5a", emerald: "#1c7a5a", silver: "#c3c7cc", gold: "#c9a227",
    lavender: "#b49ad6", purple: "#6b4a9c", orange: "#d97b2b", yellow: "#e3c548",
    brown: "#7a5539", grey: "#9aa0a6", gray: "#9aa0a6", beige: "#e3d6bf",
  };

  function guessSwatch(name) {
    return KNOWN_COLOURS[String(name || "").trim().toLowerCase()] || "#cccccc";
  }

  /* ---------------- field builders ---------------- */

  function field(label, help) {
    var wrap = h("div", "field");
    wrap.appendChild(h("span", "field__label", label));
    if (help) wrap.dataset.help = help;
    return wrap;
  }

  /**
   * Text fields save on blur and on Enter, not on every keystroke: a request
   * per character would be a request per character.
   */
  function commitOnBlur(input, original, commit) {
    var last = original;

    function maybeCommit() {
      var next = input.value.trim();

      if (next === last) return;
      if (!next) {
        input.value = last;
        return;
      }

      last = next;
      commit(next);
    }

    input.addEventListener("blur", maybeCommit);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
      if (event.key === "Escape") {
        input.value = last;
        input.blur();
      }
    });
  }

  function textField(label, value, commit) {
    var wrap = field(label);

    var input = document.createElement("input");
    input.type = "text";
    input.className = "field__input";
    input.value = value;
    input.maxLength = 128;

    commitOnBlur(input, value, commit);
    wrap.appendChild(input);
    return wrap;
  }

  function numberField(label, value, min, max, commit) {
    var wrap = field(label);

    var input = document.createElement("input");
    input.type = "number";
    input.className = "field__input field__input--compact";
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);

    commitOnBlur(input, String(value), function (next) {
      commit(Number(next));
    });

    wrap.appendChild(input);
    return wrap;
  }

  function selectField(label, options, current, commit) {
    var wrap = field(label);

    var select = document.createElement("select");
    select.className = "field__input field__input--select";

    options.forEach(function (option) {
      var node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      node.selected = option.value === current;
      select.appendChild(node);
    });

    select.addEventListener("change", function () {
      commit(select.value).catch(function () {
        select.value = current;
      });
    });

    wrap.appendChild(select);
    return wrap;
  }

  function toggleField(label, isOn, help, commit) {
    var wrap = h("div", "field field--switch");

    var text = h("div");
    text.appendChild(h("span", "field__label", label));
    if (help) text.appendChild(h("span", "field__help", help));

    wrap.appendChild(text);
    wrap.appendChild(switchControl(isOn, commit, label));
    return wrap;
  }

  /* ---------------- catalogue freshness ---------------- */

  function renderAge() {
    if (!sources.fetchedAt) {
      el.age.textContent = "Catalogue not read yet";
      return;
    }

    var when = new Date(sources.fetchedAt);
    el.age.textContent = isNaN(when.getTime())
      ? ""
      : "Values read " + relative(when);
  }

  function relative(date) {
    var seconds = Math.round((Date.now() - date.getTime()) / 1000);

    if (seconds < 90) return "just now";
    if (seconds < 3600) return Math.round(seconds / 60) + " minutes ago";
    if (seconds < 86400) return Math.round(seconds / 3600) + " hours ago";
    return Math.round(seconds / 86400) + " days ago";
  }

  el.refresh.addEventListener("click", function () {
    showWarning("");
    el.refresh.disabled = true;
    el.refresh.textContent = "Reading…";

    save("/refresh", json("POST"))
      .then(function (body) {
        var report = body.report || {};

        if (report.failed && report.failed.length) {
          showError(
            "Some values could not be read: " +
              report.failed
                .map(function (item) {
                  return item.source;
                })
                .join(", ")
          );
        }

        if (report.truncated) {
          showWarning(
            "Read the first " + report.scanned + " products. Option values " +
              "below that are not listed yet."
          );
        }
      })
      .catch(function () {
        /* already shown */
      })
      .then(function () {
        el.refresh.disabled = false;
        el.refresh.textContent = "Refresh from Shopify";
      });
  });

  /* ---------------- adding a filter ---------------- */

  function sourceChoices() {
    var choices = [
      { value: "collection", label: "Collection" },
      { value: "product_type", label: "Product type" },
      { value: "vendor", label: "Vendor" },
      { value: "tag", label: "Tag" },
      { value: "price", label: "Price" },
      { value: "availability", label: "Availability" },
    ];

    // Product options are offered by NAME, taken from the shop's own products,
    // so a merchant picks "Color" rather than guessing what it is called.
    (sources.options || []).forEach(function (option) {
      choices.push({
        value: "option:" + option.name,
        label: "Option: " + option.name,
        help: option.count + " values found in your products",
      });
    });

    (sources.tagPrefixes || []).forEach(function (entry) {
      choices.push({
        value: "tag_prefix:" + entry.prefix,
        label: "Tags starting with “" + entry.prefix + "”",
        help: entry.count + " tags use this prefix",
      });
    });

    choices.push({
      value: "tag_prefix:",
      label: "Tags starting with… (type it)",
      help: "For a tag convention not listed above.",
    });

    return choices;
  }

  function openAddDialog() {
    var choices = sourceChoices();

    clear(el.addSource);

    choices.forEach(function (choice) {
      var node = document.createElement("option");
      node.value = choice.value;
      node.textContent = choice.label;
      node.dataset.help = choice.help || "";
      el.addSource.appendChild(node);
    });

    el.addError.hidden = true;
    el.addKey.value = "";
    syncAddDialog();
    el.dialog.showModal();
    el.addLabel.focus();
  }

  /** Keep the dialog's fields in step with the chosen source. */
  function syncAddDialog() {
    var choice = el.addSource.value || "";
    var parts = splitChoice(choice);
    var option = el.addSource.selectedOptions[0];

    el.addSourceHelp.textContent = option ? option.dataset.help || "" : "";

    // Only a hand-typed tag prefix needs the extra box; a listed one already
    // carries its prefix.
    var needsKey = parts.source === "tag_prefix" && !parts.key;
    el.addKeyField.hidden = !needsKey;

    // Pre-fill the name with something sensible, but only while the merchant
    // has not typed their own.
    if (!el.addLabel.dataset.touched) {
      el.addLabel.value = suggestLabel(parts);
    }
  }

  function splitChoice(choice) {
    var colon = choice.indexOf(":");

    if (colon === -1) return { source: choice, key: "" };

    return {
      source: choice.slice(0, colon),
      key: choice.slice(colon + 1),
    };
  }

  function suggestLabel(parts) {
    if (parts.source === "option") return parts.key;

    if (parts.source === "tag_prefix") {
      if (!parts.key) return "";
      var stripped = parts.key.replace(/[:_]\s*$/, "");
      return stripped.charAt(0).toUpperCase() + stripped.slice(1);
    }

    return SOURCE_LABELS[parts.source] || parts.source;
  }

  el.addSource.addEventListener("change", syncAddDialog);

  el.addKey.addEventListener("input", function () {
    if (el.addLabel.dataset.touched) return;
    el.addLabel.value = suggestLabel({ source: "tag_prefix", key: el.addKey.value });
  });

  el.addLabel.addEventListener("input", function () {
    el.addLabel.dataset.touched = el.addLabel.value ? "1" : "";
  });

  el.addGroup.addEventListener("click", function () {
    el.addLabel.dataset.touched = "";
    openAddDialog();
  });

  el.addCancel.addEventListener("click", function () {
    el.dialog.close();
  });

  el.addForm.addEventListener("submit", function (event) {
    event.preventDefault();

    var parts = splitChoice(el.addSource.value);
    var sourceKey = parts.key || el.addKey.value.trim();

    el.addError.hidden = true;

    if (parts.source === "tag_prefix" && !sourceKey) {
      el.addError.textContent = "Enter the tag prefix to read values from.";
      el.addError.hidden = false;
      return;
    }

    el.addSave.disabled = true;

    save(
      "/groups",
      json("POST", {
        source: parts.source,
        source_key: sourceKey,
        label: el.addLabel.value.trim(),
        display_type: parts.source === "price" ? "range" : "checkbox",
      })
    )
      .then(function () {
        // Select the group that was just added: it is the one the merchant
        // now wants to configure.
        selectedId = groups.length ? groups[groups.length - 1].id : null;
        render();
        el.dialog.close();
      })
      .catch(function (error) {
        el.addError.textContent = error.message;
        el.addError.hidden = false;
        showError("");
      })
      .then(function () {
        el.addSave.disabled = false;
      });
  });

  /* ---------------- first paint ---------------- */

  render();
})();

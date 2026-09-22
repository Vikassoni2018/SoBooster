class SoBoosterFilters extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;
    this.form = this.querySelector("[data-sbf-form]");
    this.groups = this.querySelector("[data-sbf-groups]");
    this.panel = this.querySelector(".sbf__panel");
    this.opener = this.querySelector(".sbf__mobile-open");
    this.shade = this.querySelector(".sbf__backdrop");
    this.auto = this.dataset.autoApply === "true";
    this.bindEvents();
    this.loadConfiguration();
  }

  bindEvents() {
    this.opener?.addEventListener("click", () => this.openPanel());
    this.querySelectorAll("[data-sbf-close]").forEach((button) => {
      button.addEventListener("click", () => this.closePanel());
    });

    this.querySelector("[data-sbf-sort]")?.addEventListener("change", (event) => {
      const hidden = this.querySelector("[data-sbf-sort-hidden]");
      if (hidden) hidden.value = event.target.value;
      this.form.requestSubmit();
    });

    this.form?.addEventListener("change", (event) => {
      const input = event.target;
      const group = input.closest("[data-configured-group]");

      if (input.matches('input[type="checkbox"]') && group?.dataset.multiSelect === "false") {
        group.querySelectorAll('input[type="checkbox"]').forEach((other) => {
          if (other !== input) other.checked = false;
        });
      }

      if (this.auto) {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => this.form.requestSubmit(), input.matches('input[type="number"]') ? 350 : 120);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.classList.contains("is-open")) this.closePanel();
    });
  }

  openPanel() {
    this.classList.add("is-open");
    this.opener?.setAttribute("aria-expanded", "true");
    if (this.shade) this.shade.hidden = false;
    document.documentElement.classList.add("sbf-lock");
    this.panel?.querySelector("button, input, select, summary")?.focus();
  }

  closePanel() {
    this.classList.remove("is-open");
    this.opener?.setAttribute("aria-expanded", "false");
    if (this.shade) this.shade.hidden = true;
    document.documentElement.classList.remove("sbf-lock");
    this.opener?.focus();
  }

  async loadConfiguration() {
    try {
      const response = await fetch(this.dataset.configUrl, {
        headers: { Accept: "application/json" },
      });

      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      this.applyConfiguration(Array.isArray(body.filters) ? body.filters : []);
    } catch {
    } finally {
      this.dataset.ready = "true";
    }
  }

  applyConfiguration(filters) {
    const native = [...this.querySelectorAll("[data-native-filter]")];
    const used = new Set();
    const ordered = [];
    const missing = [];

    filters.forEach((config) => {
      if (config.source === "collection") {
        const node = this.createCollectionGroup(config);
        if (node) ordered.push(node);
        return;
      }

      const group = native.find((candidate) => {
        return !used.has(candidate) && this.matches(candidate, config);
      });

      if (!group) {
        missing.push(config.label);
        return;
      }

      used.add(group);
      this.configureNativeGroup(group, config);
      ordered.push(group);
    });

    native.forEach((group) => {
      if (!used.has(group)) group.remove();
    });
    ordered.forEach((group) => this.groups.appendChild(group));

    if (missing.length && this.dataset.designMode === "true") {
      const notice = this.querySelector("[data-sbf-editor-notice]");
      notice.textContent = `${this.dataset.missingFilter} (${missing.join(", ")})`;
      notice.hidden = false;
    }
  }

  matches(group, config) {
    const param = this.normalize(group.dataset.filterParam);
    const label = this.normalize(group.dataset.filterLabel);
    const key = this.normalize(config.source_key);
    const type = group.dataset.filterType;

    if (config.source === "price") return type === "price_range";
    if (config.source === "availability") return param.includes("availability");
    if (config.source === "vendor") return param.includes("vendor") || label === "vendor";
    if (config.source === "product_type") return param.includes("producttype") || label === "producttype";
    if (config.source === "tag" || config.source === "tag_prefix") return param.includes("tag");
    if (config.source === "option") {
      return param.includes(`option${key}`) || label === key;
    }
    return label === this.normalize(config.label);
  }

  configureNativeGroup(group, config) {
    group.dataset.configuredGroup = config.key;
    group.dataset.display = config.display;
    group.dataset.multiSelect = String(config.multi_select);
    group.open = !config.collapsed;
    const heading = group.querySelector("[data-sbf-group-label]");
    if (heading) heading.textContent = config.label;

    const allowed = new Map(
      (config.values || []).map((value) => [this.normalize(value.value), value])
    );
    const options = [...group.querySelectorAll("[data-filter-option]")];

    options.forEach((option) => {
      const item = allowed.get(this.normalize(option.dataset.value));
      const count = Number(option.querySelector(".sbf__option-count")?.textContent || 0);

      if ((allowed.size && !item) || (config.hide_empty && count === 0 && !option.querySelector("input")?.checked)) {
        option.remove();
        return;
      }

      if (item) {
        option.querySelector("[data-sbf-option-label]").textContent = item.label;
        if (item.swatch) option.style.setProperty("--sbf-swatch", item.swatch);
      }
    });

    this.limitOptions(group, Number(config.max_visible) || 10);
    if (config.display === "dropdown") this.addDropdown(group, config);
  }

  limitOptions(group, maximum) {
    const options = [...group.querySelectorAll("[data-filter-option]")];
    const hidden = options.filter((option, index) => {
      const shouldHide = index >= maximum && !option.querySelector("input")?.checked;
      option.hidden = shouldHide;
      return shouldHide;
    });

    if (!hidden.length) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "sbf__more";
    button.textContent = this.text("showMore", "Show more");
    button.addEventListener("click", () => {
      const expanded = button.dataset.expanded === "true";
      hidden.forEach((option) => { option.hidden = expanded; });
      button.dataset.expanded = String(!expanded);
      button.textContent = expanded
        ? this.text("showMore", "Show more")
        : this.text("showLess", "Show less");
    });
    group.querySelector(".sbf__group-body")?.appendChild(button);
  }

  addDropdown(group, config) {
    const options = [...group.querySelectorAll("[data-filter-option]")];
    if (!options.length) return;
    const select = document.createElement("select");
    select.className = "sbf__select";
    select.multiple = Boolean(config.multi_select);
    select.setAttribute("aria-label", config.label);

    if (!select.multiple) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = config.label;
      select.appendChild(placeholder);
    }

    options.forEach((row) => {
      const input = row.querySelector("input");
      const option = document.createElement("option");
      option.value = input.value;
      option.textContent = `${row.querySelector("[data-sbf-option-label]").textContent} (${row.querySelector(".sbf__option-count").textContent})`;
      option.selected = input.checked;
      option.disabled = input.disabled;
      select.appendChild(option);
    });

    select.addEventListener("change", () => {
      const selected = new Set([...select.selectedOptions].map((option) => option.value));
      options.forEach((row) => {
        const input = row.querySelector("input");
        input.checked = selected.has(input.value);
      });
      if (this.auto) this.form.requestSubmit();
    });

    group.querySelector("[data-sbf-options]")?.after(select);
  }

  createCollectionGroup(config) {
    if (!Array.isArray(config.values) || !config.values.length) return null;
    const details = document.createElement("details");
    details.className = "sbf__group";
    details.dataset.configuredGroup = config.key;
    details.dataset.display = config.display;
    details.open = !config.collapsed;

    const summary = document.createElement("summary");
    summary.className = "sbf__summary";
    const title = document.createElement("span");
    title.textContent = config.label;
    summary.appendChild(title);
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "sbf__group-body";
    const options = document.createElement("div");
    options.className = "sbf__options sbf__collection-options";

    config.values.forEach((value) => {
      const link = document.createElement("a");
      link.className = "sbf__option sbf__collection-link";
      link.dataset.filterOption = "";
      link.href = value.url || `/collections/${encodeURIComponent(value.handle || value.value)}`;
      link.textContent = value.label;
      if (new URL(link.href, window.location.origin).pathname === window.location.pathname) {
        link.setAttribute("aria-current", "page");
      }
      options.appendChild(link);
    });

    body.appendChild(options);
    details.appendChild(body);
    this.limitOptions(details, Number(config.max_visible) || 10);
    return details;
  }

  text(key, fallback) {
    return this.dataset[key] || fallback;
  }

  normalize(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
}

if (!customElements.get("sobooster-filters")) {
  customElements.define("sobooster-filters", SoBoosterFilters);
}

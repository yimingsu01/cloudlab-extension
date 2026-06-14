(function runCloudLabHostDownloader() {
  "use strict";

  const core = window.CloudLabHostDownloaderCore || globalThis.CloudLabHostDownloaderCore;
  const BUTTON_CLASS = "cloudlab-host-downloader-button";
  const DASHBOARD_PANEL_ID = "cloudlab-host-downloader-dashboard-panel";
  const TARGET_ATTR = "data-cloudlab-host-downloader-target";
  const SCAN_DELAY_MS = 250;

  let scanTimer = 0;
  let pageContext;
  let dashboardLoadPromise;
  let dashboardLoadError = "";
  let dashboardRowsRendered = false;

  if (!core) {
    if (document.body && /\/(?:portal\/)?user-dashboard\.php$/.test(location.pathname)) {
      const panel = document.createElement("div");
      panel.id = DASHBOARD_PANEL_ID;
      panel.textContent =
        "CloudLab Host Downloader loaded, but its shared parser script did not initialize.";
      document.body.prepend(panel);
    }
    return;
  }

  function readPageGlobal(path) {
    try {
      const pageWindow = window.wrappedJSObject || window;
      return path.reduce((value, key) => {
        if (!value) {
          return undefined;
        }
        return value[key];
      }, pageWindow);
    } catch (_error) {
      return undefined;
    }
  }

  function readInlineScriptValue(pattern) {
    for (const script of document.scripts) {
      const text = script.textContent || "";
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return "";
  }

  function readUserIdFromDom() {
    const selectors = [
      "[data-uid]",
      "[data-user]",
      "a[href*='user-dashboard.php']",
      "a[href*='showuser.php']"
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) {
        continue;
      }

      const href = element.getAttribute("href");
      if (href) {
        const url = new URL(href, location.href);
        const hrefUser =
          url.searchParams.get("user") ||
          url.searchParams.get("uid") ||
          url.searchParams.get("target_user");
        const cleanedHrefUser = cleanCloudLabUserId(hrefUser);
        if (cleanedHrefUser) {
          return cleanedHrefUser;
        }
      }

      const candidate =
        element.getAttribute("data-uid") ||
        element.getAttribute("data-user");
      const cleaned = cleanCloudLabUserId(candidate);
      if (cleaned) {
        return cleaned;
      }
    }

    return "";
  }

  function cleanCloudLabUserId(value) {
    const cleaned = String(value || "").trim();
    if (!cleaned || cleaned.length > 64) {
      return "";
    }

    const match = cleaned.match(/[A-Za-z0-9][A-Za-z0-9._-]{0,63}/);
    return match ? match[0] : "";
  }

  function getPageContext() {
    if (pageContext) {
      return pageContext;
    }

    const loginUserId =
      cleanCloudLabUserId(readPageGlobal(["APT_OPTIONS", "thisUid"])) ||
      cleanCloudLabUserId(readPageGlobal(["APT_OPTIONS", "this_uid"])) ||
      cleanCloudLabUserId(readPageGlobal(["LOGINUID"])) ||
      cleanCloudLabUserId(
        readInlineScriptValue(/thisUid["']?\s*[:=]\s*["']([^"']+)["']/)
      ) ||
      cleanCloudLabUserId(
        readInlineScriptValue(/LOGINUID\s*=\s*["']([^"']+)["']/)
      );

    const targetUserId =
      cleanCloudLabUserId(readPageGlobal(["TARGET_USER"])) ||
      cleanCloudLabUserId(
        readInlineScriptValue(/TARGET_USER\s*=\s*["']([^"']+)["']/)
      ) ||
      cleanCloudLabUserId(new URL(location.href).searchParams.get("target_user"));

    const userId =
      loginUserId ||
      targetUserId ||
      readUserIdFromDom();

    const ajaxUrl =
      readPageGlobal(["ajaxurl"]) ||
      readPageGlobal(["APT_OPTIONS", "ajaxurl"]) ||
      readInlineScriptValue(/ajaxurl\s*=\s*["']([^"']+)["']/) ||
      "";

    pageContext = {
      userId,
      targetUserId,
      ajaxUrl: ajaxUrl ? new URL(String(ajaxUrl), location.href).href : ""
    };

    return pageContext;
  }

  function getAjaxUrlCandidates(statusUrl) {
    const candidates = [];
    const context = getPageContext();
    const status = new URL(statusUrl || location.href, location.href);

    const add = (value, base) => {
      if (!value) {
        return;
      }
      const href = new URL(value, base || status.href).href;
      if (!candidates.includes(href)) {
        candidates.push(href);
      }
    };

    add(context.ajaxUrl, status.href);
    add("server-ajax.php", status.href);
    add("/server-ajax.php", status.origin);
    add("/portal/server-ajax.php", status.origin);

    return candidates;
  }

  async function callServerMethod(ajaxUrl, route, method, args) {
    const response = await fetch(ajaxUrl, {
      method: "POST",
      credentials: "include",
      headers: {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: core.buildAjaxFormBody(route, method, args)
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`CloudLab RPC ${method} failed with HTTP ${response.status}`);
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`CloudLab RPC ${method} did not return JSON`);
    }

    if (
      Object.prototype.hasOwnProperty.call(payload, "code") &&
      Number(payload.code) !== 0
    ) {
      const detail =
        typeof payload.value === "string"
          ? payload.value
          : payload.output || payload.error || `code ${payload.code}`;
      throw new Error(`CloudLab RPC ${method} failed: ${detail}`);
    }

    return Object.prototype.hasOwnProperty.call(payload, "value")
      ? payload.value
      : payload;
  }

  async function callServerMethodWithFallback(statusUrl, route, method, args) {
    const failures = [];

    for (const ajaxUrl of getAjaxUrlCandidates(statusUrl)) {
      try {
        const value = await callServerMethod(ajaxUrl, route, method, args);
        return { ajaxUrl, value };
      } catch (error) {
        failures.push(error.message);
      }
    }

    throw new Error(failures.join("; "));
  }

  async function fetchManifestsForExperiment(uuid, statusUrl) {
    const statusResult = await callServerMethodWithFallback(
      statusUrl,
      "status",
      "GetInstanceStatus",
      { uuid }
    );
    const manifestsFromStatus = core.extractManifestXmlStrings(statusResult.value);
    if (manifestsFromStatus.length > 0) {
      return manifestsFromStatus;
    }

    const aggregateUrns = core.extractAggregateUrns(statusResult.value);
    const manifestArgs = { uuid };
    if (aggregateUrns.length > 0) {
      manifestArgs.aggregate_urns = aggregateUrns;
    }

    const manifestValue = await callServerMethod(
      statusResult.ajaxUrl,
      "status",
      "GetInstanceManifests",
      manifestArgs
    );
    return core.extractManifestXmlStrings(manifestValue);
  }

  function extractInlineManifestsFromHtml(htmlText) {
    const manifests = core.extractManifestXmlStrings(htmlText);
    if (manifests.length > 0) {
      return manifests;
    }

    if (typeof DOMParser === "undefined") {
      return [];
    }

    const documentFromHtml = new DOMParser().parseFromString(
      htmlText,
      "text/html"
    );
    const candidateText = Array.from(
      documentFromHtml.querySelectorAll("textarea, pre, code, script")
    ).map((element) => element.textContent || element.value || "");

    return core.extractManifestXmlStrings(candidateText);
  }

  async function fetchFallbackPageManifests(statusUrl) {
    const response = await fetch(statusUrl, {
      method: "GET",
      credentials: "include"
    });
    if (!response.ok) {
      throw new Error(`CloudLab status page fetch failed with HTTP ${response.status}`);
    }

    const htmlText = await response.text();
    return extractInlineManifestsFromHtml(htmlText);
  }

  function hostLinesFromCurrentPage() {
    const lines = [];
    const seen = new Set();
    const sshPattern = /\bssh(?:\s+-[^\n\r]+?)*\s+([A-Za-z0-9._-]+@[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)+)\b/g;
    const text = document.body ? document.body.innerText || "" : "";
    let match;

    while ((match = sshPattern.exec(text)) !== null) {
      if (seen.has(match[1])) {
        continue;
      }
      seen.add(match[1]);
      lines.push(match[1]);
    }

    return lines;
  }

  async function collectHostLines(descriptor) {
    const context = getPageContext();
    let manifests = [];

    try {
      manifests = await fetchManifestsForExperiment(
        descriptor.uuid,
        descriptor.statusUrl
      );
    } catch (rpcError) {
      console.warn("CloudLab Host Downloader RPC fallback:", rpcError);
      manifests = await fetchFallbackPageManifests(descriptor.statusUrl);
    }

    const lines = [];
    const seen = new Set();
    manifests.forEach((manifest) => {
      core.hostLinesFromManifest(manifest, context.userId).forEach((line) => {
        if (seen.has(line)) {
          return;
        }
        seen.add(line);
        lines.push(line);
      });
    });

    if (lines.length === 0 && descriptor.isCurrentPage) {
      hostLinesFromCurrentPage().forEach((line) => {
        if (!seen.has(line)) {
          seen.add(line);
          lines.push(line);
        }
      });
    }

    return lines;
  }

  function downloadTextFile(filename, lines) {
    const blob = new Blob([`${lines.join("\n")}\n`], {
      type: "text/plain;charset=utf-8"
    });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  function makeFilename(descriptor) {
    const label = core.sanitizeFilenamePart(descriptor.label || descriptor.uuid);
    return `${label}-cloudlab-hosts.txt`;
  }

  function setButtonState(button, state, text) {
    button.dataset.state = state;
    button.textContent = text;
    button.disabled = state === "loading";
  }

  async function handleButtonClick(descriptor, button) {
    setButtonState(button, "loading", "Preparing hosts...");

    try {
      const lines = await collectHostLines(descriptor);
      if (lines.length === 0) {
        throw new Error("No SSH login hostnames were found for this experiment.");
      }

      downloadTextFile(makeFilename(descriptor), lines);
      setButtonState(button, "ready", "Download hosts");
    } catch (error) {
      setButtonState(button, "error", "Download failed");
      button.title = error.message;
      window.alert(`CloudLab Host Downloader: ${error.message}`);
    }
  }

  function createButton(descriptor) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.textContent = "Download hosts";
    button.setAttribute(TARGET_ATTR, descriptor.uuid);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleButtonClick(descriptor, button);
    });
    return button;
  }

  function createInlineButton(descriptor) {
    const button = createButton(descriptor);
    button.classList.add("cloudlab-host-downloader-inline-button");
    return button;
  }

  function buttonSelectorForUuid(uuid) {
    const escapedUuid =
      window.CSS && typeof window.CSS.escape === "function"
        ? window.CSS.escape(uuid)
        : String(uuid).replace(/["\\]/g, "\\$&");

    return `[${TARGET_ATTR}="${escapedUuid}"]`;
  }

  function hasButtonForUuid(uuid, scope) {
    const root = scope || document;
    return Boolean(root.querySelector(buttonSelectorForUuid(uuid)));
  }

  function labelFromContainer(container, fallback) {
    const text = (container.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return text || fallback;
  }

  function isVisibleTableCell(cell) {
    if (!cell || cell.hidden || cell.getAttribute("aria-hidden") === "true") {
      return false;
    }

    if (cell.classList.contains("hidden") || cell.classList.contains("hidden-column")) {
      return false;
    }

    const style = window.getComputedStyle(cell);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function lastVisibleTableCell(row) {
    return Array.from(row.querySelectorAll("td, th"))
      .reverse()
      .find(isVisibleTableCell);
  }

  function firstVisibleTableCell(row) {
    return Array.from(row.querySelectorAll("td, th")).find(isVisibleTableCell);
  }

  function appendButtonToContainer(container, descriptor) {
    if (!container || hasButtonForUuid(descriptor.uuid, container)) {
      return;
    }

    const button = createButton(descriptor);
    if (container.matches("tr")) {
      if (appendDashboardNameButton(container, descriptor)) {
        return;
      }

      const lastCell = lastVisibleTableCell(container);
      if (lastCell) {
        lastCell.append(" ", button);
        return;
      }
    }

    container.append(" ", button);
  }

  function descriptorFromElement(element) {
    const uuid =
      core.extractUuidFromText(element.getAttribute("data-uuid") || "") ||
      core.extractUuidFromUrl(element.getAttribute("href") || "", location.href);

    if (!uuid) {
      return null;
    }

    const href =
      element.getAttribute("href") ||
      core.makeStatusUrl(uuid, location.href);
    const statusUrl = new URL(href, location.href).href;
    const container =
      element.closest("tr, li, .panel, .card, .experiment, .experiment-row") ||
      element.parentElement ||
      element;

    return {
      uuid,
      statusUrl,
      label: labelFromContainer(container, uuid),
      container,
      isCurrentPage: uuid === core.extractUuidFromUrl(location.href)
    };
  }

  function isDashboardPage() {
    return /\/(?:portal\/)?user-dashboard\.php$/.test(location.pathname);
  }

  function htmlToText(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }

    if (typeof DOMParser !== "undefined" && /<[A-Za-z][^>]*>/.test(text)) {
      const parsed = new DOMParser().parseFromString(text, "text/html");
      return (parsed.body.textContent || "").replace(/\s+/g, " ").trim();
    }

    return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }

  function firstHrefFromHtml(value) {
    const text = String(value || "");
    if (!text) {
      return "";
    }

    if (typeof DOMParser !== "undefined" && /<[A-Za-z][^>]*>/.test(text)) {
      const parsed = new DOMParser().parseFromString(text, "text/html");
      const link = parsed.querySelector("a[href]");
      return link ? link.getAttribute("href") || "" : "";
    }

    const match = text.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    return match ? match[1] : "";
  }

  function dashboardExperimentDescriptor(value, group, index) {
    if (!value) {
      return null;
    }

    const rawName = String(value.name || value.eid || value.uuid || "").trim();
    const rawProject = String(value.project || value.pid || "").trim();
    const nameHref = firstHrefFromHtml(rawName);
    const uuid =
      core.extractUuidFromText(value.uuid || "") ||
      core.extractUuidFromUrl(nameHref, location.href);
    if (!uuid) {
      return null;
    }

    const name = htmlToText(rawName) || uuid;
    const project = htmlToText(rawProject);
    const creator = String(value.creator || "").trim();
    const labelParts = [project, name].filter(Boolean);
    const statusUrl = nameHref
      ? new URL(nameHref, location.href).href
      : core.makeStatusUrl(uuid, location.href);

    return {
      uuid,
      statusUrl,
      label: labelParts.length ? labelParts.join(" / ") : value.uuid,
      name,
      project,
      creator,
      dashboardGroup: group,
      dashboardIndex: index,
      isCurrentPage: false
    };
  }

  function dashboardStatusLink(row, descriptor) {
    return (
      row.querySelector(`a[href*="status.php"][href*="${descriptor.uuid}"]`) ||
      row.querySelector("a[href*='status.php'][href*='uuid=']")
    );
  }

  function dashboardNameCell(row, descriptor) {
    const statusLink = dashboardStatusLink(row, descriptor);
    return (statusLink && statusLink.closest("td, th")) || firstVisibleTableCell(row);
  }

  function appendDashboardNameButton(row, descriptor) {
    if (!row || hasButtonForUuid(descriptor.uuid, row)) {
      return false;
    }

    const cell = dashboardNameCell(row, descriptor);
    if (!cell) {
      return false;
    }

    const button = createInlineButton(descriptor);
    const statusLink = dashboardStatusLink(row, descriptor);
    if (statusLink && statusLink.parentElement === cell) {
      statusLink.after(" ", button);
    } else {
      cell.append(" ", button);
    }
    return true;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function rowMatchesExperiment(row, descriptor) {
    const rowText = normalizeText(row.textContent);
    const required = [descriptor.name, descriptor.project]
      .map(normalizeText)
      .filter(Boolean);

    return required.every((value) => rowText.includes(value));
  }

  function findDashboardRow(containerSelector, descriptor, fallbackIndex) {
    const rows = Array.from(
      document.querySelectorAll(`${containerSelector} #experiments_table tbody tr`)
    );
    if (rows.length === 0) {
      return null;
    }

    const exactRow = rows.find((row) => rowMatchesExperiment(row, descriptor));
    if (exactRow) {
      return exactRow;
    }

    return rows[fallbackIndex] || null;
  }

  function addDashboardTableButtons(descriptors, group, containerSelector) {
    let inserted = 0;

    descriptors
      .filter((descriptor) => descriptor.dashboardGroup === group)
      .forEach((descriptor, index) => {
        const row = findDashboardRow(containerSelector, descriptor, index);
        if (row && appendDashboardNameButton(row, descriptor)) {
          inserted += 1;
        }
      });

    return inserted;
  }

  function dashboardPanelContainer() {
    return (
      document.querySelector("#experiments") ||
      document.querySelector("#experiments_content") ||
      document.querySelector("#main-body") ||
      document.body
    );
  }

  function insertDashboardPanel(panel) {
    if (panel.isConnected) {
      return;
    }

    const experimentsContent = document.querySelector("#experiments_content");
    if (experimentsContent && experimentsContent.parentElement) {
      experimentsContent.insertAdjacentElement("beforebegin", panel);
      return;
    }

    dashboardPanelContainer().prepend(panel);
  }

  function createDashboardPanel(descriptors, state) {
    let panel = document.getElementById(DASHBOARD_PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = DASHBOARD_PANEL_ID;
    }

    panel.textContent = "";
    const heading = document.createElement("h4");
    heading.textContent = "CloudLab host downloads";
    panel.append(heading);

    if (state === "loading") {
      const message = document.createElement("p");
      message.className = "cloudlab-host-downloader-dashboard-message";
      message.textContent = "Loading CloudLab experiments...";
      panel.append(message);
      insertDashboardPanel(panel);
      return panel;
    }

    if (state === "error") {
      const message = document.createElement("p");
      message.className =
        "cloudlab-host-downloader-dashboard-message cloudlab-host-downloader-dashboard-error";
      message.textContent =
        dashboardLoadError ||
        "The extension loaded, but CloudLab experiment lookup failed.";
      panel.append(message);
      insertDashboardPanel(panel);
      return panel;
    }

    if (descriptors.length === 0) {
      const message = document.createElement("p");
      message.className = "cloudlab-host-downloader-dashboard-message";
      message.textContent =
        "The extension loaded, but no active CloudLab experiments were returned.";
      panel.append(message);
      insertDashboardPanel(panel);
      return panel;
    }

    descriptors.forEach((descriptor) => {
      const row = document.createElement("div");
      row.className = "cloudlab-host-downloader-dashboard-row";

      const label = document.createElement("span");
      label.className = "cloudlab-host-downloader-dashboard-label";
      label.textContent = descriptor.label;

      row.append(label, createButton(descriptor));
      panel.append(row);
    });

    insertDashboardPanel(panel);
    return panel;
  }

  function removeDashboardPanel() {
    const panel = document.getElementById(DASHBOARD_PANEL_ID);
    if (panel) {
      panel.remove();
    }
  }

  function dashboardRowButtonCount() {
    return document.querySelectorAll(
      `#experiments_content [${TARGET_ATTR}], ` +
        `#project_experiments_content [${TARGET_ATTR}]`
    ).length;
  }

  function renderDashboardExperimentButtons(descriptors) {
    const inserted =
      addDashboardTableButtons(descriptors, "user", "#experiments_content") +
      addDashboardTableButtons(
        descriptors,
        "project",
        "#project_experiments_content"
      );

    if (inserted > 0 || dashboardRowsRendered || dashboardRowButtonCount() > 0) {
      dashboardRowsRendered = true;
      removeDashboardPanel();
      return;
    }

    createDashboardPanel(descriptors, "ready");
  }

  async function loadDashboardExperiments() {
    const context = getPageContext();
    const uid = context.targetUserId || context.userId;
    if (!uid) {
      return [];
    }

    const result = await callServerMethodWithFallback(
      location.href,
      "user-dashboard",
      "ExperimentList",
      { uid }
    );
    const value = result.value || {};
    const userExperiments = experimentListValues(value.user_experiments);
    const projectExperiments = experimentListValues(value.project_experiments);

    return [
      ...userExperiments
        .map((experiment, index) =>
          dashboardExperimentDescriptor(experiment, "user", index)
        )
        .filter(Boolean),
      ...projectExperiments
        .map((experiment, index) =>
          dashboardExperimentDescriptor(experiment, "project", index)
        )
        .filter(Boolean)
    ];
  }

  function experimentListValues(value) {
    if (Array.isArray(value)) {
      return value;
    }

    if (value && typeof value === "object") {
      return Object.values(value);
    }

    return [];
  }

  function addDashboardExperimentButtons() {
    if (!isDashboardPage()) {
      return;
    }

    if (!dashboardLoadPromise) {
      createDashboardPanel([], "loading");
      dashboardLoadPromise = loadDashboardExperiments().catch((error) => {
        console.warn("CloudLab Host Downloader dashboard load failed:", error);
        dashboardLoadError = `The extension loaded, but CloudLab experiment lookup failed: ${error.message}`;
        return [];
      });
    }

    dashboardLoadPromise.then((descriptors) => {
      if (dashboardLoadError) {
        createDashboardPanel([], "error");
        return;
      }
      renderDashboardExperimentButtons(descriptors);
    });
  }

  function classAndIdText(element) {
    if (!element) {
      return "";
    }

    return `${element.id || ""} ${String(element.className || "")}`.toLowerCase();
  }

  function isLikelyExperimentUuidElement(element, container) {
    if (element.matches("a[href*='status.php'][href*='uuid=']")) {
      return true;
    }

    if (
      container &&
      container.querySelector("a[href*='status.php'][href*='uuid=']")
    ) {
      return true;
    }

    const nearbyNamedContainer = element.closest("[id], [class]");
    const markerText = [
      classAndIdText(element),
      classAndIdText(container),
      classAndIdText(nearbyNamedContainer)
    ].join(" ");

    if (/(experiment|instance|quickvm|active[-_ ]?exp)/.test(markerText)) {
      return true;
    }

    return (
      element.hasAttribute("data-pid") &&
      (element.hasAttribute("data-eid") || element.hasAttribute("data-name"))
    );
  }

  function addButtonsForExperimentLists() {
    const elements = new Set([
      ...document.querySelectorAll("a[href*='status.php'][href*='uuid=']"),
      ...document.querySelectorAll("[data-uuid]")
    ]);

    elements.forEach((element) => {
      const descriptor = descriptorFromElement(element);
      if (!descriptor) {
        return;
      }

      if (!isLikelyExperimentUuidElement(element, descriptor.container)) {
        return;
      }

      appendButtonToContainer(descriptor.container, descriptor);
    });
  }

  function addCurrentStatusPageButton() {
    const uuid = core.extractUuidFromUrl(location.href);
    if (!uuid || hasButtonForUuid(uuid)) {
      return;
    }

    const pageAction = document.createElement("div");
    pageAction.id = PAGE_ACTION_ID;
    const descriptor = {
      uuid,
      statusUrl: location.href,
      label: document.title || uuid,
      container: pageAction,
      isCurrentPage: true
    };
    pageAction.append(createButton(descriptor));

    const target =
      document.querySelector(".status-buttons, #quickvm_topomodal_button, h1") ||
      document.body.firstElementChild ||
      document.body;
    target.insertAdjacentElement("afterend", pageAction);
  }

  function scanForExperiments() {
    if (!document.body) {
      return;
    }

    addDashboardExperimentButtons();
  }

  function scheduleScan() {
    if (scanTimer) {
      window.clearTimeout(scanTimer);
    }

    scanTimer = window.setTimeout(() => {
      scanTimer = 0;
      scanForExperiments();
    }, SCAN_DELAY_MS);
  }

  scanForExperiments();
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();

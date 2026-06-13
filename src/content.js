(function runCloudLabHostDownloader() {
  "use strict";

  const core = window.CloudLabHostDownloaderCore;
  const BUTTON_CLASS = "cloudlab-host-downloader-button";
  const PAGE_ACTION_ID = "cloudlab-host-downloader-page-action";
  const TARGET_ATTR = "data-cloudlab-host-downloader-target";
  const SCAN_DELAY_MS = 250;

  let scanTimer = 0;
  let pageContext;

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

    const userId =
      cleanCloudLabUserId(readPageGlobal(["APT_OPTIONS", "thisUid"])) ||
      cleanCloudLabUserId(readPageGlobal(["APT_OPTIONS", "this_uid"])) ||
      cleanCloudLabUserId(readPageGlobal(["LOGINUID"])) ||
      cleanCloudLabUserId(readPageGlobal(["TARGET_USER"])) ||
      cleanCloudLabUserId(
        readInlineScriptValue(/thisUid["']?\s*[:=]\s*["']([^"']+)["']/)
      ) ||
      cleanCloudLabUserId(
        readInlineScriptValue(/LOGINUID\s*=\s*["']([^"']+)["']/)
      ) ||
      cleanCloudLabUserId(
        readInlineScriptValue(/TARGET_USER\s*=\s*["']([^"']+)["']/)
      ) ||
      readUserIdFromDom();

    const ajaxUrl =
      readPageGlobal(["ajaxurl"]) ||
      readPageGlobal(["APT_OPTIONS", "ajaxurl"]) ||
      readInlineScriptValue(/ajaxurl\s*=\s*["']([^"']+)["']/) ||
      "";

    pageContext = {
      userId,
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

  function hasButtonForUuid(uuid) {
    const escapedUuid =
      window.CSS && typeof window.CSS.escape === "function"
        ? window.CSS.escape(uuid)
        : String(uuid).replace(/["\\]/g, "\\$&");

    return Boolean(
      document.querySelector(`[${TARGET_ATTR}="${escapedUuid}"]`)
    );
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

  function appendButtonToContainer(container, descriptor) {
    if (!container || hasButtonForUuid(descriptor.uuid)) {
      return;
    }

    const button = createButton(descriptor);
    if (container.matches("tr")) {
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

    addCurrentStatusPageButton();
    addButtonsForExperimentLists();
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

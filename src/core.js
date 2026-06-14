(function attachCore(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  root.CloudLabHostDownloaderCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function buildCore() {
  "use strict";

  const UUID_RE =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const AGGREGATE_URN_RE = /^urn:publicid:IDN\+[^+]+\+authority\+(am|cm)$/i;
  const XML_ENTITY_RE = /&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi;

  function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
  }

  function decodeXmlEntities(value) {
    if (!isNonEmptyString(value)) {
      return "";
    }

    return value.replace(XML_ENTITY_RE, (entity, named, decimal, hex) => {
      if (decimal) {
        return String.fromCodePoint(Number.parseInt(decimal, 10));
      }
      if (hex) {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }

      switch (named) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return "\"";
        case "apos":
          return "'";
        default:
          return entity;
      }
    });
  }

  function parseAttributes(tagText) {
    const attributes = {};
    const attrRe = /([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match;

    while ((match = attrRe.exec(tagText)) !== null) {
      const rawName = match[1];
      const localName = rawName.includes(":") ? rawName.split(":").pop() : rawName;
      attributes[localName] = decodeXmlEntities(match[2] ?? match[3] ?? "");
    }

    return attributes;
  }

  function cleanOptionalString(value) {
    return value ? String(value).trim() : "";
  }

  function addUniqueLoginEntry(entries, seen, username, hostname, port, nodeId) {
    const cleanHostname = hostname ? hostname.trim() : "";
    const cleanUsername = username ? username.trim() : "";
    const cleanPort = port ? String(port).trim() : "";
    const cleanNodeId = cleanOptionalString(nodeId);

    if (!cleanHostname) {
      return;
    }

    const key = `${cleanUsername}@${cleanHostname}:${cleanPort}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    entries.push({
      username: cleanUsername,
      hostname: cleanHostname,
      port: cleanPort,
      nodeId: cleanNodeId
    });
  }

  function localXmlName(node) {
    return String(node.localName || node.nodeName || "")
      .split(":")
      .pop()
      .toLowerCase();
  }

  function nodeIdForLoginNode(loginNode) {
    for (let node = loginNode.parentElement; node; node = node.parentElement) {
      if (localXmlName(node) !== "node") {
        continue;
      }

      return (
        node.getAttribute("client_id") ||
        node.getAttribute("client-id") ||
        node.getAttribute("component_id") ||
        ""
      );
    }

    return "";
  }

  function parseLoginEntriesWithDomParser(xmlText) {
    if (typeof DOMParser === "undefined") {
      return [];
    }

    const parser = new DOMParser();
    const document = parser.parseFromString(xmlText, "application/xml");
    if (document.getElementsByTagName("parsererror").length > 0) {
      return [];
    }

    const loginNodes = [];
    const nodeSeen = new Set();
    const addNodeList = (nodeList) => {
      Array.from(nodeList).forEach((node) => {
        if (nodeSeen.has(node)) {
          return;
        }
        nodeSeen.add(node);
        loginNodes.push(node);
      });
    };

    addNodeList(document.getElementsByTagNameNS("*", "login"));
    addNodeList(document.getElementsByTagName("login"));

    const entries = [];
    const entrySeen = new Set();
    loginNodes.forEach((node) => {
      addUniqueLoginEntry(
        entries,
        entrySeen,
        node.getAttribute("username") || node.getAttribute("user"),
        node.getAttribute("hostname") || node.getAttribute("host"),
        node.getAttribute("port"),
        nodeIdForLoginNode(node)
      );
    });

    return entries;
  }

  function parseLoginEntriesWithRegex(xmlText) {
    const entries = [];
    const seen = new Set();
    const loginTagRe = /<([A-Za-z_][\w.-]*:)?login\b[^>]*>/gi;
    let match;

    while ((match = loginTagRe.exec(xmlText)) !== null) {
      const attributes = parseAttributes(match[0]);
      addUniqueLoginEntry(
        entries,
        seen,
        attributes.username || attributes.user,
        attributes.hostname || attributes.host,
        attributes.port,
        ""
      );
    }

    return entries;
  }

  function parseLoginEntriesFromManifest(xmlText) {
    if (!isNonEmptyString(xmlText)) {
      return [];
    }

    const domEntries = parseLoginEntriesWithDomParser(xmlText);
    if (domEntries.length > 0) {
      return domEntries;
    }

    return parseLoginEntriesWithRegex(xmlText);
  }

  function formatHostLines(loginEntries, currentUser) {
    const lines = [];
    const seen = new Set();
    const cleanCurrentUser = currentUser ? String(currentUser).trim() : "";

    loginEntries.forEach((entry) => {
      const username = cleanCurrentUser || entry.username;
      if (!username || !entry.hostname) {
        return;
      }

      const line = `${username}@${entry.hostname}`;
      if (seen.has(line)) {
        return;
      }

      seen.add(line);
      lines.push(line);
    });

    return lines;
  }

  function hostLinesFromManifest(xmlText, currentUser) {
    return formatHostLines(parseLoginEntriesFromManifest(xmlText), currentUser);
  }

  function normalizePort(port) {
    const cleanPort = port ? String(port).trim() : "";
    const parsedPort = Number.parseInt(cleanPort, 10);
    if (!/^\d+$/.test(cleanPort) || parsedPort < 1 || parsedPort > 65535) {
      return "22";
    }
    return cleanPort;
  }

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
  }

  function shellSafeSshDestination(value) {
    return /^[A-Za-z0-9._~-]+@[A-Za-z0-9._~:[\]-]+$/.test(value);
  }

  function formatSshDestination(value) {
    return shellSafeSshDestination(value) ? value : shellQuote(value);
  }

  function formatSshTargetEndpoint(userAtHost, port) {
    return port === "22" ? userAtHost : `${userAtHost}:${port}`;
  }

  function formatSshTargetLabel(nodeId, userAtHost, port) {
    const endpoint = formatSshTargetEndpoint(userAtHost, port);
    return nodeId ? `${nodeId} (${endpoint})` : endpoint;
  }

  function formatSshTargets(loginEntries, currentUser) {
    const targets = [];
    const seen = new Set();
    const cleanCurrentUser = currentUser ? String(currentUser).trim() : "";

    loginEntries.forEach((entry) => {
      const username = cleanCurrentUser || entry.username;
      if (!username || !entry.hostname) {
        return;
      }

      const port = normalizePort(entry.port);
      const userAtHost = `${username}@${entry.hostname}`;
      const key = `${userAtHost}:${port}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      const nodeId = cleanOptionalString(entry.nodeId);
      targets.push({
        nodeId,
        username,
        hostname: entry.hostname,
        port,
        userAtHost,
        label: formatSshTargetLabel(nodeId, userAtHost, port),
        command:
          port === "22"
            ? `ssh ${formatSshDestination(userAtHost)}`
            : `ssh -p ${port} ${formatSshDestination(userAtHost)}`
      });
    });

    return targets;
  }

  function sshTargetsFromManifest(xmlText, currentUser) {
    return formatSshTargets(parseLoginEntriesFromManifest(xmlText), currentUser);
  }

  function appendAjaxArg(params, key, value) {
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        params.append(`ajax_args[${key}][]`, String(entry));
      });
      return;
    }

    if (value === null || typeof value === "undefined") {
      return;
    }

    if (typeof value === "object") {
      params.append(`ajax_args[${key}]`, JSON.stringify(value));
      return;
    }

    params.append(`ajax_args[${key}]`, String(value));
  }

  function buildAjaxFormBody(route, method, args) {
    const params = new URLSearchParams();
    params.set("ajax_route", route);
    params.set("ajax_method", method);

    Object.entries(args || {}).forEach(([key, value]) => {
      appendAjaxArg(params, key, value);
    });

    return params.toString();
  }

  function isAggregateUrn(value) {
    return typeof value === "string" && AGGREGATE_URN_RE.test(value);
  }

  function valueMeansTrue(value) {
    return value === true || value === 1 || value === "1" || value === "true";
  }

  function hasManifestFlag(value) {
    if (!value || typeof value !== "object") {
      return false;
    }

    return (
      valueMeansTrue(value.havemanifest) ||
      valueMeansTrue(value.have_manifest) ||
      valueMeansTrue(value.has_manifest) ||
      valueMeansTrue(value.manifest_available)
    );
  }

  function extractObjectUrn(value, objectKey) {
    if (isAggregateUrn(objectKey)) {
      return objectKey;
    }

    if (!value || typeof value !== "object") {
      return "";
    }

    const urnKeys = [
      "aggregate_urn",
      "aggregate",
      "manager_urn",
      "urn",
      "cluster_urn"
    ];

    for (const key of urnKeys) {
      if (isAggregateUrn(value[key])) {
        return value[key];
      }
    }

    return "";
  }

  function extractAggregateUrns(statusValue) {
    const manifestUrns = new Set();
    const allUrns = new Set();

    function visit(value, objectKey) {
      if (isAggregateUrn(value)) {
        allUrns.add(value);
        return;
      }

      if (!value || typeof value !== "object") {
        return;
      }

      const objectUrn = extractObjectUrn(value, objectKey);
      if (objectUrn) {
        allUrns.add(objectUrn);
        if (hasManifestFlag(value)) {
          manifestUrns.add(objectUrn);
        }
      }

      Object.entries(value).forEach(([key, child]) => {
        visit(child, key);
      });
    }

    visit(statusValue, "");
    return Array.from(manifestUrns.size > 0 ? manifestUrns : allUrns);
  }

  function hasManifestXml(value) {
    return (
      isNonEmptyString(value) &&
      /<([A-Za-z_][\w.-]*:)?rspec\b/i.test(value) &&
      /<([A-Za-z_][\w.-]*:)?node\b/i.test(value)
    );
  }

  function extractManifestXmlStrings(value) {
    const manifests = [];
    const seen = new Set();

    function add(text) {
      if (!hasManifestXml(text) || seen.has(text)) {
        return;
      }
      seen.add(text);
      manifests.push(text);
    }

    function visit(entry) {
      if (typeof entry === "string") {
        add(entry);
        return;
      }

      if (Array.isArray(entry)) {
        entry.forEach(visit);
        return;
      }

      if (!entry || typeof entry !== "object") {
        return;
      }

      Object.values(entry).forEach(visit);
    }

    visit(value);
    return manifests;
  }

  function extractUuidFromText(value) {
    if (!isNonEmptyString(value)) {
      return "";
    }

    const match = value.match(UUID_RE);
    return match ? match[0] : "";
  }

  function extractUuidFromUrl(urlText, baseUrl) {
    if (!isNonEmptyString(urlText)) {
      return "";
    }

    try {
      const url = new URL(urlText, baseUrl || "https://www.cloudlab.us/");
      const uuid = url.searchParams.get("uuid");
      if (uuid && UUID_RE.test(uuid)) {
        return uuid;
      }
      return extractUuidFromText(url.href);
    } catch (_error) {
      return extractUuidFromText(urlText);
    }
  }

  function makeStatusUrl(uuid, baseUrl) {
    const url = new URL(baseUrl || "https://www.cloudlab.us/status.php");
    url.pathname = url.pathname.includes("/portal/")
      ? "/portal/status.php"
      : "/status.php";
    url.search = "";
    url.hash = "";
    url.searchParams.set("uuid", uuid);
    return url.href;
  }

  function sanitizeFilenamePart(value) {
    const cleaned = String(value || "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    return cleaned || "cloudlab-experiment";
  }

  return {
    buildAjaxFormBody,
    extractAggregateUrns,
    extractManifestXmlStrings,
    extractUuidFromText,
    extractUuidFromUrl,
    formatHostLines,
    formatSshTargets,
    hasManifestXml,
    hostLinesFromManifest,
    makeStatusUrl,
    parseLoginEntriesFromManifest,
    sanitizeFilenamePart,
    sshTargetsFromManifest
  };
});

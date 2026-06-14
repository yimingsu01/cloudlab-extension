const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../src/core.js");

test("parses manifest login hostnames and overrides manifest usernames", () => {
  const xml = `<?xml version="1.0"?>
    <rspec xmlns="http://www.geni.net/resources/rspec/3" type="manifest">
      <node client_id="node-1">
        <services>
          <login authentication="ssh-keys" hostname="node1.example.cloudlab.us" port="22" username="creator" />
          <login authentication="ssh-keys" hostname="node1.example.cloudlab.us" port="22" username="creator" />
        </services>
      </node>
      <node client_id="node-2">
        <services>
          <login authentication="ssh-keys" hostname="node2.example.cloudlab.us" port="22" username="creator" />
        </services>
      </node>
    </rspec>`;

  assert.deepEqual(core.hostLinesFromManifest(xml, "alice"), [
    "alice@node1.example.cloudlab.us",
    "alice@node2.example.cloudlab.us"
  ]);
});

test("parses prefixed login entries and skips unusable entries", () => {
  const xml = `<rspec xmlns:emulab="http://www.protogeni.net/resources/rspec/ext/emulab/1">
    <node>
      <services>
        <emulab:login username="bob" hostname="node&amp;special.example.cloudlab.us" />
        <emulab:login username="bob" />
        <emulab:login hostname="missing-user.example.cloudlab.us" />
      </services>
    </node>
  </rspec>`;

  assert.deepEqual(core.hostLinesFromManifest(xml, ""), [
    "bob@node&special.example.cloudlab.us"
  ]);
});

test("formats SSH targets with ports and port-aware distinctness", () => {
  const xml = `<rspec>
    <node>
      <services>
        <login username="creator" hostname="shared.example.cloudlab.us" port="2201" />
        <login username="creator" hostname="shared.example.cloudlab.us" port="2202" />
        <login username="creator" hostname="default.example.cloudlab.us" port="22" />
      </services>
    </node>
  </rspec>`;

  assert.deepEqual(core.sshTargetsFromManifest(xml, "alice"), [
    {
      username: "alice",
      hostname: "shared.example.cloudlab.us",
      port: "2201",
      userAtHost: "alice@shared.example.cloudlab.us",
      command: "ssh -p 2201 alice@shared.example.cloudlab.us"
    },
    {
      username: "alice",
      hostname: "shared.example.cloudlab.us",
      port: "2202",
      userAtHost: "alice@shared.example.cloudlab.us",
      command: "ssh -p 2202 alice@shared.example.cloudlab.us"
    },
    {
      username: "alice",
      hostname: "default.example.cloudlab.us",
      port: "22",
      userAtHost: "alice@default.example.cloudlab.us",
      command: "ssh alice@default.example.cloudlab.us"
    }
  ]);
});

test("shell-quotes unsafe SSH destinations", () => {
  const xml = `<rspec>
    <node>
      <services>
        <login username="alice" hostname="node.example.com;touch injected" port="2201" />
        <login username="alice" hostname="node.example.com'bad" port="22" />
      </services>
    </node>
  </rspec>`;

  assert.deepEqual(
    core.sshTargetsFromManifest(xml, "").map((target) => target.command),
    [
      "ssh -p 2201 'alice@node.example.com;touch injected'",
      "ssh 'alice@node.example.com'\\''bad'"
    ]
  );
});

test("builds CloudLab AJAX POST bodies", () => {
  const body = core.buildAjaxFormBody("status", "GetInstanceManifests", {
    uuid: "11111111-2222-3333-4444-555555555555",
    aggregate_urns: [
      "urn:publicid:IDN+utah.cloudlab.us+authority+cm",
      "urn:publicid:IDN+wisc.cloudlab.us+authority+cm"
    ]
  });
  const params = new URLSearchParams(body);

  assert.equal(params.get("ajax_route"), "status");
  assert.equal(params.get("ajax_method"), "GetInstanceManifests");
  assert.equal(
    params.get("ajax_args[uuid]"),
    "11111111-2222-3333-4444-555555555555"
  );
  assert.deepEqual(params.getAll("ajax_args[aggregate_urns][]"), [
    "urn:publicid:IDN+utah.cloudlab.us+authority+cm",
    "urn:publicid:IDN+wisc.cloudlab.us+authority+cm"
  ]);
});

test("extracts manifest aggregate URNs from status responses", () => {
  const statusValue = {
    aggregates: {
      "urn:publicid:IDN+utah.cloudlab.us+authority+cm": {
        havemanifest: true
      },
      "urn:publicid:IDN+wisc.cloudlab.us+authority+cm": {
        havemanifest: false
      }
    },
    ignored: "urn:publicid:IDN+clemson.cloudlab.us+authority+cm"
  };

  assert.deepEqual(core.extractAggregateUrns(statusValue), [
    "urn:publicid:IDN+utah.cloudlab.us+authority+cm"
  ]);
});

test("extracts manifest XML strings from nested values", () => {
  const manifest = `<rspec type="manifest"><node><services><login username="u" hostname="h.example.cloudlab.us" /></services></node></rspec>`;
  const value = {
    "urn:publicid:IDN+utah.cloudlab.us+authority+cm": {
      manifest
    },
    duplicate: manifest,
    unrelated: "<html></html>"
  };

  assert.deepEqual(core.extractManifestXmlStrings(value), [manifest]);
});

test("extracts UUIDs and builds status URLs", () => {
  const uuid = "11111111-2222-3333-4444-555555555555";

  assert.equal(
    core.extractUuidFromUrl(`https://www.cloudlab.us/status.php?uuid=${uuid}`),
    uuid
  );
  assert.equal(
    core.makeStatusUrl(uuid, "https://www.cloudlab.us/portal/user-dashboard.php"),
    `https://www.cloudlab.us/portal/status.php?uuid=${uuid}`
  );
});

test("sanitizes filename parts", () => {
  assert.equal(
    core.sanitizeFilenamePart("Project / Experiment: test"),
    "Project-Experiment-test"
  );
});

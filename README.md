# cloudlab-extension

Firefox 142+ WebExtension that adds **Download hosts** buttons to CloudLab experiment pages and experiment lists. Each downloaded text file contains one SSH target per line:

```text
user@hostname
```

## Install temporarily in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `manifest.json` from this directory.
4. Visit `https://www.cloudlab.us/` while logged in.

Temporary add-ons are removed when Firefox restarts. To keep the add-on loaded, package and sign it through Mozilla's standard extension workflow.

## Usage

Open your CloudLab user dashboard. The extension adds **Download hosts** and **Extend** buttons next to each experiment name it can identify. **Download hosts** saves a `*-cloudlab-hosts.txt` file. **Extend** opens the experiment status page and triggers CloudLab's native extension dialog, so the request uses CloudLab's normal endpoint and approval flow.

The extension uses CloudLab's same-origin `server-ajax.php` status calls with your existing logged-in browser session. It reads the manifest login hostnames and combines them with the currently logged-in CloudLab user ID, matching the portal's SSH list behavior.

## Validate locally

```sh
npm test
```

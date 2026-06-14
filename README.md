# cloudlab-extension

Manifest V3 browser extension for Firefox and Chrome that adds CloudLab dashboard controls for host downloads, SSH command copying, and experiment extension. Each downloaded text file contains one SSH target per line:

```text
user@hostname
```

## Browser support

- Firefox 142 or newer.
- Chrome and Chromium-based browsers that support Manifest V3 extensions.

## Install temporarily in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `manifest.json` from this directory.
4. Visit `https://www.cloudlab.us/` while logged in.

Temporary add-ons are removed when Firefox restarts. To keep the add-on loaded, package and sign it through Mozilla's standard extension workflow.

## Install unpacked in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository directory.
5. Visit `https://www.cloudlab.us/` while logged in.

Chrome keeps unpacked extensions loaded until you remove them or disable Developer mode. To distribute the extension permanently, package it through the Chrome Web Store workflow.

## Usage

Open your CloudLab user dashboard. The extension adds **Download hosts**, an SSH node dropdown with a **copy ssh cmd** button, and **Extend** next to each experiment name it can identify. **Download hosts** saves a `*-cloudlab-hosts.txt` file. Select a node in the dropdown and click **copy ssh cmd** to copy the exact SSH command for that node. **Extend** opens the experiment status page and triggers CloudLab's native extension dialog, so the request uses CloudLab's normal endpoint and approval flow.

The extension uses CloudLab's same-origin `server-ajax.php` status calls with your existing logged-in browser session. It reads the manifest login hostnames and combines them with the currently logged-in CloudLab user ID, matching the portal's SSH list behavior.

## Validate locally

```sh
npm test
```

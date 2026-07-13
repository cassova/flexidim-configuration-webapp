# FlexiDim Web

FlexiDim Web is a local-first web migration of **JCL FlexiDim Configuration for iOS 2.97**. It exists to keep installed FlexiDim home-lighting systems usable now that the original company, mobile app, and supporting services are no longer maintained.

The project recreates the original landscape iPad configuration console as a responsive, installable web app. It uses visual assets recovered from the original IPA and includes a local network bridge for sending verified legacy lighting commands to a FlexiDim Scene Controller.

> [!IMPORTANT]
> Live dimming and switch/button commands are implemented. Destructive whole-controller configuration downloads are intentionally refused until the target controller has a hardware-verified binary profile. The original download process resets the Scene Controller; sending an incorrect payload could leave a lighting installation unavailable or misconfigured.

## What the original application was

JCL's FlexiDim Configuration app was an iPad-only installer and commissioning tool for FlexiDim lighting systems. It managed the logical model of a property and communicated with a Scene Controller over the local network.

The original app was organized into ten sections, all represented in this migration:

| Original section | Purpose in FlexiDim Web |
| --- | --- |
| Sites | Scene Controller address, site identity, location, time zone, and daylight-saving rules |
| Configurations | Local backups, imports, exports, controller comparison, and transfer status |
| Equipment | Rooms, lighting channels, modules, channel types, and wall switches |
| Switches | Wall-control definitions and interactive button testing |
| Basic Assignments | Mapping switch buttons to scenes and channel behavior |
| Scenes | Channel levels, fades, schedules, day selection, and live scene playback |
| Scene to Button | Assigning and testing scenes on physical wall-control buttons |
| Periods | Named time windows and active days used by scheduled behavior |
| Users | Local user profiles, remote-access settings, permissions, and security keys |
| Trace | Connection state, commands, replies, and diagnostic activity |

## How the migration was produced

The starting point was a decrypted copy of `JCL_Configuration_2.97_iOSGods.com.ipa`. No original Xcode project or source code was available.

The migration was reconstructed by:

1. Unpacking the IPA and cataloguing its application bundle.
2. Recovering the original icons, room plans, switch images, colour wheel, status graphics, sounds, and FlexiDim branding.
3. Inspecting the compiled storyboards and NIB archives to recover screen names, controls, field labels, warnings, navigation, and the complete tab structure.
4. Inspecting Objective-C runtime metadata to recover controller and model class names, properties, and method selectors.
5. Disassembling the ARM64 networking methods to identify the legacy Scene Controller message layouts.
6. Reimplementing the recovered packet framing, CRC-16/X25 calculation, and reserved-byte escaping in a small Node.js bridge.
7. Rebuilding the application model and interactions in React, TypeScript, and CSS with browser-local persistence.
8. Adding responsive layouts, an offline application shell, a web manifest, import/export, and automated protocol/rendering tests.

The original app used raw TCP and UDP sockets, which browsers cannot open directly. FlexiDim Web therefore separates the system into two local pieces:

```text
Browser / installed PWA
        │ WebSocket on 127.0.0.1:8765
        ▼
FlexiDim local bridge
        │ legacy TCP on the home LAN
        ▼
FlexiDim Scene Controller :15273
```

The bridge listens on loopback only. It is not exposed to other devices on the LAN and does not route lighting data through a cloud service.

## Implemented functionality

- Responsive recreation of the original iPad landscape interface
- Original FlexiDim/JCL imagery and visual language
- Site, room, channel, switch, scene, period, assignment, and user editing
- Live channel brightness controls
- Live switch/button commands
- Scene playback by sending the scene's channel levels
- Scene-to-button assignment and testing
- Browser-local automatic configuration persistence
- Portable JSON configuration backup and restore
- Installer-access warning and explicit `FLEXIDIM` unlock flow
- Trace view for connections, commands, packets, and controller responses
- Installable PWA manifest and offline application shell
- Local Scene Controller bridge
- Recovered legacy packet framing and CRC-16/X25 implementation
- Desktop, tablet, and mobile layouts

## Known boundary: full controller downloads

The original application compiled a large site configuration into a controller-specific binary format, transferred it in multiple stages, verified CRCs, and reset the Scene Controller. That path also supported multiple generations of hardware and encrypted remote-access variants.

This repository preserves the configuration UI and exposes the transfer action, but the bridge refuses an unverified full download. Completing that final hardware-specific operation safely requires:

- the exact Scene Controller model and firmware version;
- a known-good configuration exported or captured from that controller;
- packet captures from a successful original-app transfer, if the old app can still be run;
- physical access to recover the installation if a test download fails.

Live local commands do not depend on the full-download path.

## Requirements

- Node.js **22.13 or newer**
- npm
- A computer on the same local network as the FlexiDim Scene Controller
- The Scene Controller's local IP address
- A modern browser with WebSocket support

The web interface can be viewed without hardware. Real lighting control requires the local bridge and a reachable Scene Controller.

## Install

Clone the repository and install its dependencies:

```bash
git clone git@github.com:cassova/flexidim-configuration-webapp.git
cd flexidim-configuration-webapp
npm install
```

## Launch locally

Run the web application in one terminal:

```bash
npm run dev
```

Run the Scene Controller bridge in a second terminal:

```bash
npm run bridge
```

Open [http://localhost:3000](http://localhost:3000) in a browser.

In **Sites**:

1. Enter the Scene Controller's local IP address.
2. Leave the port at `15273` unless the installation uses a different inbound port.
3. Select **Connect**.
4. Open **Trace** if you need to inspect connection attempts or controller replies.

The bridge reports itself at `http://127.0.0.1:8765`. Visiting that address should return a small JSON status response when the bridge is running.

## Finding the Scene Controller

The original app used local UDP discovery. Automatic discovery is not currently exposed in the browser UI, so the controller address must be entered directly.

Useful places to find it include:

- the router's DHCP client list;
- a reservation previously configured for the lighting controller;
- the original app's Site details, if it can still be opened;
- a LAN inventory or network scan performed by the homeowner on their own network.

For a reliable installation, reserve the controller's address in the router so it does not change.

## Configuration data and backups

FlexiDim Web saves edits automatically in the current browser's local storage. Data stays on that device and is not uploaded by the application.

To make a durable backup:

1. Open **Configurations**.
2. Select **Export configuration**.
3. Store the generated `.fd4web.json` file somewhere safe.

Use **Import configuration** to restore that file on the same computer or move the logical configuration to another browser.

Clearing browser storage removes the working local copy, including locally stored user security keys, unless an exported backup exists.

## Production build

Create a production build with:

```bash
npm run build
```

Start the built web application with:

```bash
npm run start
```

The local bridge is still launched separately with `npm run bridge`.

## Validation

Run the available checks with:

```bash
npm run build
npm run lint
npm run bridge:test
```

The protocol tests verify the recovered CRC-16/X25 behavior and legacy dimming-packet construction. The rendering test verifies that the production worker returns the FlexiDim application rather than the original project starter.

## Project structure

```text
app/
  page.tsx             Main FlexiDim application and local data model
  globals.css          Responsive recreation of the original interface
  layout.tsx           Metadata, PWA, icons, and social-preview configuration
bridge/
  protocol.mjs         Recovered CRC and legacy packet construction
  server.mjs           Loopback WebSocket-to-TCP Scene Controller bridge
public/
  flexidim/             Original application artwork used by the migration
  manifest.webmanifest Installable PWA metadata
  sw.js                 Offline application-shell cache
tests/
  bridge.test.mjs       Protocol tests
  rendered-html.test.mjs Production rendering test
work/
  ...                   Local reverse-engineering material; ignored by Git
```

## Recovered legacy control protocol

The implemented local command path is based on the behavior of the iOS 2.97 ARM64 binary:

- Local Scene Controller TCP port: `15273`
- Message prefix: `FF F3`
- Channel dim command: command `04`, followed by channel, brightness, and transition
- Switch command: command `00`, followed by switch and button
- CRC: reflected CRC-16/X25, initial value `FFFF`, final XOR `FFFF`
- Escaping: bytes `1B`, `FD`, `FE`, and `FF` after the initial byte are prefixed with `1B`

These details are documented for maintenance and interoperability. Do not send experimental commands to a working installation without a recovery plan.

## Privacy and network safety

- The working configuration is stored in browser local storage.
- The bridge binds to `127.0.0.1`, not `0.0.0.0`.
- The bridge accepts only a controller hostname/IP and TCP port from the web app.
- No defunct JCL/FlexiDim remote service is required for local commands.
- A hosted copy of the UI cannot reach the controller by itself; a bridge must run inside the home network.
- Do not expose port `8765` or the Scene Controller port to the public internet.

## Troubleshooting

### The web app says “Bridge unavailable”

Start `npm run bridge` in a separate terminal and confirm that `http://127.0.0.1:8765` returns a ready response.

### The bridge is ready but the controller does not connect

- Confirm the IP address in **Sites**.
- Confirm that the computer and controller are on the same LAN or VLAN.
- Check whether the controller's DHCP address changed.
- Confirm that local firewall rules allow the Node.js process to make LAN connections.
- Verify the controller port; the recovered default is `15273`.

### A slider moves but the light does not change

Open **Trace** and look for a connected state and a transmitted packet. Confirm that the logical channel number matches the physical installation's channel allocation.

### Configuration disappeared

Browser storage may have been cleared or a different browser profile may be in use. Restore an exported `.fd4web.json` backup from **Configurations**.

## Archival and legal note

This is an interoperability and preservation project for owners of existing FlexiDim installations. JCL, FlexiDim, their names, and the recovered artwork belong to their respective rights holders. The repository is not an official continuation of the original product and is not affiliated with the former manufacturer.

Use the software only with equipment and configuration data you own or are authorized to maintain.

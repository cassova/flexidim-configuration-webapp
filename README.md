# FlexiDim Web

FlexiDim Web is a local, browser-based replacement for **JCL FlexiDim
Configuration for iOS 2.97**. It is intended for owners and maintainers of
existing FlexiDim lighting systems whose original iPad app is no longer
practical to run.

It can import an original `.fd4cfg` backup, edit the installation, connect to a
Scene Controller on the local network, compare checksums, control lights, and—
for the specifically qualified controller profile—send a complete
configuration using the transfer flow recovered from the original app.

The application and bridge run on your own network. They do not require a cloud
service.

> [!IMPORTANT]
> Keep the original iPad app and at least one known-good `.fd4cfg` backup until
> you have imported, compared, backed up, and tested your own installation.
> Start with read-only Compare. A full configuration transfer temporarily
> suspends switches and resets the Scene Controller, so lights may change level
> or turn off while it restarts.

## What is supported

FlexiDim Web provides:

- original `.fd4cfg` import and export;
- a portable whole-workspace JSON backup;
- site, area, module, channel, switch, assignment, scene, period, state-flag,
  and user-profile editing;
- automatic server-side persistence;
- local controller discovery and authenticated connection;
- live channel, switch, and scene control;
- read-only configuration comparison;
- an offline, byte-level transfer dry run;
- complete configuration transfer for the qualified local type-0 controller
  profile reporting firmware `4.0`;
- desktop, tablet, and installable PWA layouts.

Configuration data is not hard-coded for one property. Imports, compilation,
checksums, block counts, user payloads, and transfer qualification are derived
from the active configuration.

Some recovered controller operations remain disabled because their behavior is
not sufficiently proven, including unsupported firmware/site types, encrypted
remote-controller sessions, blind/accessory commissioning, channel search, and
profile-only writes. The UI should block an unsupported operation instead of
inventing a packet.

## Before you begin

Make recovery possible first:

1. In the original iPad app, retain or export the current working `.fd4cfg`.
2. Copy that file to at least two locations, ideally including one outside the
   computer that will run FlexiDim Web.
3. Record the controller's current IP address and firmware version if visible.
4. Keep the iPad charged and available until FlexiDim Web has successfully
   compared with the controller and representative lights and switches work.
5. Do not experiment with a full transfer when loss of lighting would be
   unsafe.

Importing a backup is safer and more complete than recreating an installation
from memory. The original archive normally contains the controller identity,
network details, security code, hardware layout, scenes, periods, and users.

### If you do not have a `.fd4cfg` backup

There is currently no supported way to download an editable configuration from
the Scene Controller. **Compare with Scene Controller** is read-only, but it
returns only the installed configuration CRC, comparison result, controller
time, and firmware version. The normal status stream reports channel levels; it
does not contain the site's rooms, names, equipment definitions, Basic
Assignments, scenes, periods, state flags, or users.

The controller stores the flat binary image produced by the configuration app,
not the original editable `.fd4cfg` object graph. Even if that image could be
read in full, this project has no evidence-backed way to reconstruct all of the
lost editing information from it. The original app's use of “download” for a
configuration transfer means **app to controller**, not controller to app.

Try these recovery paths before recreating anything:

1. Check the original iPad, its Files/Documents storage, computer backups,
   cloud storage, email, and any exported archives.
2. Ask the original installer or system maintainer for the latest `.fd4cfg`.
3. Look for a `.fd4xlt` equipment-schedule file. It is not a backup, but it can
   create a new hardware starting point.
4. Record the working controller's address, firmware, security code, visible
   channel behavior, module order, switch behavior, and current CRC before
   making any changes.

FlexiDim Web can create an empty site, so rebuilding the installation manually
is possible in theory. That would require correctly recreating the site and
controller codes, module order, channels, switches, Basic Assignments, scenes,
periods, state flags, users, network settings, and other equipment data before
sending anything.

> **Warning: from-scratch recommissioning has not been qualified on real
> hardware with this web app. Do not treat it as a recovery feature. An
> incorrect module order or equipment definition can address the wrong output;
> an incomplete configuration can remove working behavior; and sending it
> resets the controller and may change or switch off lighting.**
>
> Do not overwrite a working controller merely to discover whether a recreated
> configuration is correct. First preserve every recoverable source, document
> the installation, validate the model offline, and involve a qualified
> FlexiDim installer—especially where loss of lighting could create a safety
> risk.

## Quick start with Docker Compose

Docker Compose is the simplest deployment because it starts the web server and
the local controller bridge together.

Requirements:

- Docker with Compose;
- a computer on the same LAN as the FlexiDim Scene Controller;
- a modern browser;
- your original `.fd4cfg` backup, strongly recommended; if it is unavailable,
  read the recovery limitations above before proceeding.

Start the application:

```bash
git clone <repository-url>
cd flexidim-configuration-webapp
docker compose up --build
```

If you do not have Docker installed, use Node.js 22.13 or newer. From the
repository directory, run the following commands in two separate command
windows:

```bash
# Run once in either command window:
npm install

# Command window 1 — start the web server:
npm run dev

# Command window 2 — start the local controller bridge:
npm run bridge
```

Open [http://localhost:3000](http://localhost:3000).

Compose creates a named `flexidim-config` volume for persistent configuration
storage. Normal rebuilds reuse it. `docker compose down` stops the application
without deleting that volume; do not add `-v` unless you intentionally want to
remove the saved workspace and already have an external backup.

## First-time setup

### 1. Import your original configuration

1. Open **Configurations**.
2. Select **Import**.
3. Choose your `.fd4cfg` exported from the iPad app.
4. Review the imported site, rooms, modules, channels, switches, scenes,
   periods, state flags, and users before enabling changes.
5. Select **Download configuration** to create a fresh `.fd4cfg` copy.
6. Select **Back up all sites (JSON)** to create a web-workspace backup as
   well.

Keep both formats:

- `.fd4cfg` is compatible with the original-app archive model and is the most
  useful recovery file;
- the JSON backup preserves multiple sites and web-only settings.

### 2. Connect to the Scene Controller

Open **Sites** and select the imported site.

- **Auto-detect controller** uses the recovered local discovery protocol.
- If discovery does not work—commonly with Docker Desktop—turn on
  **Allow changes**, enter the controller's reserved LAN address, and connect
  directly.
- The normal controller port is `15273`.
- Local type-0 controllers require a 16-character controller security code.
  Importing the original archive normally restores it. This is not the same as
  a user-profile key.

Some Scene Controllers allow only one control session. Fully close the original
iPad app if the web app finds the controller but cannot establish a session.

When connected, the **Trace** page shows connection state and sanitized
diagnostics.

### 3. Compare before changing anything

In **Configurations**, select **Compare with Scene Controller**.

Compare is read-only. It compiles the active web configuration and asks the
controller for its installed checksum and firmware version.

Before considering a full transfer, verify that:

- the comparison completes successfully;
- the local and controller checksums match;
- the reported firmware is the supported version;
- the configuration you intend to send is the one currently selected.

A mismatch is not a prompt to send immediately. First confirm that you imported
the correct backup and selected the correct site/configuration.

### 4. Make and back up edits

Editing is locked by default. Enable **Allow changes** only when you intend to
modify the configuration.

Helpful habits:

- make one logical change at a time;
- use descriptive configuration names;
- download a new `.fd4cfg` after meaningful edits;
- keep dated backups outside the app's data directory;
- compare again whenever the active configuration changes;
- test a representative light or scene before making broad changes.

Edits save automatically to the server. If the app shows **Changes are not
being saved**, stop editing, restore server storage, and reload before
continuing.

## Sending a complete configuration

Full transfer is deliberately fail-closed. The Send button becomes available
only when all of these conditions are true:

1. the active configuration compiles without unsupported fields;
2. the controller is connected through the qualified local type-0 profile;
3. a fresh Compare from the same connection reports firmware `4.0`;
4. both Compare checksums equal the exact compiled image checksum;
5. the offline transfer dry run passes for the exact image and user payloads;
6. no other transfer or safety stop is active.

Run **Offline transfer dry run** immediately before sending. It writes no bytes
to the controller. It recompiles the image, generates every transfer frame,
checks CRCs and escaping, and exercises the transfer runner's retry,
reset/reconnect, and normal-status completion flow against the local model.

Then:

1. Ensure it is safe for switches and lighting to be interrupted.
2. Keep the original `.fd4cfg` available in the iPad app.
3. Select **Send configuration to Scene Controller**.
4. Read the warning and choose **Continue** once.
5. Do not refresh, close the browser, use live controls, restart containers, or
   start a second controller session during the transfer.
6. Wait for block download, verification, permanence, controller restart,
   reconnection, and **Scene controller running normally**.
7. Run Compare again after completion.
8. Test representative physical switches, lights, and important scenes.

Do not retry blindly after a failure. Record the exact phase and message first.
If the controller does not return to normal operation, stop using the web
transfer path and use the original app and known-good backup as the recovery
route.

## Finding the controller

The bridge broadcasts the recovered discovery request over the local network
and then opens a TCP connection to the controller. If automatic discovery does
not work, useful places to find the address include:

- the router's DHCP client or reservation list;
- the original app's Site details;
- a LAN inventory performed by the owner on their own network.

Reserve the controller's address in the router once found. Do not expose the
controller port to the public internet.

## Data storage and backups

The web server stores the canonical workspace at:

- direct Node run: `./config/workspace.json`;
- container: `/config/workspace.json`;
- Compose: the named `flexidim-config` volume mounted at `/config`.

Writes use atomic replacement and revision checks. Clearing browser storage
does not delete the server workspace, but deleting the configured data
directory or Docker volume does.

A sound backup set contains:

- the last known-good original `.fd4cfg`;
- a newly downloaded `.fd4cfg` after verified web edits;
- **Back up all sites (JSON)** output;
- a backup of the Compose volume or `CONFIG_DIR`.

Do not store these files in a public repository. They may contain the property
layout, controller address, controller security code, user keys, contact
details, and location data.

## Network and deployment safety

With Compose, only port `3000` is published. The bridge remains private to the
Compose network and is reached through the web server's `/bridge` WebSocket
proxy. When launched directly, the bridge binds to loopback by default.

For access from another computer or an iPad, use a trusted local reverse proxy,
TLS, authentication, a strong `FLEXIDIM_BRIDGE_TOKEN`, and an explicit
`FLEXIDIM_BRIDGE_ORIGINS` list. Never publish port `8765` or controller port
`15273` directly to the internet.

The application is an installer console, not a multi-tenant identity service.
Use a single application replica and restrict access to trusted maintainers.

## Troubleshooting

### “Bridge unavailable”

With a direct Node installation, confirm `npm run bridge` is running and
[http://127.0.0.1:8765](http://127.0.0.1:8765) returns a ready response. With
Compose, check:

```bash
docker compose ps
docker compose logs flexidim-web flexidim-bridge
```

### The controller is not found

- confirm the computer and controller are on the same LAN or routed VLAN;
- close the original iPad app so it releases its controller session;
- check the controller's DHCP reservation;
- enter the address manually if container networking blocks UDP broadcast;
- confirm local firewall rules allow outbound LAN TCP connections.

### Compare is disabled

Connect to the controller first. If connected, check that the bridge announced
a profile with read-only verification support.

### Send is disabled

Hover or focus the button for the specific reason. Usually you need to:

- fix an incomplete or unsupported configuration field;
- reconnect;
- run a fresh matching Compare;
- run the offline dry run again;
- clear a deliberately latched safety stop by restarting/re-arming the bridge.

Do not work around these gates by editing the bridge or forging messages.

### Configuration appears missing

Confirm you are using the same server data directory or Compose volume. Restore
the JSON workspace backup or import the latest `.fd4cfg`. Do not create a new
empty site over the missing installation until you have checked storage.

### Docker reports “No space left on device”

Inspect Docker disk usage before deleting anything:

```bash
docker system df
docker volume ls
```

The included image does not declare an anonymous `/config` volume; Compose uses
one named volume for persistent web data. Review every candidate before using a
Docker prune command, because other projects may own volumes and caches.

## Development and validation

```bash
npm run build
npm test
npm run bridge:test
npm run lint
```

The committed regression corpus is wholly synthetic. It covers configuration
import/export, compilation, CRC and escaping, complete transfer framing,
failure branches, controller emulation, reset/reconnect behavior, and rendered
UI interactions without exposing a real installation.

Technical protocol details and evidence boundaries are documented in
[PROTOCOL.md](PROTOCOL.md). Remaining work and qualification notes are tracked
in [TODO.md](TODO.md).

## Project layout

```text
app/             Web interface, import/export, compiler, and data model
bridge/          Local WebSocket/TCP bridge and transfer state machine
public/          PWA files and recovered interface artwork
server/          Web host and persistent workspace storage
tests/           Synthetic unit, regression, UI, and emulator tests
tools/           Local diagnostics and controller emulator
tools/oracle/    Oracle documentation, synthetic evidence, and ignored private harnesses
```

## Disclaimer and recovery warning

FlexiDim Web is an independent interoperability and preservation project. It is
not an official JCL product, is not affiliated with the former manufacturer,
and comes with no guarantee that every FlexiDim hardware or firmware variant is
supported. JCL, FlexiDim, their names, and original artwork belong to their
respective rights holders.

Use it only with equipment and configuration data you own or are authorized to
maintain. Lighting control can be safety-critical. Before relying on this app:

- preserve the working original app and controller configuration;
- keep multiple offline backups;
- verify checksums before and after a transfer;
- test changes while someone has physical access to the installation;
- avoid transfers during unsafe times or when lighting loss would create risk;
- never repeatedly retry a failed transfer without understanding its state;
- do not discard the original recovery method until your own installation has
  completed import, Compare, dry run, transfer, post-transfer Compare, and
  physical functional checks successfully.

If you are uncertain whether your controller profile is supported, stop after
read-only Compare and seek qualified help rather than forcing a write.

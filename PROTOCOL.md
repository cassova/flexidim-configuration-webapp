# FlexiDim Scene Controller protocol

This document describes how FlexiDim Configuration for iOS 2.97 communicates
with a Scene Controller, how FlexiDim Web reproduces the verified parts of that
behavior, and how an original `.fd4cfg` document is converted into the webapp's
data model.

The protocol was reconstructed without source code from the iOS application,
its Objective-C metadata and ARM64 machine code, the archived configuration,
and tests against a real controller. Treat the confidence labels below as part
of the specification:

- **Hardware verified** — observed working against the reference controller.
- **Binary verified** — directly recovered from the iOS executable, but not yet
  exercised against hardware in this project.
- **Observed** — inferred from repeatable controller traffic.
- **Unknown** — evidence exists, but the exact bytes or semantics remain to be
  captured and verified.

Do not use an **Unknown** operation for a whole-controller transfer. A malformed
configuration can suspend switches, reset the lighting system, or leave the
installation misconfigured.

## System architecture

Browsers cannot open raw TCP or UDP sockets. FlexiDim Web therefore uses a
loopback WebSocket bridge:

```text
Browser / PWA
    │ JSON over WebSocket ws://127.0.0.1:8765
    ▼
Local Node.js bridge
    │ FlexiDim TCP/UDP on the home LAN
    ▼
Scene Controller
```

The bridge listens only on `127.0.0.1`. Controller traffic is not sent through
a cloud service.

## Connection lifecycle

### 1. Discovery — hardware verified

The iOS discovery exchange is:

1. Bind UDP port `15001` for the reply.
2. Broadcast ASCII `FLEX` to UDP port `15270`.
3. Use the private IPv4 source address of the response as the controller host.
4. Open TCP port `15273` on that host.

FlexiDim Web falls back to the saved private address and then a bounded local
subnet TCP scan when UDP discovery receives no response. That scan is a webapp
fallback, not part of the recovered controller protocol.

Some controllers permit only one TCP control connection. Close the original
iOS app before connecting the bridge.

### 2. Site type — binary verified

The iOS app derives a site type from the fifth character of the site ID. The
reference site's ID selects type `0`, the plaintext local protocol documented
here. The executable also contains type `1` and type `2` paths, including AES
operations for remote/encrypted sessions. Those paths are not implemented or
hardware verified in FlexiDim Web.

### 3. Authentication — hardware verified

A successful TCP connection is not yet command-ready. For a type-0 site, the
iOS app first writes this 23-byte authentication record:

```text
<16 ASCII security-code bytes><six ASCII decimal nonce bytes><ff>
```

The nonce is a random integer from `0` through `999999`, zero-padded to six
digits. Example with the secret redacted:

```text
[16-byte key] 35 33 33 37 32 30 ff
              └── ASCII "533720" ──┘
```

The security code comes from the site record in the `.fd4cfg` archive. It must
be exactly 16 ASCII characters. The bridge never prints the key.

The iOS sender changes its internal TCP state to command-ready (`tcpState = 3`)
only after writing this record. Sending a dim or switch frame immediately after
opening TCP, without authentication, makes the controller close the connection.
This missing step was the root cause of the original webapp disconnects.

After accepting authentication, the controller starts its continuous `f2`
channel-status stream.

## Client-to-controller framing

The following framing applies to the hardware-verified type-0 local protocol.

### Logical frame

```text
ff f3 <command> <command data...> <crc-low> <crc-high>
```

CRC is CRC-16/X25 over every byte before the CRC:

| Parameter | Value |
| --- | --- |
| Initial value | `ffff` |
| Reflected polynomial | `8408` |
| Input/output reflection | reflected |
| Final XOR | `ffff` |
| Check value for ASCII `123456789` | `906e` |
| Wire byte order | low byte, then high byte |

### Reserved-byte escaping

After appending CRC, leave the first byte (`ff`) literal. For every later byte,
insert `1b` before:

- `1b`; or
- any byte from `fd` through `ff`.

The escaped byte itself is not transformed. A receiver removes `1b` and accepts
the following byte literally.

### Dim command (`04`) — hardware verified

```text
ff f3 04 <channel> <level> <transition> <crc-low> <crc-high>
```

| Field | Meaning |
| --- | --- |
| `channel` | One-based controller channel address |
| `level` | Brightness from `0` through `100` (`00`–`64`) |
| `transition` | Half-second ticks; `1` means 0.5 seconds |

Examples:

```text
ff f3 04 11 00 01 e3 34  # channel 17 -> 0%, 0.5 s
ff f3 04 11 64 01 d6 36  # channel 17 -> 100%, 0.5 s
```

Live slider preview uses transition `0` and is throttled/coalesced by the
webapp so rapid slider events do not start overlapping fades.

### Switch command (`00`) — binary verified

```text
ff f3 00 <switch> <button> 00 <crc-low> <crc-high>
```

`switch` is the archived hardware index (`JCLFDHardware.ix`), not the switch's
row number in the UI. `button` is the physical controller button code, not the
logical first/second-press scene slot. The trailing zero is required.

Type-15 and type-13 switch plates contain built-in buttons. The recovered iOS
mapping skips protocol code 11 for the third shifted built-in button; for
example, an 11-button type-15 plate maps physical positions 9, 10, and 11 to
wire codes 9, 10, and 12.

### Scenes and Default on/off — hardware verified

There is no separate live-scene frame in the implemented path. Running a scene
expands its channel levels into one dim frame per affected channel.

The built-in **Default on/off** action similarly expands the switch's Basic
Assignment channels. It sends 100% unless every On-assigned output is already
at 100%; otherwise it sends 0% to every Off-assigned output. Off-only outputs
do not participate in the state decision because the On press intentionally
leaves them unchanged. Per-channel assignment flags and fade times are honored.
This is one logical action but multiple wire frames.

### Channel addressing — hardware verified

The `.fd4cfg` model's channel ID is not a wire address. The iOS calculation is:

```text
controller channel = channel index + (stored module position * 8)
```

The module position is its position in the archive's module array, not the
numeric sort order of module IDs. For the verified site, the stored modules are
`7000`, `7010`, and `7020`, producing controller ranges 1–8, 9–16, and 17–24.

## Controller-to-client records

Controller replies do not use the `ff f3 ... CRC-16/X25` framing above. The
following short record types have been observed on an authenticated local
connection.

### `f2` channel status — observed and hardware verified

```text
f2 <zero-based-address> <level> <check>
```

The controller emits one `f2` record about every 160 ms and continuously cycles
through 128 possible addresses. One complete scan therefore takes about 20.5
seconds. This is unsolicited state synchronization, not a response that the
client must request.

| Field | Meaning |
| --- | --- |
| `f2` | Channel-status record type |
| address | Zero-based controller address |
| level | Current brightness, normally `00`–`64` |
| check | Low seven bits of the sum of every preceding record byte |

The receive address is one less than the transmit address:

```text
f2 08 64 5e  # reports transmit channel 9 at 100%
f2 0e 32 32  # reports transmit channel 15 at 50%
f2 10 64 66  # reports transmit channel 17 at 100%
```

This stream keeps the client correct when a physical switch, a scene, or
another connected component changes a light. FlexiDim Web decodes it, batches
updates for 500 ms, and updates matching UI channel levels without adding 128
raw trace entries. The bridge prints one scan summary instead:

```text
controller status synchronized: 128 channel reports, N level changes
```

### `f4` and `f5` notifications — observed

Five-byte `f4` and `f5` records arrive immediately after accepted dim commands.
They contain the affected zero-based address and resulting level. Captures show
both types for each changed channel, but their distinct internal roles and
their final byte is the low seven bits of the sum of every preceding byte. They remain visible in trace
logs as command/state acknowledgements.

Example response to four channels set to 100%:

```text
f5 04 10 64 6d  f4 10 64 01 69
f5 04 00 64 5d  f4 00 64 01 59
f5 04 08 64 65  f4 08 64 01 61
f5 04 01 64 5e  f4 01 64 01 5a
```

Addresses `10`, `00`, `08`, and `01` are the zero-based forms of transmit
channels 17, 1, 9, and 2.

## Browser-to-bridge protocol

The browser sends JSON messages over the loopback WebSocket:

| Type | Important fields | Bridge action |
| --- | --- | --- |
| `discover` | `host`, `port`, `securityCode` | Discover, connect, authenticate |
| `connect` | `host`, `port`, `securityCode` | Connect directly and authenticate |
| `dim` | `channel`, `level`, `transition` | Build and send command `04` |
| `switch` | `switch`, `button` | Build and send command `00` |
| `scene` | `levels`, `transition` | Send one dim frame per entry |
| `sync` | configuration data | Currently refused; see below |

The bridge advertises a deny-by-default controller capability profile. The
baseline `type-0-live-only` profile permits only verified live dim/switch and
passive status behavior. Detection, profiles, verification, blind commands,
remote sessions, and full transfer remain disabled until a hardware-specific
profile supplies captured and tested evidence.

The bridge sends:

| Type | Meaning |
| --- | --- |
| `status` | Discovery, connection, authentication, or error state |
| `discovered` | Controller host and port found |
| `trace` | Meaningful transmitted frames and non-`f2` replies |
| `channelStatus` | Batched map of controller channel addresses to levels |

## `.fd4cfg` configuration format

### Container and object graph

An original `.fd4cfg` file is an Apple binary property list beginning with
`bplist`. Its root is an `NSKeyedArchiver` object graph:

```text
$archiver = NSKeyedArchiver
$objects  = shared object table
$top      = root keyed values and object references
```

Values such as `CF$UID`/`UID` are indices into `$objects`; they are references,
not application IDs. Objects also reference an archived `$class` whose
`$classname` identifies model types such as `JCLFDHardware`, `JCLFDSwitch`,
`JCLFDScene`, `JCLFDPeriod`, and `JCLFDUser`.

FlexiDim Web validates the binary-plist signature, parses the property list,
dereferences UIDs, groups objects by archived class name, and then converts the
graph into its typed `AppData` model. Parsing happens locally in the browser.

The archived model uses six application classes, plus `NSDate` and
`NSMutableString`:

| Class | Role |
| --- | --- |
| `JCLFDHardware` | A physical output channel or switch plate. Identity anchor. |
| `JCLFDChannel` | A reusable per-channel *setting* (level + timing). Referenced by scenes and switch Basic Assignments; never stored at the top level. |
| `JCLFDScene` | A scene, or a folder/group of scenes. |
| `JCLFDSwitch` | A switch's button-to-scene map and Basic Assignment. |
| `JCLFDPeriod` | A time period (schedule row). |
| `JCLFDUser` | A user account and its access rights. |

Object relationships are expressed by an integer identity, not by `CF$UID`:
every model object carries a random ~24-bit `ky`, and references to it are
stored as plain integers. The field tables below mark these `→ ky` references.

> Field semantics below are **binary verified** (recovered from the iOS
> executable's Objective-C metadata and coder methods) and **archive
> validated** against one real reference `.fd4cfg` (42 hardware objects, 3
> modules, 11 switches, 98 scenes, 35 periods, 2 users). Fields still lacking a
> confirmed meaning are marked **unconfirmed** and must not be relied on for a
> whole-controller transfer.

### Positional site fields

The site's top-level scalar fields use archive positions recovered from the iOS
encode order. Object arrays occupy contiguous position ranges (hardware, then
switches, then scenes, then periods, then users), each length-prefixed by the
matching count scalar.

| Archive key | Meaning |
| --- | --- |
| `$1` | Site name |
| `$2`–`$5` | Address lines |
| `$6` | Contact |
| `$7` | Telephone |
| `$8` | Email |
| `$9` | Site ID |
| `$10` | 16-character controller security code |
| `$11` | Saved controller IP |
| `$12` | Automatic discovery flag |
| `$14` | Last-updated value (`NSDate`) |
| `$15`, `$16` | Longitude, latitude |
| `$17` | Time zone |
| `$18` | Router-inbound enabled flag (`0`/`1` in the reference archive) |
| `$19` | Daylight-saving rule |
| `$28` | Fourth wireless-gateway count in the reference archive |
| `$29` | Remote-server hostname |
| `hwc` | Number of stored `JCLFDHardware` objects |
| `modc` | Number of stored bus-A modules |
| `modcB` | Number of stored bus-B modules |
| `$30...` | Bus-A module IDs in controller-address order |

Modules are stored in two ordered buses, A then B, counted by `modc` and
`modcB`. The order within each bus is the controller-address order and must be
preserved on import — it is not re-sorted by module ID (see channel addressing
above). The reference archive has no bus-B modules (`modcB = 0`), so the exact
positional slots of the bus-B array are not yet validated against a real file.

### `JCLFDHardware` — physical channels and switches

The identity object for every addressable output. `ty` distinguishes the role.

| Field | Type | Meaning |
| --- | --- | --- |
| `ky` | int | Stable object key referenced by other objects |
| `pr` | int → `ky` | Parent object (rebuilds the area/room hierarchy); `0` at a root |
| `ty` | int | Category: `0` area, `1` switch, `2` channel |
| `hw` | int | Hardware/type code |
| `ix` | int | Hardware index — the channel index, or the controller switch number used for switch addressing |
| `md` | int | Module ID for a channel (`-1` = none) |
| `mi` | int | Minimum level |
| `mx` | int | Maximum level |
| `mp` | int | Maximum permissible level |
| `df` | int | Default level |
| `di` | int (bool) | Dimmable |
| `ac` | int | Accessory type |
| `ra` | int | Rank (display/order) |
| `nm` | string | Name |
| `sn` | string | Short name |
| `fn` | string | Fitting/function name |
| `ri` | int | Room-image identifier |
| `ch` | int (bool) | Changed-since-transfer flag |
| `ad` | nil | Present but unused in the reference archive (**unconfirmed**) |

Parent keys rebuild the floor/area hierarchy. Channel `md` and `ix`, together
with the stored module array, produce the wire address described above.

### `JCLFDChannel` — a per-channel setting

Not a top-level object: scenes hold up to 19 of these (`ch0`…`ch18`) and each
switch holds 8 (`bs0`…`bs7`). It is the level + timing a scene or button applies
to one physical hardware channel.

| Field | Type | Meaning |
| --- | --- | --- |
| `ky` | int → `JCLFDHardware.ky` | The physical channel this setting drives (100% resolved in the reference archive) |
| `br` | int | Brightness/level; negative encodes a relative percentage |
| `t1` | int | Fade time, half-second ticks |
| `t2` | int | Second timing value (delay / 100%-time), half-second ticks |
| `de` | int | Delay before applying |
| `fl` | int | Option flags (see below) |
| `ch` | int (bool) | Changed-since-transfer flag |

`fl` bits, as used in a switch Basic Assignment record:

| Bit | Meaning |
| --- | --- |
| `01` | Assigned on |
| `02` | Assigned off |
| `04` | Assigned dimming |
| `08` | Assigned channel dimming |
| `80` | Relative percentage |
| `10` | Use 100%-time |

### `JCLFDSwitch` — button and Basic Assignment map

`JCLFDSwitch.ky` associates settings with its `JCLFDHardware` switch.

| Field | Type | Meaning |
| --- | --- | --- |
| `ky` | int | Stable object key |
| `bu0`…`bu23` | string → scene | Logical button slots; each references a scene |
| `bs0`…`bs7` | `JCLFDChannel` | Basic Assignment channel records |
| `bs` | int | Button/slot count |
| `op` | int (bool) | On-priority selection (**unconfirmed**) |

Consecutive logical `buN` slots represent the first and second presses of one
physical scene button; they must not be sent directly as physical wire button
numbers.

### `JCLFDScene` — scenes and folders

`JCLFDScene` represents both folders/groups and leaf scenes.

| Field | Type | Meaning |
| --- | --- | --- |
| `ky` | int | Stable object key |
| `pr` | int → `JCLFDScene.ky` | Parent folder / hierarchy link (100% resolved; `0` at a root) |
| `nm`, `sn` | string | Name, short name |
| `gr` | int (bool) | Group/folder marker |
| `rm` | int | Room number (a logical ordinal, **not** a `ky` reference) |
| `dr` | int | Display rank or scene fade value, depending on object role |
| `ch0`…`ch18` | `JCLFDChannel` | Per-channel scene records |
| `cc` | int | Count of channel records in use |
| `fl` | int | Scene flags |
| `ns` | int → `JCLFDScene.ky` | Next scene in a sequence |
| `nsm` | int | Next-scene mode |
| `nt`, `nd` | int | Next-scene timing |
| `ps`, `es`, `re1` | int | Previous / extender relationship and relative flag |
| `p1`, `p2` | int | Period inversion / operator |
| `sf` | int | State-flag set/clear |
| `lk` | int | Lock |
| `ty` | int | Type |

A parent chain reaching the deleted-scenes root is imported into the deleted
list.

### `JCLFDPeriod` — schedule rows

| Field | Type | Meaning |
| --- | --- | --- |
| `nm` | string | Period name |
| `ix` | int | Index / order |
| `st`, `et` | int | Start and end value |
| `sm`, `em` | int | Start and end mode: absolute, sunrise, or sunset |

Start/end are interpreted according to their independent modes; older builds
mistakenly treated the mode values as clock minutes.

### `JCLFDUser` — accounts and access

| Field | Type | Meaning |
| --- | --- | --- |
| `nm` | string | User name |
| `ky` | int | Stable object key |
| `sk` | string | Security key |
| `rm0`…`rm6` | string | Room/switch access entries |
| `rc` | int | Access-entry count |
| `ve` | int | Profile version |

The current importer preserves the fields represented in the web model;
archive fields it does not yet model are retained in the `.fd4web.json` backup
rather than silently discarded.

### FlexiDim Web JSON

`.fd4web.json` is a separate, web-native backup:

```json
{
  "format": "FlexiDim Web Configuration",
  "version": 2,
  "exportedAt": "ISO-8601 timestamp",
  "data": {
    "activeSiteId": "site-id",
    "activeConfigId": 1,
    "sites": [
      {
        "configurations": [
          { "id": 1, "content": { "rooms": [], "channels": [] } }
        ]
      }
    ]
  }
}
```

The Site → Configuration → ConfigContent tree is the canonical owner of editable
data. Version 2 preserves every site's configurations without duplicating the
active configuration at the top level. Version 1 flat projections are migrated
on import. This remains a webapp backup, not the binary controller image;
FlexiDim Web currently imports `.fd4cfg` but does not attempt to regenerate an
original keyed archive.

## Comparing and transferring a whole configuration

Three different operations are easily confused:

1. **Download configuration** in FlexiDim Web downloads `.fd4web.json` from the
   browser to the computer. It does not contact the Scene Controller.
2. **Compare with Scene Controller** should compare a compiled local controller
   image with the controller's installed image.
3. **Send configuration to Scene Controller** is an app-to-controller transfer,
   called a “download” by the original iOS code.

The editable `.fd4cfg` object graph is not sent directly. The original app's
`JCLFDConfig.compileConfig` method compiles sites, hardware, Basic Assignments,
scenes, periods, users, hardware profiles, location/time information, and other
tables into a controller-specific binary image. It also calculates a local CRC.

### Comparison / verification — binary verified workflow, wire bytes unknown

Recovered methods and UI strings show this workflow:

1. Compile the current local configuration.
2. Calculate and display its local CRC.
3. Authenticate a controller session.
4. Run `startVerify` / `processVerify:` to request the controller's installed
   configuration CRC.
5. Validate incoming messages with `checkMsgAndCRC:length:`.
6. Compare local and controller CRC values and report equality/difference.

There is no evidence that comparison downloads the controller's complete image
or reconstructs an editable `.fd4cfg`; the recovered behavior is CRC-based.
The exact verification request and response frames still need an original-app
packet capture and are therefore not implemented.

### App-to-controller transfer — binary verified workflow, unsafe/unimplemented

Recovered methods (`compileConfig`, `startDownload`, `processDownload:`,
`sendChannelConfig:`, `nextModuleMessage:`, `sendUserData:userOnly:`,
`startVerify`, and `abortDownloadVerify`) and application strings establish this
high-level state machine:

1. Compile the editable model into the hardware/site-specific controller image.
2. Connect and authenticate.
3. Put the controller into its configuration-download state. The original app
   warns that switches may be suspended during this phase.
4. Send time/date/site setup records and the compiled image in numbered blocks.
5. Wait for acknowledgement of each block; retry failed blocks.
6. Transfer channel/module profiles and user/remote data where required.
7. Verify the installed CRC against the local compiled CRC.
8. Reset the Scene Controller.
9. Detect that the controller returned to normal operation.

The binary contains setup command families beginning `ff f6`, `ff f7`, `ff f8`,
`ff f9`, `ff fa`, `ff fc`, and `ff fe`, plus type-specific AES-OFB paths. Their
complete lengths, block numbering, acknowledgements, retry rules, compiler
layout, and firmware variations are not yet hardware verified.

The current bridge therefore rejects `sync` rather than sending a guessed
payload. Implementing it safely requires all of the following:

- controller model and firmware identification;
- an original-app capture of **verify** and one known-good full transfer;
- the original editable configuration and resulting local CRC;
- byte-for-byte mapping from compiled sections to transfer blocks;
- verified acknowledgement, retry, abort, reset, and recovery behavior;
- physical access and a recovery plan for the installation.

Until then, live dim/switch/scene commands and passive `f2` synchronization are
independent of the full-transfer path and safe to test normally.

## Implementation map

| Concern | Source |
| --- | --- |
| UDP discovery and fallback scan | `bridge/discovery.mjs` |
| Authentication record | `bridge/session.mjs` |
| CRC, escaping, client frames | `bridge/protocol.mjs` |
| `f2`/`f4`/`f5` receive parsing | `bridge/controller-replies.mjs` |
| WebSocket/TCP bridge | `bridge/server.mjs` |
| Deny-by-default controller profile | `bridge/controller-capabilities.mjs` |
| `.fd4cfg` conversion | `app/fd4cfg.ts` |
| Channel address calculation | `app/flexidim-addressing.mjs` |
| Built-in switch behavior | `app/live-switch.mjs` |
| One-shot hardware probe | `tools/controller-probe.mjs` |
| Trace/decoder/emulator | `tools/` |
| Protocol regression tests | `tests/bridge.test.mjs` |

## Open protocol questions

- What distinct roles do `f4` and `f5` play?
- What are the exact verification/CRC request and response frames?
- What are the compiled image's sections, sizes, offsets, and version markers?
- What are the download block size, sequence fields, acknowledgements, and
  retry/abort frames for each controller generation?
- Which setup commands are common to site types 0, 1, and 2?
- How are AES keys/IVs and OFB stream boundaries derived for remote sessions?
- Can a controller expose its entire compiled image, or only its CRC/status?

Answers should be added only with a binary reference, a packet capture, and—if
the operation mutates the controller—a controlled hardware validation.

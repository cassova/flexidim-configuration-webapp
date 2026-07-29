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

### Frame families

Five prefixes exist. Earlier revisions of this document assumed only `ff f3`.

| Prefix | Use | Status |
| --- | --- | --- |
| `ff f3 <cmd>` | commands: `04` dim, `00` switch, `05` channel search, `06` switch/dim function | `04`/`00` verified; `05` shape only |
| `ff f1 <sel>` | status requests: `00` period flags, `01` pending scenes | implemented, gated |
| `ff fc` | download/verify handshake | oracle verified |
| `ff f2` | user/profile data during configuration transfer | oracle verified |
| `f4` | channel-search tick — no `ff` prefix at all, five bytes | shape only |
| `ff <mode>` | emulation mode (`emulationMode:`), six bytes, byte 1 is the mode | shape only |

**Correction.** This document previously described a "guessed plaintext `0x05`
frame" that terminated the stream on real controllers, treating `0x05` as a
period poll. `0x05` is in fact the **channel-search** command, built by
`startChannelSearch:fullSearch:`, `channelSearchNext` and `chSrchTick:` from the
template at `0x1000b360c`. The period poll is `ff f1 00`. The observed disconnect
is consistent with a channel-search frame carrying the wrong payload or arriving
out of sequence, not with `0x05` being forbidden.

Channel search drives two frames together — the seven-byte `ff f3 05` command and
a bare five-byte `f4` tick on a timer. Its argument packing is only partially
traced, so it is deliberately not implemented: the shape is known, the payload is
not.

### Switch emulation (`ff fd` / `ff fe`) — binary verified, not transmitted

`-emulationMode:` (0x10003ef24). Six bytes, CRC over all six:

```text
ff fd 00 00 00 00 <crc-lo> <crc-hi>   # enter switch emulation
ff fe 00 00 00 00 <crc-lo> <crc-hi>   # leave switch emulation
```

Byte 1 is the only variable, and both values fall in the `fd`–`ff` escape range,
so byte 1 is transmitted escaped (`1b fd` / `1b fe`). This command is the reason
the escape mechanism exists.

Valid only for site types 0 and 1. Entering emulation is what makes the
controller report switch presses — the original app's "identify switch by button
press" — and the app renews it with a repeating **15-second**
`refreshEmulationMode` timer, so the mode lapses without refresh.

Implemented as `emulationModeFrame()` and gated off under `switchDetection`.

### User-profile transfer (`ff f2`) — sender-oracle verified, not transmitted

`-sendUserData:userOnly:` (0x10004b0e0) sends each non-empty UTF-8 user payload
in 256-byte chunks. An unescaped data frame is:

```text
ff f2 <user-index> <14-bit marker, low 7 bits first>
   <256 payload bytes> <crc-lo> <crc-hi>
```

Markers `0`, `1`, … identify non-final chunks. The final data-bearing chunk
uses marker `7f 7f` and is zero-padded. Empty users produce no per-user frame.
After every user, the sender writes one global marker:

```text
ff f2 e0 7f 7f <256 zero bytes> <crc-lo> <crc-hi>
```

The normal full-transfer position and multi-user order have been executed in
the offline sender oracle. The pure model implements this framing, but the live
bridge does not use it. Exact compilation of every hardware-specific user
profile suffix is still incomplete, so user transfer remains gated.

#### The user-only send — sender-oracle verified, not transmitted

The same method also serves the app's "send user profiles" action, which sends
profiles without recompiling or re-sending the configuration image. Its
signature is `-(BOOL)sendUserData:(NSInteger *)cursor userOnly:(BOOL)`, where
the cursor is an in/out user index and the result reports whether more remains.
One call is one timer tick, and a complete pass is:

| Tick | Frames written |
| --- | --- |
| cursor `0` | `ff fc 00 00 00 00` + CRC, then every chunk of the first profile |
| while users remain | every chunk of the profile at the cursor, which then advances |
| cursor spent | `ff f2 e0 7f 7f` + 256 zero bytes, then `ff fe 00 00 00 00` + CRC |

A configuration with no users emits all three in one tick. Calls after the
final one repeat the two terminal frames. `ff fe` is escaped on the wire
(`ff 1b fe …`); the CRC covers the six unescaped bytes.

**Profile order is not archive order.** `JCLFDConfig.users` is an
`NSMutableDictionary` keyed by the decimal string of each user's `ky`, and the
sender walks the list built by enumerating it, so a profile's wire index
follows Darwin's `CFBasicHash` bucket order. Five users keyed 501–505 are
transmitted as 504, 501, 505, 502, 503. Up to three users the order is the
identity, which is why smaller configurations never revealed it.
`userProfileSendOrder` in `app/compile-user-profiles.ts` reproduces this with
the existing `foundationDictionaryOrder` model; the same order applies to the
full transfer's user stage, which walks the same list.

Evidence: `tools/oracle/private/user_capture.m` drove the original method over
synthetic archives and `tools/oracle/private/user_order.m` printed the app's
own collection order; `tests/user-transfer.test.mjs` holds five committed cases
(no users, one user, three users, five users with the reordering, and
multi-chunk payloads) that require byte-identical frames. No controller reply
to this exchange has ever been observed, so the bridge compiles and self-checks
the frames offline and refuses to transmit them.

### Status requests (`ff f1`) — binary verified, not transmitted

A second frame family. Both are nine-byte constants with CRC-16/X25 appended
over all nine bytes, recovered from `-requestPeriodFlags` (0x100041278) and
`-requestPendingScenes` (0x1000413e4):

```text
ff f1 00 00 00 00 00 00 00 <crc-lo> <crc-hi>   # period flags
ff f1 01 00 00 00 00 00 00 <crc-lo> <crc-hi>   # pending scenes
```

These are implemented (`statusRequest()`) and unit-tested but **gated off**: no
reply has been observed on hardware. Their existence corrects an earlier claim
that period flags were reachable only through the encrypted remote protocol —
the frame is plaintext, and AES-OFB is applied afterwards only when the session
type requires it.

### Switch/dim function frame (`06`) — binary verified, not transmitted

`-sendSwDiMessage:value:function:` (0x100041550). CRC over seven bytes:

```text
ff f3 <flags> <target-1 & 0x7f> <value & 0x7f> <function & 0x7f> 00 <crc-lo> <crc-hi>
```

Payload bytes are masked to seven bits so none can stray into the `fd`–`ff`
delimiter range; the dropped high bits are recorded in the flags byte, which is
`0x06` plus `0x08`/`0x10`/`0x20` for target/value/function respectively. The
target is transmitted **zero-based**.

Callers are `runScene:`, `brightness:` and `brightnessStep:`, so this is the
scene/brightness path. The verified live path in this build still expands a scene
into per-channel `04` dim frames; the individual `function` codes were not
recovered, so this frame is implemented for parity and never sent.

## Controller-to-client records

### Unsolicited record set on a type-0 session — hardware verified

A 50-second passive capture on an authenticated site-type-0 local session
(nothing sent after the authentication record) produced **only** `f2` records:
312 of them, every additive check valid, no unrecognised record shape. About
2.4 complete 128-address scans.

So on a local session the controller volunteers the channel-level scan and
nothing else. `f4`/`f5` appear in response to commands, and no period or
pending-scene record is emitted unsolicited — obtaining one requires a request
frame that the recovered binary only ever emits for encrypted remote sessions.
Captured summary: `tools/oracle/fixtures/type0-record-capture.json`; reproduce with
`tools/capture-records.mjs` (read-only by construction).


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
| `verify` | compiled image CRC | Run the recovered read-only comparison |
| `transferDryRun` | compiled image, user payloads, fixed clock, profile | Replay and self-check the sender entirely in bridge memory; never write to the controller |
| `transferSafetyStatus` | optional image CRC | Report lock, stop, audit and recent-Compare state |
| `transferEmergencyStop` | optional image CRC | Latch the safety stop and close controller sockets |
| `transferAudit` | optional result limit | Return recent sanitized safety events |
| `sync` | exact compiled image, user payloads, clock, profile, `Continue` confirmation | Run the qualified live sender only after matching same-session Compare and dry-run bindings |

The bridge advertises a deny-by-default controller capability profile. The
baseline `type-0-live-only` profile permits recovered local controls, passive
status behavior, read-only comparison, and the fully qualified transfer path
only when Compare reports firmware 4.0. Detection, profile-only writes, blind
commands, remote sessions, other site types, and other firmware variants remain
disabled until a hardware-specific profile supplies executed and tested
evidence.

The bridge sends:

| Type | Meaning |
| --- | --- |
| `status` | Discovery, connection, authentication, or error state |
| `discovered` | Controller host and port found |
| `trace` | Meaningful transmitted frames and non-`f2` replies |
| `channelStatus` | Batched map of controller channel addresses to levels |
| `transferPreflight` | Offline frame-validation result and exact-input binding |
| `transferProgress` | Original-app transfer lifecycle and block progress |
| `transferResult` | Terminal live-transfer outcome after reset/reconnect gating |

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
| `JCLFDPeriod` | One of 10 time periods, or one of the following 25 state-flag labels. |
| `JCLFDUser` | A user account and its access rights. |

Object relationships are expressed by an integer identity, not by `CF$UID`:
every model object carries a random ~24-bit `ky`, and references to it are
stored as plain integers. The field tables below mark these `→ ky` references.

> Field semantics below are **binary verified** (recovered from the iOS
> executable's Objective-C metadata and coder methods) and **archive
> validated** against one real reference `.fd4cfg` (42 hardware objects, 3
> modules, 11 switches, 98 scenes, 35 period-class records (10 timed periods
> followed by 25 state-flag labels), 2 users). Fields still lacking a
> confirmed meaning are marked **unconfirmed** and must not be relied on for a
> whole-controller transfer.

### Positional site fields

The positional `$N` keys are not written with explicit names: the iOS writer
(`JCLFDConfig getExportFileData`) calls NSKeyedArchiver's non-keyed
`encodeObject:` repeatedly and Foundation assigns `$0`, `$1`, … in call order.
Only `modc`, `modcB` and `hwc` use named integer keys. The complete recovered
encode order is:

1. `$0` format marker (`"29"`) and `$1..$29` site scalars (table below);
2. bus-A module IDs (`modc` of them, `$30` onward), then bus-B module IDs
   (`modcB` of them) immediately after;
3. every `JCLFDHardware` object (`hwc` of them);
4. four configuration fields: name, description, an eight-character code, and
   the configuration's update date (`NSDate`);
5. the switch, scene, period and user sections in that order, each preceded
   by its count encoded as a decimal string (the decoder reads the object and
   takes `integerValue`).

| Archive key | Meaning |
| --- | --- |
| `$0` | Format marker (`"29"`) |
| `$1` | Site name |
| `$2`–`$5` | Address lines |
| `$6` | Contact |
| `$7` | Telephone |
| `$8` | Email |
| `$9` | Site ID (its fifth character selects the site type) |
| `$10` | 16-character controller security code |
| `$11` | Saved controller IP |
| `$12` | Automatic discovery flag |
| `$13` | Modules-changed flag |
| `$14` | Last-updated value (`NSDate`) |
| `$15`, `$16` | Longitude, latitude |
| `$17` | Time zone |
| `$18` | Router-inbound enabled flag (`0`/`1` in the reference archive) |
| `$19` | Router-inbound port |
| `$20` | Daylight-saving rule (`"No Daylight Saving"` in the reference archive) |
| `$21`–`$24` | Wireless-gateway addresses 1–4 |
| `$25`–`$28` | Wireless-gateway counts 1–4 |
| `$29` | Remote-server hostname |
| `hwc` | Number of stored `JCLFDHardware` objects |
| `modc` | Number of stored bus-A modules |
| `modcB` | Number of stored bus-B modules |
| `$30...` | Bus-A module IDs, then bus-B module IDs, in controller-address order |

Modules are stored in two ordered buses, A then B, counted by `modc` and
`modcB`. The order within each bus is the controller-address order and must be
preserved on import — it is not re-sorted by module ID (see channel addressing
above). The reference archive has no bus-B modules (`modcB = 0`); the writer
only emits a non-zero bus-B section for site types above 1, and
`moduleForModuleNumber:` indexes bus-B modules from number 16 (`number - 15`),
so bus-B wire addressing remains unverified against hardware.

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
| `dr` | int | Display rank (`displayRank` in the recovered class metadata) |
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

### `JCLFDPeriod` — periods and state-flag labels

The archive stores one 35-object array. The iOS Periods screen and compiler
assign fixed meanings by position: objects 0–9 are timed Periods; objects 10–34
are the names of the 25 State Flags shown in a 5×5 grid. The latter are labels,
not additional schedule rows.

| Field | Type | Meaning |
| --- | --- | --- |
| `nm` | string | Period name |
| `ix` | int | Index / order |
| `st`, `et` | int | Start and end value |
| `sm`, `em` | int | Start and end mode: absolute, sunrise, or sunset |

Start/end are interpreted according to their independent modes; older builds
mistakenly treated the mode values as clock minutes.

For timed rows, iOS disables the From/To controls until the row has a non-empty
name. Clearing the name also zeros `st`, `et`, `sm`, and `em`. State-flag rows
use only `nm`; their other archived values remain zero.

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
on import. This remains a webapp backup, not the binary controller image.

FlexiDim Web also regenerates an original binary `.fd4cfg`
(`app/fd4cfg-export.ts`): it rebuilds the NSKeyedArchiver object graph in the
recovered positional encode order, starting from each entity's preserved
legacy fields and overriding only the values the web editors own, so unknown
archive fields survive an import → export → import round trip. The round trip
is proven lossless against the golden fixture (`tests/fixtures/golden.fd4cfg`)
and, when locally present, a real reference archive
(`tests/fd4cfg-roundtrip.test.mjs`).

### `.fd4xlt` translation documents

A `.fd4xlt` file is not a keyed archive: it is CRLF-delimited text produced by
the iOS `getEquipCSVData` and read by `importConfigFD4XLT:`, with three
sections:

```text
#SWITCHES <number> <Type> <name/location>
#CHANNELS <number> <dimmable> <name/location>
#SWITCH-SCENES <switch number:button number> <scene1 name/location> <scene2 name/location>
```

The two scene fields on a switch-scene row are the first and second press of
one physical button. Importing a translation document creates a fresh
starting-point configuration (no basic assignments, periods or users), exactly
like the original app; it does not restore a saved configuration.

## Comparing and transferring a whole configuration

Three different operations are easily confused:

1. **Download configuration** in FlexiDim Web downloads `.fd4web.json` from the
   browser to the computer. It does not contact the Scene Controller.
2. **Compare with Scene Controller** compiles the local controller image and asks
   the controller to verify it, returning the controller's verdict and metadata.
3. **Send configuration to Scene Controller** is an app-to-controller transfer,
   called a “download” by the original iOS code.

The editable `.fd4cfg` object graph is not sent directly. The original app's
`JCLFDConfig.compileConfig` method compiles sites, hardware, Basic Assignments,
scenes, periods, users, hardware profiles, location/time information, and other
tables into a controller-specific binary image. It also calculates a local CRC.

### Comparison / verification — recovered read-only workflow

Recovered methods and UI strings show this workflow:

1. Compile the current local configuration.
2. Calculate and display its local CRC.
3. Authenticate a controller session.
4. Run `startVerify` / `processVerify:` to request the controller's installed
   configuration CRC.
5. The controller returns its verdict, CRC, day/time and firmware version.
6. Exit verification mode.

There is no evidence that comparison downloads the controller's complete image
or reconstructs an editable `.fd4cfg`; the recovered behavior is CRC-based.

The type-0 wire state machine recovered from `processVerify:` is:

1. Send `FF FC 00 00 00 00` plus CRC. Retry after 31 100ms ticks, at most six
   attempts. `FF F8 00 00 00 00` aborts an unacknowledged handshake.
2. A reply whose first byte is `06` advances the state.
3. Send `FF F5 00 00 00 00` plus CRC.
4. Read ten bytes. Byte 0 is the controller verdict (`06` is verified); bytes
   1–2 store the displayed CRC low byte first; 3–5 are second/minute/hour; byte 6
   is a one-hot day-of-week value; byte 7 is unused by the display; and bytes
   8–9 are the decimal firmware major/minor version.
5. Send `FF FE 00 00 00 00` plus CRC to leave verification mode on success,
   failure or result timeout.

The controller's byte-0 verdict remains authoritative for the verification
exchange. For Send qualification, however, the bridge deliberately applies a
stronger invariant: the freshly compiled local image CRC and the returned
controller CRC must both equal the exact image CRC bound to the dry run. This
was exercised against the installed firmware 4.0 controller before the live
path was enabled; the private CRC stays in ignored local documentation.

### App-to-controller transfer — iOS sender implemented

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
firmware variations and controller-side behavior are not yet hardware verified.

The original type-0 sender has now also been executed offline with its
`NSOutputStream` replaced by an in-memory recorder. This proves the following
app-output format without contacting a controller:

1. Send CRC-framed `ff f6` BCD time and date records (the time record ORs
   `0x40` into its BCD hour during daylight saving), then
   `ff fc 00 00 00 00`.
2. Compile, send the `ff fc` handshake again, and advance on reply byte `06`.
3. After 21 100-ms process ticks, send the image as blocks whose unescaped body
   is `fe <u16-le block index> <256 payload bytes>`. CRC-16/X25 is appended over
   all 259 bytes and normal `1b` escaping is then applied.
4. Follow every block with `ff f7 00 00 00 00` plus CRC. Reply `06` accepts the
   block. Reply `15` rejects it and immediately resends the identical data block
   and `ff f7` poll. The app allows five retries after the initial attempt
   (six attempts total); another `15` sends `ff f8` and aborts. No reply for
   101 process ticks—on the app's 100-ms timer—triggers the same resend.
5. The committed 36,492-byte synthetic oracle image produces 143 blocks
   numbered 0 through 142. The payload stream is the byte-identical final
   image, followed by the first compiler pass's CRC as a little-endian `u16`,
   then the final image CRC as another little-endian `u16`, then zeros to the
   next 256-byte boundary. The two CRCs explain the four
   configuration-dependent nonzero bytes immediately beyond the image's
   self-declared length.
6. After the final accepted block, the next process tick sends
   `ff fa 00 00 00 00`. State 5 accepts at least ten response bytes beginning
   `06`, sends `ff f9 00 00 00 00`, and enters state 6. Its 151-tick failure
   path sends `ff f8`.
7. State 6 accepts at least two bytes beginning `06 00`, sends
   `ff f8 00 00 00 00`, and enters the user-transfer state.
8. One process tick sends all chunks for one user. After all users, the sender
   emits `ff f2 e0 7f 7f` with a zero-filled payload.
9. The final state completes when the ivar named `F3MsgCount` reaches ten. The
   type-0 receive parser's validated `f2` and `f4` jump-table branches both
   increment that counter; the name does not mean the incoming records begin
   `ff f3`. The recovered state-6 and final-status failure threshold is 1,201
   ticks.

The last point is binary evidence, not a naming inference: the `f1`–`f6`
jump table in `stream0:handleEvent:` routes `f2` to `0x10003999c` and `f4` to
`0x100039b90`; both blocks increment the same ivar before applying bytes 1 and
2 to the channel-level arrays. End/error events preserve the download state and
lead through `tcpOpenTimeout:` and `schedTcpOpen`, whose one- and two-second
delays give the three-second manual-host reconnect cycle used by the runner.

The bridge now accepts `sync` only for the qualified local type-0 profile and
runs this exact state machine on its authenticated TCP stream. The
implementation was derived from executed original-app output and recovered
binary transitions, not a guessed packet design. It handles the recovered
acknowledgement, retry, abort, permanence, reset-disconnect, three-second
reconnect and normal-status completion behavior.

### Original iPad live UI sequence — observed 2026-07-26

Evidence level: **user-observed live behavior of FlexiDim iOS 2.97 on the
installed Scene Controller**. This records what the original app displayed and
what the room lighting did; it is not a packet capture and does not by itself
identify which controller reply caused each transition.

Before sending, the original app presents this warning:

> **Ready to send configuration to Scene Controller**
>
> Continuing will suspend operation of the switches until the new
> configuration is completely downloaded. The lighting system will also reset
> which, depending on the new configuration, may result in the light levels
> changing or going off. The download process will take several minutes.

The dialog offers **Continue** and **Cancel**. After Continue, the observed
sequence is:

1. “Reconnecting to the Scene Controller”
2. “Downloading block X” with a progress bar, ending at the final block
3. “Verifying Scene”
4. “Making Scene permanent — this will take up to 60 seconds”
5. “Download complete — resetting Scene Controller — this takes about 60
   seconds”
6. The room lights went off during the reset
7. “Download completed successfully, Scene Controller running normally.”

The displayed endpoint agreed with the recovered sender’s computed image-block
count. Binary execution establishes that the UI is one-based while wire block
indices are zero-based. The web UI now preserves the recovered warning,
explicit Cancel/Continue choice, lifecycle phase distinctions and one-based
block progress, and does not report success before the controller reconnects
and supplies ten valid normal status records.

### First web transfer on installed hardware — succeeded 2026-07-26

The user subsequently ran the qualified web transfer against the installed
firmware 4.0 Scene Controller and reported that it worked. This is
**[WEB-LIVE]** evidence for the complete web/bridge/controller path, in addition
to the executed iOS oracle and emulator transcript.

The run exposed a presentation-only issue. The original state machine emits the
reset title and duration as two immediate progress events:
`Download complete - resetting Scene Controller`, then
`This takes about 60 seconds`. The latter replaced the former before the web UI
painted. The visible web text now combines their meaning as
`Restarting Scene Controller — this takes about 60 seconds`; no wire frame,
timer, transition or recovered protocol string was changed.

`bridge/config-transfer.mjs` is the pure executable model of the
oracle-proven type-0 sender. It reproduces setup, image blocks, polls, CRC tail,
ACK/NAK and timeout retries, the FA/F9/F8 exchange, F2 user chunks, global
marker, and final-status completion. It fails closed for unsupported
site/firmware modes and module/channel/profile branches.
`bridge/transfer-runner.mjs` supplies the recovered timer and stream lifecycle,
and `bridge/server.mjs` connects that runner to the authenticated controller
socket. A private local comparison matched the complete original-sender
transcript through every configured user and the global marker, both with
payloads recovered in memory from the capture and with those payloads
independently compiled from the imported web model. Public documentation does
not retain its frame count, user count or configuration fingerprint; the
transcript remains an external, ignored artifact.

`bridge/transfer-safety.mjs` first wraps that model in an offline preflight. It
validates base64 canonically, independently checks the compiled image CRC,
drives the actual `ConfigurationTransferRunner`, reverses escaping and checks
every frame CRC/body, exercises the binary-recovered three-second reset
reconnect cycle, and requires ten checksum-valid `f2`/`f4` receive records
before success. It then returns only counts, CRCs, an exact-input binding hash
and a transcript hash.

A live request is accepted only when a successful Compare on the same WebSocket
is no more than five minutes old, both reported CRCs equal the exact image CRC,
the controller reports the specifically qualified firmware version `4.0`, and
a successful dry run is bound to the same image plus length-prefixed user
payload hashes. The literal confirmation value must be `Continue`. A global
lock prevents concurrent transfers; the overall deadline, cancellation,
emergency-stop latch and sanitized append-only audit remain active. Audit and
diagnostic records contain frame names, block numbers and lengths but never
configuration bytes, user bytes, credentials or controller addresses.

The committed synthetic integration test crosses the real WebSocket bridge and
a real TCP controller emulator, validates **295/295** oracle frames, simulates
the controller reset, reauthenticates after the recovered three-second delay and
supplies ten valid status records. This proves bridge integration without
writing a controller. The supported profile now advertises
`fullTransfer: true`; all unsupported profiles remain fail-closed. The
controlled web-app transfer to the installed firmware 4.0 controller has now
succeeded. The remaining release evidence is a fresh post-transfer Compare,
physical functional inspection and retention of the sanitized audit.

`initUserData` ordering has one non-obvious compatibility requirement. The
original importer inserts hardware under decimal NSString keys in an
`NSMutableDictionary`, and room channels are sorted by display rank only.
Equal ranks therefore inherit CoreFoundation bucket order. The web importer
reproduces Apple's published NSString hash, CFBasicHash capacities, rehashing,
and linear probing so those ties are byte-exact. Channel index is not a
secondary profile sort key. The room record's third integer is the zero-based
index of its floor name in the payload header, not the room hardware type.

A wholly synthetic oracle fixture produces a 36,492-byte image, 143 blocks,
one user payload, and 295 frames. The test suite reproduces all 295 frames
byte-for-byte. `tools/oracle/transfer-prefix-emulator.mjs` consumes the complete
transcript, supplies the oracle-proven replies and final status count, injects
NAKs and timeouts, and rejects mutated or out-of-order frames.

The imported web model of that deliberately from-scratch synthetic archive
currently compiles to 36,502 bytes and differs beyond length, so that fixture
proves sender framing rather than general compiler parity. The private
reference and five controlled mutations remain byte-identical compiler checks.

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
| Offline transfer preflight and safety gate | `bridge/transfer-safety.mjs` |
| Timed transfer runner and reset reconnect gate | `bridge/transfer-runner.mjs` |
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

# FlexiDim capture & debug toolkit

Tools to capture the **real** socket traffic between the FlexiDim iOS app and a
Scene Controller, decode it, and debug the webapp against it.

| File | What it does |
| --- | --- |
| `flexidim-trace.js` | Frida script — runs the real `.ipa` on a jailbroken iPad and logs + decodes every byte it sends/receives. |
| `decode.mjs` | Standalone FlexiDim protocol decoder. Decodes a hex string or a `.pcap`. Also used by the emulator. |
| `controller-emulator.mjs` | Fake Scene Controller — debug the webapp/bridge with no hardware. |
| `controller-probe.mjs` | One-socket, zero-or-one-frame probe for isolating controller disconnects without the web app. |

## Why the FritzBox packet trace was empty

The iPad and the controller were both plugged into the FritzBox. The LAN ports
on a FritzBox (like any consumer router) are a **hardware switch**: frames
between two LAN devices are forwarded in silicon and never reach the CPU that
the packet-capture tool taps. So the trace only ever shows traffic to/from the
FritzBox itself — never iPad↔controller. This is expected, not a bug.

Reliable capture points, in order of preference:
1. **On the iPad** (Frida or tcpdump) — you have the jailbreak, so do this.
2. A real **inline** device: a Linux box with two NICs bridging iPad↔controller,
   or a mirrored/SPAN port on a managed switch. A dumb hub also works.

---

## Option 1 — Frida on the jailbroken iPad (recommended)

Captures the literal socket bytes from the running app, decoded live. This is
the "run the ipa as is and capture its communication" path.

### One-time setup on the iPad
Install `frida-server` from Sileo/Cydia: add the repo `https://build.frida.re`,
install **Frida**. It starts a `frida-server` on the device. (Alternatively
`ssh` in and run a `frida-server` binary matching your jailbreak's arch.)

### On your Mac
```bash
python3 -m pip install --user frida-tools   # provides `frida`, `frida-ps`
# Connect the iPad by USB. Confirm the device + app are visible:
frida-ps -Uai | grep -i config    # look for "Configuration" / com.jclighting.flexidimconfig
```

### Capture
Spawn the app under instrumentation so you catch connection setup + handshake
from the very first byte:
```bash
frida -U -f com.jclighting.flexidimconfig -l tools/flexidim-trace.js --no-pause \
  | tee flexidim-capture-$(date +%s).log
```
Then in the app: connect to the controller and send a dim / switch command.
You'll see, per frame:
```
[12:01:03.412] ⇢ connect() fd7 → 192.168.178.42:15273
[12:01:03.550] ·· -[JCLAppDelegate sendDiMessage:brightness:transition:]  channel=5 level=100 fade=2
[12:01:03.551] → TX 192.168.178.42:15273  (8 bytes)
  hex : ff f3 04 05 64 02 b9 e2
  txt : ........
  ►►► DIM channel=5 level=100% fade=2  | crc OK
[12:01:03.590] ← RX 192.168.178.42:15273  (N bytes)   <-- the controller's reply
```
The **TX** line is the wire-level ground truth. RX lines show whether the
controller replies, but plaintext live dim/switch commands do not require a
separate TCP handshake in this app version.

If the app crashes on spawn (some jailbreak/anti-debug combos), attach instead
after launching it by hand: `frida -U -n FlexiDim -l tools/flexidim-trace.js`.

## Option 2 — tcpdump on the iPad (fallback)

If Frida won't attach, capture packets on-device and decode offline:
```bash
# on the iPad (ssh):
tcpdump -i any -n -s0 -w /tmp/flexidim.pcap 'host <controller-ip>'
# ...drive the app, then Ctrl-C. Pull the file:
scp root@<ipad-ip>:/tmp/flexidim.pcap .
# decode on your Mac (needs tshark / wireshark installed):
node tools/decode.mjs --pcap flexidim.pcap
```

## Decode ad-hoc bytes
```bash
node tools/decode.mjs "ff f3 04 05 64 02 b9 e2"
#   DIM channel=5 level=100 fade=2  | crc OK
```

## Smallest-unit live probe

Start with a connection that sends no application data:

```bash
node tools/controller-probe.mjs <controller-lan-ip> --watch 10000
```

Then send exactly one known channel command. The channel is the controller
address (`channel index + 8 * stored module position`), not the channel's row in
the UI:

```bash
node tools/controller-probe.mjs <controller-lan-ip> --config "/path/to/site.fd4cfg" --dim <channel> 50 0
```

To isolate a live scene or built-in switch action, send its exact dim expansion
on one fresh connection:

```bash
node tools/controller-probe.mjs <controller-lan-ip> --config "/path/to/site.fd4cfg" --dims 17:100:1,1:100:1,9:100:1,2:100:1
```

For a command probe, `--config` reads the 16-character site security code and
sends the iOS authentication record before the command. (`--key` can supply it
directly, but may leave the key in shell history.) The probe redacts the key in
its output, then prints command TX/RX bytes and how long after the write the
socket closed. This separates protocol rejection from browser, WebSocket,
throttling, and bridge-lifecycle issues.

A command probe collects replies for one second and then forcibly closes its
own socket. The controller emits status packets continuously, so routine `f2`
packets are counted rather than printed. Use `--watch 10000 --verbose` only
when a longer raw receive trace is wanted.

## Option 3 — Controller emulator (debug the webapp with no hardware)
```bash
node tools/controller-emulator.mjs
# then point the bridge's controller host at 127.0.0.1 (port 15273)
```
It logs + decodes every frame the webapp sends and verifies the CRC, so you can
confirm the webapp emits correct bytes before you ever touch the real hardware.
Its replies are placeholders — once you capture the real controller's replies
(Option 1), paste them into `reply()` to make it behave like genuine hardware.

---

## Protocol reference (reverse-engineered from FlexiDim.app 2.97, arm64)

- **Transport:** TCP to the controller on `routerInboundPort` (default **15273**),
  via `NSOutputStream write:maxLength:`. Discovery is UDP: broadcast on **15270**,
  reply on **15001**.
- **Framing:** `0xff` header (never escaped) + `0xf3` + command + value bytes +
  CRC (little-endian). After the header, any byte equal to `0x1b` or `≥ 0xfd` is
  escaped by prefixing `0x1b`.
- **CRC:** CRC-16/X.25 — poly `0x1021` reflected (`0x8408`), init `0xFFFF`,
  reflected in/out, final XOR `0xFFFF`. (Confirmed against the binary's nibble
  lookup table: `table[1]=0x1081`, `table[8]=0x8408`.)
- **Plaintext live commands** (6-byte body before the two CRC bytes):
  | Bytes | Meaning |
  | --- | --- |
  | `ff f3 00 <switch> <button> 00` | Switch button press |
  | `ff f3 04 <channel> <level> <fade>` | Dim a channel |
  | `ff f3 02 …`, `ff f3 06 …` | Config/profile (not yet mapped) |
  | `ff f1 00 …`, `ff f1 01 …` | Profile messages (not yet mapped) |
- **siteType variants:** the app builds 3 forms. Type 0 = plaintext (above).
  Type 2 = AES-encrypted (`AESEncodeOFB:length:`) for remote/internet access.
- **Channel address:** `channel.index + 8 * moduleForModuleNumber(channel.module)`.
  `moduleForModuleNumber:` searches the stored site module array in order; it
  does not sort module IDs or pack the module into a four-bit nibble. Bus-B
  module positions begin at 16.
- **Switch address:** the hardware object's archived `index` field, followed by
  the physical button number. It is not the switch's row number in the UI.
- **Discovery probe:** UDP payload is literally `"FLEX"` (4 bytes, UTF-8), sent by
  `-[JCLAppDelegate initUDPSocket:]`. (The bridge already sends this correctly.
  The string `"FLEXIDIM"` in the binary is only used by a UI text-field validator,
  never on the wire.)
- **Remote registration (`PROGRAMMENOW`):** decoded from `initUDPSocket:`. The
  app can emit a **UDP** registration datagram for its remote-server path,
  structured as:
  ```
  "PROGRAMMENOW"                       12 ASCII bytes
  + "<siteID-part1>:<siteID-part2>"    NSString %@:%@ from two substrings of siteID
  + "<secCode>"                        the security-code string
  + secCode        [16 bytes]          char codes, zero-padded to 16
  + siteName       [32 bytes]          char codes, zero-padded to 32
  + localIPv4      [ 4 bytes]          the iPad's OWN LAN IP octets (split on ".")
  ```
  sent via `sendData:toHost:port:`. The siteID, secCode, and siteName come from
  the loaded `.fd4cfg` (`$9`, `$10`, `$1`). Note the secCode is a 16-character
  string, so it fills the 16-byte field with no padding.
  This is not a prerequisite frame on the local plaintext TCP dim/switch path:
  `openConnection:siteID:connect:` proceeds to `initTCPto:onPort:` without
  writing a handshake to that TCP stream.

### Webapp bugs identified and fixed during reverse-engineering
1. **Switch command was one byte short.** The app always sends a **6-byte**
   body, `ff f3 00 <sw> <btn> 00`; omitting the last byte changes the CRC and
   makes the controller reject it.
2. **Wrong channel address.** The importer used `(module << 4) | channel`; the
   iOS app uses `modulePosition * 8 + channel`, with the stored module order.
3. **Wrong switch address.** The web app used its logical list ID instead of the
   archived hardware `index` passed by the iOS app.
4. **Invalid keep-alive.** The bridge sent a guessed plaintext `ff f3 05` every
   three seconds. The iOS period request is a longer encrypted remote-profile
   message, not a local plaintext keep-alive.
5. **Logical scene slot sent as a physical button.** The Scene-to-Button screen
   sent values such as 21 (`2P-1`) in a switch frame. For type 15, the shifted
   built-ins map to physical wire buttons 9, 10, and 12. In Live System mode,
   Default on/off is expanded to the switch's Basic Assignment dim frames
   instead of sending a switch frame at all.

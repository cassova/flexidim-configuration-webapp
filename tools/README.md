# FlexiDim capture & debug toolkit

Tools to capture the **real** socket traffic between the FlexiDim iOS app and a
Scene Controller, decode it, and debug the webapp against it.

| File | What it does |
| --- | --- |
| `flexidim-trace.js` | Frida script — runs the real `.ipa` on a jailbroken iPad and logs + decodes every byte it sends/receives. |
| `decode.mjs` | Standalone FlexiDim protocol decoder. Decodes a hex string or a `.pcap`. Also used by the emulator. |
| `controller-emulator.mjs` | Fake Scene Controller — debug the webapp/bridge with no hardware. |

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
The **RX** lines are the gold: they show exactly what a healthy controller
replies with (including the handshake response), which is what the webapp needs
to reproduce.

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
  reply on **15001**. (Confirm the discovery magic — binary contains `"FLEXIDIM"`;
  the current bridge sends only `"FLEX"`.)
- **Framing:** `0xff` header (never escaped) + `0xf3` + command + value bytes +
  CRC (little-endian). After the header, any byte equal to `0x1b` or `≥ 0xfd` is
  escaped by prefixing `0x1b`.
- **CRC:** CRC-16/X.25 — poly `0x1021` reflected (`0x8408`), init `0xFFFF`,
  reflected in/out, final XOR `0xFFFF`. (Confirmed against the binary's nibble
  lookup table: `table[1]=0x1081`, `table[8]=0x8408`.)
- **Commands** (6-byte body unless noted):
  | Bytes | Meaning |
  | --- | --- |
  | `ff f3 00 <switch> <button> 00` | Switch button press |
  | `ff f3 04 <channel> <level> <fade>` | Dim a channel |
  | `ff f3 05` | Request period flags |
  | `ff f3 02 …`, `ff f3 06 …` | Config/profile (not yet mapped) |
  | `ff f1 00 …`, `ff f1 01 …` | Profile messages (not yet mapped) |
- **siteType variants:** the app builds 3 forms. Type 0 = plaintext (above).
  Type 2 = AES-encrypted (`AESEncodeOFB:length:`) for remote/internet access.
- **Discovery probe:** UDP payload is literally `"FLEX"` (4 bytes, UTF-8), sent by
  `-[JCLAppDelegate initUDPSocket:]`. (The bridge already sends this correctly.
  The string `"FLEXIDIM"` in the binary is only used by a UI text-field validator,
  never on the wire.)
- **Registration handshake (`PROGRAMMENOW`):** decoded from `initUDPSocket:`. On
  connect the app also broadcasts a **UDP** registration datagram, structured as:
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
  Open items for the capture to confirm: the exact siteID split indices, the
  destination host (broadcast vs controller IP) and UDP port, and — crucially —
  whether this registration is required before the controller honours the TCP
  dim/switch stream. This is the leading candidate for why the webapp "connects
  but the controller ignores it".

### Known webapp bugs found during reverse-engineering
1. **Switch command is one byte short.** `bridge/protocol.mjs` builds
   `ff f3 00 <sw> <btn>` (5-byte body); the app always sends a **6-byte** body
   with a trailing `0x00` → different length + CRC → controller rejects it.
2. **No handshake.** The bridge opens TCP and immediately sends commands; the
   app performs `openConnection:siteID:connect:` first. Without it the controller
   likely drops the connection or ignores commands.
3. **Discovery magic** may be `"FLEXIDIM"`, not `"FLEX"` — confirm from capture.

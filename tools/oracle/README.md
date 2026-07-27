# FlexiDim oracle

The oracle is the project’s reference implementation for behavior recovered
from the original FlexiDim iOS configuration app. It lets us ask the original
app’s own code what configuration bytes, checksum, user-profile payloads, and
transfer frames it would produce, then compare the web implementation with that
answer.

“Oracle” here does not mean a controller simulator, an AI model, or a collection
of expected guesses. It means an independently executed source of ground truth.
The original iOS routines produce an output; our implementation must match it
byte-for-byte.

## Why it exists

A configuration that looks correct in the editor can still be unsafe if one
field is encoded at the wrong offset, objects are emitted in the wrong order,
or the transfer state machine sends one plausible but incorrect frame. The
oracle turns those questions into repeatable comparisons:

```text
synthetic or private .fd4cfg
        │
        ├── original iOS code ──► reference image, CRC, payloads and frames
        │
        └── web implementation ─► generated image, CRC, payloads and frames
                                      │
                                      └── require a byte-for-byte match
```

This is more reliable than inferring a binary format from one checksum or
assuming that a frame accepted by an emulator is what the original app sent.

## The three layers

### 1. Executable iOS oracle — private and optional

`private/` contains local research harnesses that load recovered ARM64 code from
the original iOS app on an Apple Silicon Mac. They can invoke the original
configuration compiler and drive the original download state machine with
scripted controller replies without opening a controller socket.

This directory is ignored by Git because it can contain decrypted application
code, private configurations, compiled images, and wire transcripts. It is not
needed to build, run, or test the web app. If it exists locally, its detailed
rebuild and operation notes are in `private/ORACLE.md`.

### 2. Sanitized synthetic evidence — committed

`fixtures/` contains the public evidence produced from a wholly synthetic
configuration:

| File | Purpose |
| --- | --- |
| `transfer-oracle.fd4cfg` | Synthetic type-0 source archive supplied to both implementations. |
| `transfer-oracle-image.bin` | Exact compiled configuration image emitted by the original compiler. |
| `transfer-oracle-user-payloads.json` | Exact synthetic user payloads, base64 encoded. |
| `transfer-oracle-wire.json` | Complete escaped sender transcript, one hex frame per entry. |
| `transfer-oracle-manifest.json` | Payload-free state-transition and frame-family summary. |
| `type0-record-capture.json` | Sanitized type-0 record evidence used by packet regression tests. |

These files contain synthetic identities and may be used in CI. They allow the
ordinary test suite to retain oracle coverage without distributing or executing
the original app.

### 3. Public comparison and emulation tools

| File | Purpose |
| --- | --- |
| `build-transfer-oracle-fixture.mjs` | Builds configurable, synthetic type-0 `.fd4cfg` inputs for new oracle experiments. |
| `transfer-prefix-emulator.mjs` | Requires the exact next oracle frame and supplies the scripted response used by the offline iOS run. |
| `../controller-emulator.mjs` | Wraps the transcript validator in a TCP controller emulator for full bridge-session tests. |

The emulator is deliberately strict. It detects a sender regression; it does
not manufacture evidence that an unobserved controller would accept a new
protocol.

## What the oracle can establish

For a configuration that it is given, the executable oracle can establish:

- the exact compiled configuration-image bytes and CRC;
- first- and second-pass compiler output;
- which bytes change after a controlled single-field mutation;
- original-app ordering and encoding of configuration sections;
- exact user-profile payload text and chunking;
- escaped type-0 transfer frames and their order;
- retry, timeout, abort, reset, and completion behavior reachable through
  scripted inputs;
- sanitized state-machine manifests without retaining payload bytes.

The committed oracle corpus then lets automated tests establish that:

- the web compiler still produces the reference image;
- user-profile compilation still matches the original app;
- all sender frames still match the original transcript;
- CRC, escaping, padding, block numbering, retry, and terminal behavior remain
  stable;
- the bridge runner and controller emulator complete the known
  reset/reconnect lifecycle.

## What it cannot establish alone

The oracle executes app-side code. By itself it cannot prove:

- how a real Scene Controller responds to a frame;
- that an untested controller model or firmware version is compatible;
- behavior of remote/encrypted paths that have not been captured and modeled;
- recovery behavior after every possible power, network, or hardware failure;
- that a forced internal state transition is reachable in the real app;
- that a new configuration feature is safe merely because its output looks
  plausible.

Those claims require separate controller observations, binary evidence, or a
carefully controlled hardware qualification. Production code therefore remains
fail-closed outside the evidence-backed type-0 firmware profile.

## How the project uses it

The normal regression suite reads only the committed synthetic fixtures:

```bash
npm run bridge:test
```

Focused oracle-backed tests can be run with:

```bash
node --experimental-strip-types --test \
  tests/compile-user-profiles.test.mjs \
  tests/config-transfer.test.mjs \
  tests/config-transfer-emulator.test.mjs \
  tests/transfer-runner.test.mjs \
  tests/live-transfer-session.test.mjs \
  tests/packet-regression.test.mjs
```

The full live-session test starts the web bridge and TCP emulator locally. No
Scene Controller is contacted.

To run the standalone emulator against the committed transcript:

```bash
FLEXIDIM_TRANSFER_ORACLE_PATH=tools/oracle/fixtures/transfer-oracle-wire.json \
  node tools/controller-emulator.mjs
```

Then connect a local bridge to `127.0.0.1:15273`. The emulator validates the
known transfer frame-by-frame, simulates the reset/reconnect sequence, and
never drives lighting hardware.

## Creating an additional synthetic input

The fixture builder creates a type-0 archive derived from the project’s
synthetic golden data:

```bash
node --experimental-strip-types \
  tools/oracle/build-transfer-oracle-fixture.mjs \
  /tmp/flexidim-oracle-input.fd4cfg \
  --include-switches \
  --include-users
```

Additional switches, channel hardware types, profile versions, and related
variants are available as command-line options in the builder source. Building
an input does not make it an oracle result: the input must still be run through
the original iOS harness, and its output compared with the web implementation,
before it becomes evidence.

When adding a public case:

1. Use only synthetic names, codes, addresses, and user data.
2. Change one variable at a time when mapping unknown behavior.
3. Capture original-app output into an ignored temporary location first.
4. Compare the original and web outputs byte-for-byte.
5. Sanitize and inspect every proposed fixture before moving it into
   `fixtures/`.
6. Add a focused regression test explaining the behavior the case proves.
7. Run the privacy regression and the full bridge suite.

## When it is useful

Use the oracle when:

- implementing or changing the configuration compiler;
- mapping an unknown archive field to controller-image bytes;
- changing ordering, padding, CRC, escaping, or block construction;
- adding a user-profile or transfer feature;
- investigating a mismatch between the iOS app and web app;
- deciding whether behavior is supported by evidence or is still an
  assumption;
- building a permanent regression case for a newly understood feature.

It is not needed for routine installation, configuration editing, Compare, or
normal use of the web app. It is also not a substitute for a hardware test when
the question concerns what the controller accepts or does.

## Privacy and safety

- Never commit `private/`, a decrypted app binary, a real customer archive, a
  raw compiled image, or a private wire transcript.
- Treat configuration images and transfer payloads as sensitive even when they
  are not human-readable; they may encode names, site structure, access data,
  or credentials.
- Use explicit ignored or temporary paths for private outputs.
- Do not overwrite the committed fixtures directly during an experiment.
- The offline oracle should not open a Scene Controller connection. If testing
  hardware separately, retain an original-app backup and follow the live-send
  safety guidance in the project root [README](../../README.md).

The public privacy regression scans all Git-visible source, documentation, and
configuration artifacts for known private fingerprints:

```bash
node --test tests/privacy-regression.test.mjs
```


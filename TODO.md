# Full configuration transfer — oracle-first delivery plan

The current goal is to reproduce **Send configuration to Scene Controller**
exactly as FlexiDim iOS 2.97 performs it, without using the installed lighting
controller as a protocol-development target.

This checklist is ordered by evidence dependency. Offline oracle, pure-model,
and emulator work may proceed in parallel where it cannot contact a controller;
hardware qualification and release may not skip an incomplete prerequisite.
A plausible frame, a matching checksum, or a successful comparison is not
enough evidence to enable a configuration write.

## Current safe state

- [x] The web Send button remains disabled until the same connection has a
      matching recent Compare and an exact-input offline dry run.
- [x] The bridge accepts `sync` only under the qualified
      `type-0-live-only` capability profile and only after all safety bindings.
- [x] The oracle-proven state machine is connected to the authenticated bridge
      socket, reset/reconnect path and ordinary-status parser.
- [x] The read-only Compare operation is independent and remains available.
- [x] The original iOS compiler can be run locally as an oracle without a
      Scene Controller.
- [x] For the ignored private reference, the web compiler and iOS oracle
      produce the same complete image and checksum. Exact fingerprints remain
      outside Git-visible files.
- [x] Import → export → import preserves that controller image byte-for-byte.
- [x] Independently compile every private-reference user payload byte-for-byte
      and use them to reproduce the complete original-app transcript. Counts
      remain outside Git-visible files.
- [x] Exercise the complete committed synthetic transcript through a real
      WebSocket bridge and TCP emulator: 295/295 frames, reset, reconnect,
      reauthentication and ten validated normal status records.
- [x] Perform the first controlled web-app transfer to the installed firmware
      4.0 controller; the user reported successful completion.

## Evidence labels

- **[ORACLE]** Executed original iOS code with its output intercepted in memory.
- **[BIN]** Recovered from the original app binary but not executed.
- **[CAPTURE]** Observed in an original-iOS network capture.
- **[EMU]** Exercised end-to-end against the controller emulator.
- **[SPARE]** Exercised on a recoverable, unloaded Scene Controller.
- **[LIVE]** Exercised on the installed lighting system during an approved
  maintenance window.
- **[WEB-LIVE]** Exercised successfully from the web app through the bridge on
  the installed firmware 4.0 Scene Controller.
- **[IOS-LIVE]** User-observed successful original iOS transfer on the installed
  firmware 4.0 controller, including all displayed blocks, reset and return to
  normal operation.

The current type-0 capability is enabled from converging **[ORACLE] + [BIN] +
[EMU] + [IOS-LIVE] + [WEB-LIVE]** evidence: exact sender bytes and branches
come from the app, and the complete web path succeeded on the installed
firmware 4.0 controller. Unsupported profiles remain disabled. Post-transfer
Compare, representative physical inspection and audit retention remain release
follow-up items.

---

## Gate 1 — Preserve and extend the oracle

### 1.1 Compiler oracle

- [x] Load the original ARM64 app as a Catalyst library.
- [x] Import an iOS `.fd4cfg` with the original reader.
- [x] Intercept `obtainCRC:length:` and capture both compiler passes.
- [x] Prove CRC-16/X25 over the final image gives the iPad-displayed checksum.
- [x] Prove the current reference image is byte-identical across the iOS and
      web compilers.
- [ ] Record the source app binary hash and oracle toolchain versions in every
      generated fixture manifest.
- [x] Make a committed, wholly synthetic type-0 transfer configuration compile
      and complete the original app's offline sender, including one user.
- [ ] Build a synthetic oracle corpus covering:
  - no scenes, one scene, and maximum scene/action counts;
  - no switches and sparse/high switch bus addresses;
  - both module buses;
  - all supported period modes and boundary times;
  - scene links, period operators, and State Flag actions;
  - empty and maximum user/profile payloads;
  - daylight-saving and year boundaries;
  - every next-scene mode seen in real data.
- [x] Store only synthetic `.fd4cfg`, compiled-image, wire, manifest, and
      user-data fixtures in the repository. Never commit a real-site image or
      user-data payload.
- [ ] Make the from-scratch synthetic transfer archive compile identically from
      its imported web model. Today the original app emits 36,492 bytes while
      the web model emits 36,502. The images differ beyond length as well, so
      this remains a synthetic archive/compiler-semantics investigation, not a
      transfer-framing defect.
      Do not use this fixture as compiler/send-readiness evidence. The imported
      reference plus five mutations still match the iOS compiler byte-for-byte.

### 1.2 Offline transfer oracle

`tools/oracle/private/transfer_capture.m` injects an imported configuration into the
original app and replaces its `NSOutputStream` with an in-memory recorder. It
does not create a socket or contact a controller.

- [x] Instantiate the original `JCLTabViewController` offline.
- [x] Inject the original app's current-configuration pointer without disabling
      ASLR.
- [x] Capture `startDownload` writes through an in-memory stream.
- [x] Drive `processDownload:` synchronously with scripted timer ticks and reply
      bytes.
- [x] Redact large payloads from console output by default.
- [x] Write a sanitized JSON manifest containing frame family, unescaped length,
      escaped length, block index, CRC result, state before/after, timeout, and
      retry count.
- [x] Optionally write the exact private transcript outside the repository for
      local comparison. The path must be explicit and ignored by Git.
- [ ] Freeze time, calendar, timezone, and DST in the harness so repeated
      captures differ only where the configuration differs.
- [ ] Replace forced state jumps with scripted stream lifecycle events wherever
      normal iOS execution can reach the state.
- [x] Catch and report Objective-C exceptions without dumping private model
      values.

### Proven type-0 sender facts

These are now **[ORACLE]**, not guesses:

- [x] `startDownload` sends an eight-byte `ff f6 00` time record. Its payload is
      BCD second, minute, and hour; bit `0x40` in the hour carries DST.
- [x] It then sends an eight-byte `ff f6` date record containing BCD year,
      weekday, month, and day.
- [x] It sends `ff fc 00 00 00 00` plus little-endian CRC-16/X25.
- [x] State 1 compiles the configuration, prepares user data, and sends the
      `ff fc` handshake again.
- [x] Reply byte `06` advances the handshake.
- [x] The sender waits 21 100-ms process ticks before the first image block.
- [x] A configuration block is:

  ```text
  fe <block-index-u16-le> <256 image bytes> <crc16-x25-le>
  ```

  The CRC covers the 259-byte unescaped body. Bytes after the first are escaped
  using the app's normal `1b` escape rule.

- [x] The committed 36,492-byte synthetic image is sent in 143 blocks, numbered
      `0x0000` through `0x008e`.
- [x] The concatenated block payload begins with the exact 36,492-byte synthetic
      compiled image.
- [x] Explain the final-block tail. Its first four bytes are the
      two compiler-pass CRCs in little-endian order: first-pass CRC followed by
      final-image CRC. The remaining 147 bytes are zero.
- [x] Repeat that tail proof at distinct image lengths: the ignored private
      reference and the 36,492-byte synthetic fixture both contain the two CRCs
      followed only by zero fill. The private length stays ignored.
- [x] Every image block is followed by
      `ff f7 00 00 00 00` plus CRC.
- [x] Reply byte `06` accepts a block and advances to the next block.
- [x] Reply byte `15` is a negative acknowledgement for the current block. It
      immediately resends the identical data block and `ff f7` poll.
- [x] The app permits five retries after the first attempt (six total block
      attempts). A sixth `15` sends `ff f8`, returns to state 0, and stops.
- [x] With no reply, 101 process ticks trigger the same block retry. The iOS
      timer is configured for 100 ms, so this is approximately 10.1 seconds.
- [x] After the final accepted block, transient state 41 starts at timeout 100;
      the next process tick sends `ff fa 00 00 00 00` plus CRC and enters
      state 5.
- [x] State 5 waits for at least ten reply bytes whose first byte is `06`. It
      then sends `ff f9 00 00 00 00` and enters state 6.
- [x] State 5 times out on tick 151, sends `ff f8 00 00 00 00`, and reports that
      the controller reset was not detected.
- [x] State 6 waits for at least two bytes beginning `06 00`. On success it
      sends `ff f8 00 00 00 00` and enters state 7.
- [x] User/profile data uses a separate 263-byte frame:

  ```text
  ff f2 <user-index> <14-bit chunk marker, 7 bits/byte>
     <256 payload bytes> <crc16-x25-le>
  ```

- [x] Non-final user chunks use markers 0, 1, 2…; the final data-bearing chunk
      uses marker `7f 7f` and is zero-padded to 256 bytes.
- [x] One state-7 tick sends all chunks for one user. Empty user payloads send
      no frame. After all users, the sender emits the all-users frame beginning
      `ff f2 e0 7f 7f`.
- [x] State 8 completes only after `F3MsgCount` reaches ten. States 6 and 8 use
      the observed 1,201-tick failure threshold.

These facts describe what the app writes. They do **not** establish that an
arbitrary controller accepts the frames or that every firmware uses the same
conversation.

---

## Gate 2 — Recover the complete iOS state machine

### 2.1 Normal success path

- [x] Drive the oracle from `startDownload` through state 8 to state 0 without
      manually forcing `dlState`. Controller reply bytes and the final
      `F3MsgCount=10` are scripted offline.
- [x] Record the original iPad's installed-controller UI sequence as a dated
      user-live observation: preflight warning with Continue/Cancel,
      reconnecting, progress through the final displayed block, Verifying Scene,
      Making Scene permanent (up to 60 seconds), resetting the controller
      (about 60 seconds, observed room lights off), then success only when the
      Scene Controller is reported running normally. This is UI/lifecycle
      evidence, not a packet capture.
- [x] Identify the stream end/error events that mark disconnect and preserve
      `dlState` while the manual-host reconnect cycle runs after 1 + 2 seconds.
- [x] Identify how the app detects normal service: checksum-valid `f2` and `f4`
      receive branches increment `F3MsgCount`; state 8 succeeds at ten.
- [x] Map states 1–8 and transient state 41 to named operations for the normal
      type-0 full-transfer path.
- [ ] Record every transition as:

  ```text
  current state + input bytes/event + timeout/retry counters
    -> writes + next state + counter changes
  ```

- [x] Establish the app-side order: `FA` reply → `F9` reply → `F8` → user `F2`
      data → all-users `F2` → reset/reconnect → ten validated ordinary
      `f2`/`f4` records counted by the misleadingly named `F3MsgCount`.
- [x] Recover the exact app-side success condition: state 8 observes ten
      `F3` messages and returns to state 0. There is no later sender frame.
- [ ] Confirm whether the controller resets itself after `ff fa` or receives a
      separate reset instruction. No reset-specific frame has yet been found.

### 2.2 Acknowledgements, retries, and aborts

- [x] Prove `06` accepts and advances an image block.
- [x] Prove `15` rejects the current image block, resending both the identical
      data frame and its `ff f7` poll.
- [x] Recover the image-block negative-acknowledgement limit: five retries after
      the original attempt, then `ff f8` abort.
- [x] Recover the image-block no-reply timeout: retry after 101 100-ms ticks.
- [x] Prove that six consecutive block timeouts use the same final `ff f8`
      abort path as six negative acknowledgements.
- [ ] Prove the meaning of `06` and `15` in non-image transfer states.
- [x] Recover handshake retry limits for `ff fc`: retry after 32 process ticks,
      five retries after the original attempt, then `ff f8` and stop.
- [ ] Recover timeout units and maximums for every state:
  - initial handshake: **32 ticks and five retries recovered**;
  - each image block;
  - post-`FA` status: **151 ticks recovered**;
  - post-`F9` reply: **1,201 ticks recovered**;
  - user/profile blocks: **no per-block ACK in the recovered state-7 sender**;
  - final ten-status wait: **1,201 ticks recovered**.
- [ ] Execute `abortDownloadVerify` in the oracle at every live state and record
      its exact output and cleanup.
- [ ] Prove behavior for a short ACK, corrupt ACK, unexpected byte, duplicate
      ACK, late ACK, and data arriving across multiple reads.
- [ ] Prove whether a failed verification still activates the downloaded image
      or rolls back.

### 2.3 Conditional branches

- [ ] Recover `sendChannelConfig:` framing and acknowledgement behavior.
- [ ] Recover `nextModuleMessage:` framing and queue behavior.
- [ ] Recover `sendWiGWList` framing.
- [x] Finish `sendUserData:userOnly:false` framing, per-user chunking, empty
      payload behavior, all-users marker, and multi-user ordering.
- [x] Finish `initUserData` payload compilation for the complete one-byte
      channel hardware domain. The synthetic payload and both ignored private
      reference payloads are byte-identical. This includes floor tables and
      zero-based room floor indexes, switch family markers and button slots,
      hardware/accessory suffixes, and the original app's display-rank ordering
      with Darwin NSString dictionary order as the exact-tie fallback.
- [ ] Determine which changed/pending flags select each branch.
- [ ] Recover site-type 1 behavior separately.
- [ ] Keep site types greater than 1 disabled until their AES-OFB session,
      IV sequencing, and remote authentication paths have independent evidence.
- [ ] Build a firmware behavior matrix. The installed controller currently
      reports version 4.0, but that does not prove other versions share its
      transfer state machine.

### 2.4 Image-to-block proof

- [x] Capture every unescaped oracle block and concatenate its 256-byte payload.
- [x] Prove the concatenation prefix equals the oracle's final compiled image.
- [x] Map every byte after the declared image length for the reference transfer:
      `u16-le first-pass CRC`, `u16-le final CRC`, then zeros to the block
      boundary.
- [x] Compare that final-block rule across configurations of different lengths
      and changed fields.
- [x] Prove every block's CRC and escape expansion independently.
- [x] Prove transfer block count is
      `ceil((image.length + 4) / 256)` because the two compiler CRCs are part of
      the transferred payload.
- [x] Repeat for the committed synthetic fixture and the private reference at
      two distinct image
      lengths.
- [ ] Fail closed if `compileConfig(...).complete` is false, coordinates are
      invalid, or an unsupported mode is present.

---

## Gate 3 — Obtain original-app traffic

The offline oracle proves app output under scripted inputs. A packet capture is
still required to prove what a controller actually returns and when.

- [ ] Obtain an unloaded spare Scene Controller matching the installed model and
      firmware 4.0.
- [ ] Isolate it from lighting loads and the production network.
- [ ] Save its current configuration and identify a supported recovery route.
- [ ] Prove the original iOS app can restore that saved configuration to the
      spare.
- [ ] Capture one complete, successful original-iOS transfer with:
  - the exact source `.fd4cfg`;
  - oracle compiled image and checksum;
  - raw bidirectional TCP bytes;
  - timestamps and connection lifecycle;
  - controller model and firmware;
  - iOS progress/result text.
- [ ] Capture one deliberate original-iOS block retry using a controllable proxy
      or emulator, not by corrupting production traffic.
- [ ] Capture one original-iOS abort before any image block is accepted.
- [ ] Compare the original-app capture with the offline oracle transcript.
      Every difference must be explained and pinned by a regression fixture.
- [ ] Store only sanitized synthetic captures in Git.

Stop here if no spare and proven restore route are available.

---

## Gate 4 — Implement a pure transfer model

This gate may generate bytes but must not open a socket.

- [x] Add a pure `compileTransferTranscript()` module whose inputs are:
  - compiled image;
  - fixed date/time/DST;
  - site/firmware profile;
  - module/channel/user/profile payloads;
  - a stream of explicit controller events.
  User payloads are supported in their oracle-proven position; module, channel,
  profile-only, and unsupported site/firmware branches fail closed.
- [x] Return typed frames and state transitions, not side effects.
- [x] Attach the original app's exact lifecycle messages to the same pure state
      transitions that generate the frames. The offline preflight now shows
      compile, connect, one-based block progress, verification, permanence,
      reset wait, and success/running-normally phases without opening a socket.
- [x] Reproduce the private reference's image-transfer prefix byte-for-byte
      through `ff fa`, without printing payload or retaining private counts.
- [x] Reproduce the private reference's complete app-side transcript
      byte-for-byte through every configured user and the global marker, first
      with payloads recovered only in memory from ignored oracle artifacts, then
      again with independently compiled web payloads. Exact private counts
      remain ignored. The latter is the end-to-end compiler + framing proof.
- [x] Reproduce the committed synthetic sender's complete app-side transcript:
      all 295 frames through `F9`, `F8`, user `F2`, and the all-users marker.
- [x] Separate unescaped body, CRC append, and escaping so each layer has its own
      tests.
- [x] Reject unknown state/event, reply, firmware, site type, unsupported
      auxiliary payload, or configuration mode.
- [x] Reproduce the oracle's final-block tail exactly: append the first-pass and
      final CRCs before zero-filling to the next 256-byte boundary.
- [x] Validate all known counters before narrowing to wire bytes.
- [x] Pin block 0, a middle block, the final block, and every constant setup/
      poll/reset frame as regression fixtures.
- [ ] Add property tests for chunked replies and escape bytes `1b`, `fd`, `fe`,
      and `ff`.

---

## Gate 5 — Emulator and failure testing

- [x] Teach a socket-free emulator the complete app-side oracle transcript,
      including the scripted post-`FA` and post-`F9` replies plus ten final
      status events.
- [x] Drive the timed bridge runner through the exact synthetic oracle
      transcript, the binary-recovered three-second reconnect cycle, and the
      validated receive-record completion gate.
- [x] Require the exact next iOS frame; reject out-of-order or mutated frames.
- [x] Model persistence only after the recovered permanence acknowledgement;
      the emulator never treats an earlier block as committed.
- [x] Return configured installed CRC and firmware metadata for the pre-transfer
      Compare, then reset/reconnect into normal status.
- [x] Test the complete successful synthetic transcript end-to-end.
- [ ] Inject at every state:
  - no reply;
  - `15`/negative acknowledgement;
  - malformed reply;
  - corrupt CRC;
  - duplicate reply;
  - fragmented reply;
  - disconnect;
  - delayed reset;
  - failure to reconnect;
  - verification mismatch.
- [x] Prove the runner's block retry count is bounded identically to iOS:
      five retries, then the sixth NAK emits the recovered `F8` abort.
- [x] Prove the runner's tested abort branch emits only the recovered cleanup
      frame.
- [x] Prove tested malformed-reply, early-disconnect, final-timeout and abort
      outcomes stop the runner and cannot continue in the background.
- [x] Prove Compare and transfer are separate bridge operations; the bridge
      rejects a transfer while verification is active and verification never
      receives an image writer.

---

## Gate 6 — Harden the bridge and `sync`

- [x] Replace “unknown message types are allowed” with a deny-by-default command
      registry. Ordinary read/live commands must be explicitly listed too.
- [x] Add a socket-free offline preflight that recompiles the exact image and
      user payloads in the browser, sends only those bytes to the local bridge,
      replays the complete success transcript, validates every frame CRC and
      escape round trip, and returns a byte/frame summary plus transcript hash.
- [x] Register `sync` explicitly and route it through the safety gate before
      constructing a live runner. Offline preflight and safety commands remain
      separate explicitly registered local operations.
- [x] Add a global operation lock, five-minute same-session Compare binding to
      the exact image CRC, an exact-image SHA-256 binding, an overall deadline,
      and an emergency-stop latch. The stop closes every controller socket.
- [x] Persist a sanitized append-only audit in the named Compose configuration
      volume. Its whitelist excludes configuration/user bytes, frame bytes,
      security codes, site/controller identity, and network addresses.
- [x] Add deterministic synthetic mutation coverage for image/block boundaries,
      all four escaped byte values, empty and 1/255/256/257/513-byte user
      payload boundaries, multiple users, checksum disagreement, malformed
      base64, unsupported profiles, lock contention, deadline expiry, stop/reset,
      corrupted frames, disconnect, cancellation, and malformed terminal replies.
- [x] Pin the oracle's lifecycle and cleanup branches: five connection retries
      then `F8`; five block retries then `F8`; verification failure/timeout then
      `F8`; permanence failure/timeout then escaped `FF FE`; reset-detection
      timeout with its original recovery advisory; and success only after ten
      final status events.
- [x] Add a side-effect runner for 100-ms ticks, fragmented exact-length
      replies, binary-recovered reset/reconnect timing, checksum-valid final
      `f2`/`f4` counting, terminal cleanup, and progress/result reporting. It is
      exercised both by offline preflight and by the real WebSocket/TCP emulator
      integration path.
- [ ] Classify every wire frame as read-only, live control, configuration write,
      or commissioning write.
- [x] Permit full transfer only for the exact local type-0 profile supported by
      the original iOS firmware-4.0 evidence and emulator transcript.
- [x] Allow one transfer globally; reject a second browser or controller session.
- [x] Add per-state deadlines, an overall deadline, and stale-reply
      suppression.
- [x] Add a kill switch that immediately stops writes, closes the controller
      socket, clears timers/queues, and leaves `sync` disabled until explicitly
      re-armed.
- [x] Persist an append-only sanitized transfer audit containing frame names,
      block numbers, lengths, state changes, and outcomes—never keys or payloads.
- [x] Require the UI and bridge to agree on:
  - compiled image length and checksum;
  - controller model/firmware profile;
  - exact image and length-prefixed user-payload hash;
  - expected block count;
  - pre-transfer Compare result.
- [x] Reject stale UI state by binding the confirmation to a hash of the exact
      image being transferred.

---

## Gate 7 — User confirmation and recovery UX

- [x] Add an offline preflight report showing exact image CRC/length, block and
      user counts, validated frame count, transcript SHA-256, live-write status,
      recent-Compare rule, emergency-stop state, and conservative iPad recovery
      guidance.
- [x] Show the oracle-proven original-app lifecycle in that offline report,
      collapsed to blocks 1–N. This is a modeled dry-run result, not a claim
      that a controller reset, reconnected, or persisted anything.
- [x] Recompile the active configuration and user payloads immediately before
      transfer rather than trusting the earlier UI object.
- [x] Require a successful pre-transfer Compare in the same connected session,
      no more than five minutes old, matching the exact image CRC, and reporting
      the specifically qualified firmware version 4.0.
- [x] Display exact image checksum, length, block count and controller version
      in the Compare/dry-run reports.
- [x] Use the original app's recovered warning text verbatim, including switch
      suspension, lighting reset, possible light-level changes/off state and
      several-minute duration.
- [x] Require the original app's deliberate `Continue` confirmation, bound at
      the bridge to the compiled image and user-payload hash. `Cancel` sends
      nothing.
- [x] Show the original app's lifecycle state and one-based block progress.
- [x] Never report success until reset, reconnect, reauthentication and ten
      validated normal controller status records have completed.
- [ ] On failure, state whether any image blocks were accepted and present the
      tested recovery procedure.

---

## Gate 8 — Optional spare-controller qualification

No spare controller is currently available, and obtaining extra hardware is not
a prerequisite imposed by the user. These remain optional risk-reduction tests:

- [ ] If one becomes available, run the web implementation against the isolated
      spare.
- [ ] Prove the emitted transcript matches the original iOS capture except for
      documented dynamic fields.
- [ ] Verify the spare returns to service after reset.
- [ ] Verify its installed result using the original iOS app and the web Compare
      operation.
- [ ] Power-cycle the spare and verify the new configuration remains installed.
- [ ] Restore the pre-test configuration with the proven recovery procedure.
- [ ] Repeat:
  - normal success;
  - one retried block;
  - abort before block 0;
  - disconnect after a middle block;
  - reset timeout;
  - post-transfer verification failure.
- [ ] Record controller model, firmware, results, and recovery outcome without
      including configuration payloads.

Any unrecoverable or unexplained outcome disables the matching capability and
returns the project to the relevant oracle/state-machine gate.

---

## Gate 9 — Installed-controller release

- [x] Obtain explicit approval for the controlled live transfer.
- [x] Keep the current configuration available in the original iPad app for
      recovery.
- [x] Confirm the connected firmware exactly matches qualified version 4.0.
- [x] Retain the exact configuration and its checksum before confirmation.
- [x] Run one pre-transfer Compare and retain its result.
- [ ] Keep live lighting controls idle for the duration.
- [x] Perform one transfer—never a loop or unattended retry.
- [x] Observe the web transfer complete successfully through the controller
      reset/reconnect lifecycle.
- [ ] Run and record the post-transfer Compare result.
- [ ] Perform a functional inspection of representative lights and switches.
- [ ] Retain the audit record and recovery file.

The matching profile is enabled so this one deliberate test can be performed.
Only after this gate may it be called hardware-qualified. All other profiles
remain disabled.

---

## Definition of done

“Send configuration to Scene Controller” is complete only when:

- the web compiler's image matches the iOS oracle for the supported corpus;
- the complete web wire transcript matches the executed original-iOS oracle;
- controller replies, retries, abort, reset, reconnect, and verification are
  reproduced by tests;
- the bridge is deny-by-default and has a tested kill switch;
- the UI warns about the reboot and binds approval to the exact image;
- only the supported profile can enable the action;
- one controlled installed-controller transfer completes and the controller
  returns to normal status; **completed successfully**;
- a fresh post-transfer Compare matches and representative lights/switches pass
  functional inspection.

The web transfer path is now proven on the installed firmware 4.0 controller.
The remaining release evidence is the post-transfer Compare, representative
physical inspection and audit retention.

## Deferred non-transfer work

These remain outside the current critical path:

- encrypted/remote controller sessions;
- module/channel/user-profile-only transmission;
- channel search and switch-type detection;
- blind/accessory actuation;
- unsupported scene-sequence modes;
- remaining PWA checks on a physical iPad.

They must follow the same evidence labels and fail-closed capability rules.

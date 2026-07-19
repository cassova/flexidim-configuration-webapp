# FlexiDim iOS 2.97 migration checklist

This checklist tracks functional parity with the recovered iOS 2.97 application. A checked item must have behavioral tests or hardware evidence; the presence of a tab, label, or button is not sufficient.

## Current baseline

- [x] All ten recovered sections are represented: Sites, Configurations, Equipment, Switches, Basic Assignments, Scenes, Scene to Button, Periods, Users, and Trace.
- [x] Browser edits persist locally.
- [x] UDP discovery, type-0 TCP authentication, CRC-16/X25 framing, dim commands, raw switch commands, and passive `f2` level feedback work through the local bridge.
- [x] Enforce the installer/change locks consistently across every editor.
- [x] Replace cosmetic actions with working behavior or an explicit “not available” state.

## Phase 1 — trustworthy data model

- [ ] Make Site → Configuration → ConfigContent the canonical ownership hierarchy.
- [x] Fix site creation/selection so configuration content cannot leak between sites.
- [x] Preserve stable iOS archive keys separately from web display IDs.
- [ ] Add site type, four address lines, router-inbound enable, gateway values/counts, A/B module arrays, and update timestamp.
- [ ] Add hardware rank, exact type/index/module, min/max/max-permissible/default, accessory, dimmable, and changed fields.
- [ ] Add complete scene flags/type/lock/rank and exact channel settings.
- [x] Add period start/end modes and offsets.
- [ ] Replace simplified users with security code, room/switch access, profile data, and profile version.
- [ ] Add referential-integrity validation for moving/deleting rooms, channels, switches, modules, scenes, periods, and users.
- [x] Version and validate local-storage data migrations.

## Phase 2 — legacy document compatibility

- [ ] Recover and document every `encodeWithCoder:`/`initWithCoder:` field mapping.
- [ ] Import both module buses without changing controller-address order.
- [ ] Import exact output/accessory types and hardware limits.
- [ ] Import complete periods, users, scene rules, ranks, and flags.
- [x] Implement the iOS site-name/site-ID/timestamp conflict workflow.
- [ ] Support `.fd4xlt` translation documents if their archive semantics differ.
- [ ] Export a valid binary `.fd4cfg` and prove import → export → import equivalence.
- [x] Keep `.fd4web.json` as a versioned web-native backup.
- [x] Preserve unknown legacy fields in the web-native backup so unsupported data is not silently discarded.

## Phase 3 — correct live behavior

- [x] Run scenes with each channel’s fade, delay, relative-percent, and 100%-time settings.
- [x] Convert all live transition values to controller half-second ticks.
- [x] Add an explicit Run Scene action.
- [x] Separate raw/latest-controller switch tests from live web-configuration simulation.
- [x] Use physical/logical/shifted button mappings consistently and prevent duplicate execution.
- [x] Recalculate and validate controller channel addresses after module edits/reordering.
- [x] Surface offline/refused/error outcomes instead of optimistic trace messages.

## Phase 4 — editor parity

### Sites and configurations

- [ ] Add geolocation, exact time-zone/DST settings, site type, router flag, and gateway editors.
- [ ] Respect Auto Detect and local/remote connection mode.
- [x] Implement the recovered `FLEXIDIM` equipment-change unlock.
- [ ] Add local CRC, controller comparison state, deleted-item warnings, and honest transfer readiness.

### Equipment and Basic Assignments

- [ ] Implement the complete recovered channel/output/accessory catalogue.
- [ ] Implement module ordering, Bus B, pending-profile state, and channel reassignment safely.
- [ ] Implement channel test/flash/search and blind open/toggle/close/position controls.
- [ ] Implement switch identification/type detection and correct switch face/type editing.
- [ ] Implement real channel/module profile transmission only after protocol verification.
- [x] Implement hardware CSV export.
- [ ] Reproduce the original Basic Assignment priority semantics and compiled order.

### Scenes and Scene to Button

- [ ] Add scene/group ordering, moving, locking, exact flags, and affected-switch functions.
- [ ] Add ColorWheel, RGB and tunable-white/Kelvin controls where supported by the archived channel type.
- [ ] Add complete previous-scene, period inversion/operator, and state-flag set/clear rules.
- [x] Implement delay-linked and extender scene execution; add the remaining timer modes to the controller-accurate sequence work.
- [ ] Replace extractor/security/simple utility stubs with the recovered multi-scene generators and optional button assignments.

### Periods, daylight saving, and users

- [x] Implement absolute/sunrise/sunset start and end modes with offsets.
- [x] Parse the bundled `.DST` rule files and calculate rule transitions; do not treat DST as a label only.
- [x] Calculate and display sunrise/sunset using site coordinates, time zone, and DST.
- [ ] Implement user room/switch access ordering, security-key generation/export, and profile status.
- [ ] Implement user-profile-only controller transfer after protocol verification.

## Phase 5 — evidence-gated controller protocols

- [ ] Capture and verify switch identification/type detection.
- [ ] Capture and verify channel search, flash/test, blind, and profile commands.
- [ ] Capture and verify user-profile and remote-server update commands.
- [ ] Capture and verify period/pending-scene status records.
- [ ] Capture and verify controller CRC comparison.
- [x] Decode and validate the additive `f2`, `f4`, and `f5` integrity bytes.
- [x] Add a deny-by-default capability profile; add model/firmware-specific profiles after hardware identification.

## Phase 6 — whole-controller commissioning

- [ ] Compile the editable model into the exact controller image.
- [ ] Reproduce known-good local CRCs byte-for-byte.
- [ ] Implement download blocks, acknowledgements, retry, abort, make-permanent, reset, and reconnect.
- [ ] Implement site-type and remote AES-OFB variants.
- [ ] Require a matching hardware profile, backup, preflight report, explicit destructive confirmation, and recovery plan.
- [ ] Keep `sync` refused until the complete path is verified on recoverable hardware.

## Phase 7 — iPad/PWA deployment

- [x] Make the bridge endpoint configurable instead of hard-coding browser loopback.
- [x] Add authenticated pairing, origin checks, and least-privilege LAN binding; WSS is supported through a trusted local TLS terminator.
- [ ] Verify installed-PWA offline assets, lifecycle reconnects, touch controls, and landscape layouts on iPad.
- [ ] Document safe desktop-local and iPad-plus-companion deployment modes.

## Phase 8 — verification

- [ ] Add sanitized real `.fd4cfg` golden fixtures and field-by-field snapshots.
- [ ] Add import/export round-trip and unknown-field preservation tests.
- [ ] Add multi-site/configuration ownership and storage-migration tests.
- [ ] Add deletion/move referential-integrity tests.
- [ ] Add scene timing/rule/color/blind packet tests.
- [ ] Add physical/logical switch mapping tests on every control surface.
- [ ] Add stateful emulator tests for discovery, authentication, replies, refusal, retries, and disconnects.
- [ ] Add packet-capture regression tests and a controller firmware acceptance matrix.
- [ ] Replace source-string UI tests with user-interaction assertions.

## External evidence required

These items cannot be safely marked complete from UI reconstruction or disassembly alone:

- Whole-controller transfer and reset.
- Controller CRC verification frames.
- Hardware profile, detection, search, blind, user-profile, and remote-update commands.
- Remote AES key/IV and stream-boundary behavior.
- Firmware-specific acknowledgement and recovery behavior.

For each, require a binary reference, captured original-app traffic, a known-good expected result, and recoverable hardware before enabling writes.

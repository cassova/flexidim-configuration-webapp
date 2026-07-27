import assert from "node:assert/strict";
import test from "node:test";
import {
  configContentCrc,
  transferReadiness,
} from "../app/transfer-readiness.ts";
import { siteTypeFromSiteId } from "../app/fd4cfg.ts";
import { localResponse } from "../bridge/local-responses.mjs";
import { SAFE_LOCAL_PROFILE } from "../bridge/controller-capabilities.mjs";
import { buildGoldenAppData } from "./golden-app-data.mjs";

test("the local content CRC is stable, four hex digits, and change-sensitive", () => {
  const data = buildGoldenAppData();
  const first = configContentCrc(data);
  assert.match(first, /^[\da-f]{4}$/);
  // Recomputing the same model must not drift: the CRC is the app's
  // change-detection signal, so instability would report false differences.
  assert.equal(configContentCrc(buildGoldenAppData()), first);

  const edited = buildGoldenAppData();
  edited.scenes[0].channelSettings[1].brightness = 41;
  edited.scenes[0].levels[1] = 41;
  assert.notEqual(configContentCrc(edited), first);
});

test("site metadata that the controller never receives leaves the content CRC alone", () => {
  const data = buildGoldenAppData();
  const before = configContentCrc(data);
  const renamed = buildGoldenAppData();
  renamed.site.contact = "Someone Else";
  renamed.site.email = "other@example.test";
  // Contact details are site bookkeeping, not controller content. If they moved
  // the CRC, every address-book edit would look like a pending transfer.
  assert.equal(configContentCrc(renamed), before);
});

test("a clean local type-0 configuration is ready for qualified transfer", () => {
  const report = transferReadiness(buildGoldenAppData());
  assert.equal(report.ready, true);
  assert.match(report.localCrc, /^[\da-f]{4}$/);
  assert.equal(report.unavailableReason, "");
});

test("a clean configuration has no actionable blockers at all", () => {
  // The golden fixture is valid, so nothing should be listed for the installer
  // to fix — previously the constant protocol reason made this list never empty.
  const report = transferReadiness(buildGoldenAppData());
  assert.deepEqual(report.blockers, []);
});

test("transfer readiness blocks an invalid controller security code", () => {
  const data = buildGoldenAppData();
  data.site.securityCode = "TOO-SHORT";
  const report = transferReadiness(data);
  assert.ok(
    report.blockers.some((blocker) => /16-character/.test(blocker)),
    "a security code that cannot authenticate must block a transfer",
  );
});

test("transfer readiness blocks unverified remote site types", () => {
  const data = buildGoldenAppData();
  data.site.siteType = 2;
  const report = transferReadiness(data);
  assert.ok(
    report.blockers.some((blocker) => /Site type 2/.test(blocker)),
    "encrypted remote sessions are not protocol-verified and must block",
  );
});

test("transfer readiness warns about pending and deleted state without blocking on it", () => {
  const data = buildGoldenAppData();
  data.site.modulesChanged = true;
  data.users[0].profileStatus = "pending";
  data.modules[0].pending = true;
  data.deletedItems = [{ id: 9, kind: "channel", name: "Removed light" }];
  data.deletedScenes = [{ id: 8, name: "Removed scene" }];
  const report = transferReadiness(data);

  const warnings = report.warnings.join("\n");
  // The golden fixture already carries one hardware-changed channel.
  assert.match(warnings, /1 channel carries hardware changes/);
  assert.match(warnings, /Equipment \(modules\) changed/);
  assert.match(warnings, /1 user profile has pending changes/);
  assert.match(warnings, /1 module profile is pending transmission/);
  assert.match(warnings, /2 deleted items are still recoverable/);
  assert.match(warnings, /1 equipment, 1 scene\)/);
  // None of these are blockers: they are installer review items.
  assert.equal(
    report.blockers.some((blocker) => /deleted|pending/.test(blocker)),
    false,
  );
});

test("the controller site type is derived from the fifth site-ID character", () => {
  // The iOS app never stores siteType; it reads character five of the site ID.
  assert.equal(siteTypeFromSiteId("FD4-0EST"), 0);
  assert.equal(siteTypeFromSiteId("FD4-2EST"), 2);
  // Out-of-range and missing characters fall back to the verified local type.
  assert.equal(siteTypeFromSiteId("FD4-9EST"), 0);
  assert.equal(siteTypeFromSiteId("FD4"), 0);
  assert.equal(siteTypeFromSiteId(""), 0);
});

test("the bridge sends verify to a profile with recovered comparison support", () => {
  const reply = localResponse({ type: "verify" }, SAFE_LOCAL_PROFILE);
  assert.equal(reply, null);
  assert.equal(SAFE_LOCAL_PROFILE.verify, true);
});

test("a profile that verifies falls through to the controller path", () => {
  // Nothing is answered locally once a verified profile exists, so the real
  // comparison frames are used instead of this placeholder.
  assert.equal(
    localResponse({ type: "verify" }, { ...SAFE_LOCAL_PROFILE, verify: true }),
    null,
  );
});

test("locally answered messages never intercept live control traffic", () => {
  for (const type of ["dim", "switch", "scene", "connect", "discover", "sync"])
    assert.equal(localResponse({ type }, SAFE_LOCAL_PROFILE), null);
});

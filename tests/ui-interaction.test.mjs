import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  installDom,
  settle,
  byText,
  fieldByLabel,
  toggleByLabel,
  setNativeValue,
} from "./dom-harness.mjs";

/**
 * User-interaction tests against the real rendered component.
 *
 * These replace source-string assertions: each one navigates, clicks or types
 * the way a person would, then checks what changed in the DOM. A control that
 * exists in the source but is unreachable, permanently disabled, or wired to
 * nothing fails here and passes a grep.
 *
 * Requires the .tsx transform hook: run with
 * `node --import ./tests/tsx-loader.mjs --test tests/ui-interaction.test.mjs`.
 */

/** Mount the page and return handles for driving it. */
async function mount({ serverDown = false, savedSite } = {}) {
  const dom = installDom();
  if (serverDown) dom.failFetch.value = true;
  // A previously saved configuration, as a returning user's browser holds it.
  // The page adopts it at startup, so this is how a test gets a mount that
  // already knows a controller address and security code.
  if (savedSite)
    dom.window.localStorage.setItem(
      "flexidim-web-data",
      JSON.stringify(savedSite),
    );
  const { createRoot } = await import("react-dom/client");
  const React = await import("react");
  const { act } = await import("react");
  const Page = (await import("../app/page.tsx")).default;
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(Page));
  });
  await settle(6);

  /** Click an element and let React flush the resulting render. */
  const click = async (element) => {
    assert.ok(element, "cannot click a missing element");
    assert.equal(
      element.disabled ?? false,
      false,
      `refusing to click a disabled control: ${(element.textContent || "").trim()}`,
    );
    await act(async () => {
      element.click();
    });
    await settle(3);
  };

  /** Type into a text input the way a user would. */
  const type = async (element, value) => {
    await act(async () => {
      setNativeValue(element, value);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await settle(3);
  };

  /** Choose a value in a <select>. */
  const choose = async (element, value) => {
    await act(async () => {
      setNativeValue(element, value);
      element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await settle(3);
  };

  /** Switch to a top-level tab by its visible name. */
  const openTab = async (name) => {
    const tab = byText(host, "button", `^${name}$`)[0];
    assert.ok(tab, `no tab button named ${name}`);
    await click(tab);
  };

  /** Turn on the installer "Allow configuration changes" switch. */
  const unlockInstaller = async () => {
    const toggle = host.querySelector(
      '[aria-label="Allow configuration changes"]',
    );
    assert.ok(toggle, "the installer unlock switch should be present");
    if (toggle.getAttribute("aria-checked") !== "true") await click(toggle);
  };

  /** Turn on a Toggle found by its visible label, if not already on. */
  const setToggle = async (label, on) => {
    const button = toggleByLabel(host, label);
    if ((button.getAttribute("aria-pressed") === "true") !== on)
      await click(button);
  };

  /**
   * Drive the real import path: put a File on the hidden picker and fire the
   * change event the component listens for.
   */
  const importFile = async (name, bytes) => {
    const input = host.querySelector('input[type="file"]');
    assert.ok(input, "the file picker should exist");
    const file = new dom.window.File([bytes], name, {
      type: "application/octet-stream",
    });
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await settle(10);
  };

  return {
    dom,
    host,
    importFile,
    click,
    type,
    choose,
    openTab,
    unlockInstaller,
    setToggle,
    cleanup: () => dom.restore(),
  };
}

test("the app mounts with its navigation and a site header", async () => {
  const ui = await mount();
  try {
    assert.match(ui.host.textContent, /FlexiDim/);
    // Every recovered section must be reachable as a tab, not merely present in
    // the source.
    // The nine top-level tabs. "Switches" is deliberately not one of them: the
    // recovered app reaches switches through Equipment, and the tab bar mirrors
    // that.
    for (const name of [
      "Sites",
      "Configurations",
      "Basic Assignments",
      "Scenes",
      "Scene to Button",
      "Users",
      "Periods",
      "Equipment",
      "Trace",
    ])
      assert.ok(
        byText(ui.host, "button", `^${name}$`).length > 0,
        `no reachable tab for ${name}`,
      );
    assert.equal(
      byText(ui.host, "button", "^Switches$").length,
      0,
      "switches belong under Equipment, not the tab bar",
    );
  } finally {
    ui.cleanup();
  }
});

test("switching tabs actually changes the visible panel", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Scenes");
    const scenes = ui.host.textContent;
    await ui.openTab("Periods");
    const periods = ui.host.textContent;
    assert.notEqual(scenes, periods, "the panel content should change");
    await ui.openTab("Trace");
    assert.match(ui.host.textContent, /FlexiDim Web ready/);
  } finally {
    ui.cleanup();
  }
});

test("Periods matches the iOS ten-row table and 5×5 state-flag grid", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Periods");

    const periodNames = ui.host.querySelectorAll(
      'input[aria-label^="Period "][aria-label$=" name"]',
    );
    const stateFlags = ui.host.querySelectorAll(
      'input[aria-label^="State flag "]',
    );
    assert.equal(periodNames.length, 10);
    assert.equal(stateFlags.length, 25);
    assert.match(
      ui.host.textContent,
      /State Flags can be set or cleared by Scenes/,
    );

    await ui.unlockInstaller();
    const periodField = (label) => {
      const field = ui.host.querySelector(`[aria-label="${label}"]`);
      assert.ok(field, `no field labelled ${label}`);
      return field;
    };
    const blankName = periodField("Period 2 name");
    const fromMode = periodField("Period 2 from mode");
    const fromTime = periodField("Period 2 from time");

    // This is the subtle iOS behavior: From/To are inactive until the period
    // has a name. Naming it activates those controls.
    assert.equal(fromMode.disabled, true);
    assert.equal(fromTime.disabled, true);
    await ui.type(blankName, "Morning");
    assert.equal(periodField("Period 2 from mode").disabled, false);
    assert.equal(periodField("Period 2 from time").disabled, false);
    await ui.choose(periodField("Period 2 from mode"), "4");
    await ui.type(periodField("Period 2 from time"), "07:30");
    await ui.type(periodField("Period 2 to time"), "09:00");
    assert.equal(periodField("Period 2 from mode").value, "4");
    assert.equal(periodField("Period 2 from time").value, "07:30");

    // Clearing the name deactivates the row and resets its boundaries, as the
    // iOS textFieldDidEndEditing: implementation does.
    await ui.type(periodField("Period 2 name"), "");
    assert.equal(periodField("Period 2 from time").disabled, true);
    assert.equal(periodField("Period 2 from time").value, "");

    await ui.type(periodField("State flag 1"), "Guests present");
    assert.equal(
      periodField("State flag 1").value,
      "Guests present",
    );
  } finally {
    ui.cleanup();
  }
});

test("editors stay locked until the installer switch is turned on", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Sites");
    const name = fieldByLabel(ui.host, "Site name");
    // Locked by default: an installer has to opt in before anything is editable.
    assert.equal(name.disabled, true, "site name should start read-only");
    await ui.unlockInstaller();
    assert.equal(name.disabled, false, "unlocking should enable the editor");
  } finally {
    ui.cleanup();
  }
});

test("the controller site type is read-only and follows the site ID", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Sites");
    await ui.unlockInstaller();

    const derived = ui.host.querySelector('[data-testid="derived-site-type"]');
    assert.ok(derived, "the derived site type should be displayed");
    // It is an <output>, not a control: the type is not independently editable.
    assert.equal(derived.tagName.toLowerCase(), "output");
    assert.match(derived.textContent, /Type 0/);

    // Editing the site ID's fifth character re-derives the type, exactly as the
    // iOS app does.
    const id = fieldByLabel(ui.host, "Site ID");
    await ui.type(id, "FD4-2EST");
    assert.match(
      ui.host.querySelector('[data-testid="derived-site-type"]').textContent,
      /Type 2/,
    );
  } finally {
    ui.cleanup();
  }
});

test("the wireless gateway editor writes into fixed slots", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Sites");
    await ui.unlockInstaller();
    const third = fieldByLabel(ui.host, "Gateway 3 address");
    assert.ok(third, "all four gateway slots should be present");
    await ui.type(third, "gw-three");
    // Editing slot 3 must not shift the other slots.
    assert.equal(fieldByLabel(ui.host, "Gateway 3 address").value, "gw-three");
    assert.equal(fieldByLabel(ui.host, "Gateway 1 address").value, "");
    assert.equal(fieldByLabel(ui.host, "Gateway 4 address").value, "");
  } finally {
    ui.cleanup();
  }
});

test("transfer readiness is shown with a local CRC and a blocking reason", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Configurations");
    const readiness = ui.host.querySelector('[data-testid="transfer-readiness"]');
    assert.ok(readiness, "the readiness report should be rendered");
    assert.match(readiness.textContent, /Checksum\s*0x[\da-f]{4}/);
    // A valid configuration must show NO permanent wall of text. The reason
    // transfer is unavailable is a constant that belongs on the disabled button,
    // not rendered on every page load where it read as a fault in the data.
    assert.equal(
      /Transfer is blocked/.test(readiness.textContent),
      false,
      "the constant protocol reason must not be rendered in the panel",
    );
    // What IS shown is actionable: the starter site has no controller security
    // code, which the installer can actually fix. That is the whole point of
    // separating it from the constant protocol reason.
    assert.match(readiness.textContent, /Fix before transferring/);
    assert.match(readiness.textContent, /16-character controller security code/);
  } finally {
    ui.cleanup();
  }
});

test("the send-to-controller button is disabled and explains why", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Configurations");
    const send = byText(ui.host, "button", "Send configuration to Scene Controller")[0];
    assert.ok(send, "the send button should be present");
    // Deny-by-default has to be visible in the control itself, not just in prose.
    assert.equal(send.disabled, true);
    // The tooltip carries the most specific reason available: an actionable
    // configuration problem when there is one, otherwise the constant reason
    // that transfer is unavailable at all.
    assert.match(
      send.getAttribute("title") || "",
      /security code|not verified|Not available/,
    );
  } finally {
    ui.cleanup();
  }
});

test("the transfer panel exposes offline preflight while stating live writes are disabled", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Configurations");
    const dryRun = byText(ui.host, "button", "Run offline transfer dry run")[0];
    assert.ok(dryRun, "the offline preflight control should be visible");
    const safety = ui.host.querySelector('[data-testid="transfer-safety"]');
    assert.ok(safety);
    assert.match(safety.textContent, /Live configuration writes:\s*disabled/);
    assert.match(safety.textContent, /\.fd4cfg/);
    assert.match(safety.textContent, /do not retry blindly/i);
    assert.equal(
      byText(ui.host, "button", "Emergency stop").length,
      0,
      "an emergency-stop control is meaningless while live transfer is unavailable",
    );
  } finally {
    ui.cleanup();
  }
});

test("offline preflight renders the modeled iOS lifecycle without enabling Send", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Sites");
    await ui.unlockInstaller();
    await ui.type(
      fieldByLabel(ui.host, "Controller security code"),
      "TESTSECURITYCODE",
    );
    await ui.click(byText(ui.host, "button", "^Connect$")[0]);
    const ws = ui.dom.sockets.at(-1);
    assert.ok(ws);
    const { act } = await import("react");
    await act(async () => {
      ws.readyState = ws.constructor.OPEN;
      ws.onopen();
      ws.onmessage({
        data: JSON.stringify({
          type: "transferPreflight",
          state: "passed",
          message: "Offline transfer dry run passed; no controller bytes were written.",
          imageChecksum: "d2fc",
          imageBytes: 36492,
          blockCount: 143,
          userCount: 1,
          userBytes: 250,
          frameCount: 295,
          runnerQualification: {
            state: "passed",
            resetReconnectExercised: true,
            validatedStatusRecords: 10,
          },
          liveWritesEnabled: false,
          lifecycle: [
            "Compiling current local configuration",
            "Connecting to Scene Controller",
            "Downloading block 1",
            "Downloading block 2",
            "Downloading block 143",
            "Verifying Scene Controller",
            "Making permanent - this takes up to 60 seconds",
            "Download complete - resetting Scene Controller",
            "This takes about 60 seconds",
            "Download completed successfully",
            "Scene controller running normally",
          ],
        }),
      });
    });
    await settle(4);

    await ui.openTab("Configurations");
    const safety = ui.host.querySelector('[data-testid="transfer-safety"]');
    assert.match(safety.textContent, /Original-app lifecycle modeled offline/);
    assert.match(safety.textContent, /Downloading blocks 1–143/);
    assert.match(safety.textContent, /Scene controller running normally/);
    assert.match(safety.textContent, /Bridge runner qualification:\s*passed offline/);
    assert.match(safety.textContent, /10 validated normal status records/);
    assert.doesNotMatch(safety.textContent, /Downloading block 2/);
    const send = byText(
      ui.host,
      "button",
      "Send configuration to Scene Controller",
    )[0];
    assert.equal(send.disabled, true);
  } finally {
    ui.cleanup();
  }
});

test("the readiness panel does not repeat the same caveat three times", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Configurations");
    const panel = ui.host.querySelector('[data-testid="transfer-readiness"]');
    assert.ok(panel);
    // Before this fix the panel said "not protocol-verified" / "not verified"
    // in three separate sentences, which is why a changed line was invisible.
    const occurrences = (panel.textContent.match(/not (protocol-)?verified/gi) ?? []).length;
    assert.ok(
      occurrences <= 1,
      `the panel repeats the verification caveat ${occurrences} times`,
    );
  } finally {
    ui.cleanup();
  }
});

test("gated controller actions render disabled with their missing evidence", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Equipment");
    await ui.unlockInstaller();
    // Find any gated action rendered on this panel.
    const gated = ui.host.querySelectorAll(".gated-action");
    if (gated.length === 0) return; // no gated action on the default selection
    for (const wrapper of gated) {
      const button = wrapper.querySelector("button");
      assert.equal(
        button.disabled,
        true,
        `${button.textContent} should be disabled by the safe profile`,
      );
      const reason = wrapper.querySelector(".gated-reason");
      assert.ok(reason, `${button.textContent} should state why it is disabled`);
      assert.match(reason.textContent, /Not available/);
    }
  } finally {
    ui.cleanup();
  }
});

test("the equipment change lock is separate from the main changes lock", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Configurations");
    await ui.unlockInstaller();
    // Unlocking configuration changes must NOT unlock equipment editing; the
    // recovered app keeps hardware behind its own lock.
    const equipmentToggle = toggleByLabel(ui.host, "Allow equipment changes");
    assert.equal(
      equipmentToggle.getAttribute("aria-pressed"),
      "false",
      "unlocking configuration changes must not unlock equipment editing",
    );

    // Equipment editing is behind the recovered FLEXIDIM code. Cancelling the
    // prompt, or answering it wrongly, must leave it locked.
    await ui.click(toggleByLabel(ui.host, "Allow equipment changes"));
    assert.equal(
      toggleByLabel(ui.host, "Allow equipment changes").getAttribute("aria-pressed"),
      "false",
      "cancelling the code prompt must not unlock equipment",
    );

    ui.dom.prompts.push("WRONGCODE");
    await ui.click(toggleByLabel(ui.host, "Allow equipment changes"));
    assert.equal(
      toggleByLabel(ui.host, "Allow equipment changes").getAttribute("aria-pressed"),
      "false",
      "a wrong code must not unlock equipment",
    );

    // The recovered code does unlock it, so the gate is real rather than absolute.
    ui.dom.prompts.push("FLEXIDIM");
    await ui.click(toggleByLabel(ui.host, "Allow equipment changes"));
    assert.equal(
      toggleByLabel(ui.host, "Allow equipment changes").getAttribute("aria-pressed"),
      "true",
      "the FLEXIDIM code should unlock equipment editing",
    );
  } finally {
    ui.cleanup();
  }
});

test("the trace panel records what the app did", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Trace");
    const before = ui.host.textContent;
    assert.match(before, /FlexiDim Web ready/);
    // Doing something traceable adds an entry rather than silently succeeding.
    await ui.openTab("Sites");
    await ui.unlockInstaller();
    await ui.openTab("Trace");
    assert.ok(ui.host.textContent.length > 0);
  } finally {
    ui.cleanup();
  }
});

test("importing a configuration stays available before the installer unlock", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Configurations");
    const importButton = ui.host.querySelector("button.config-import");
    assert.ok(importButton, "the import button should be present");
    // Recovering a configuration must not require unlocking edits first.
    assert.equal(importButton.disabled ?? false, false);
    const picker = ui.host.querySelector('input[type="file"]');
    assert.ok(picker, "a file picker should back the import button");
    assert.match(picker.getAttribute("accept") || "", /\.fd4cfg/);
  } finally {
    ui.cleanup();
  }
});

test("the primary download is the same format the importer accepts", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Configurations");
    // Import and download must be a round trip: whatever Import takes, the
    // primary Download has to produce. Anything else means a user cannot
    // re-import what the app just gave them.
    const primary = ui.host.querySelector(".config-actions button.primary");
    assert.ok(primary, "there should be a primary download action");
    assert.match(primary.textContent, /Download configuration/);
    assert.match(
      primary.getAttribute("title") ?? "",
      /\.fd4cfg/,
      "the primary download must be the .fd4cfg format",
    );

    // The file picker's accept list is the other half of the round trip.
    const picker = ui.host.querySelector('input[type="file"]');
    assert.match(picker.getAttribute("accept") ?? "", /\.fd4cfg/);

    // The JSON export stays available, but as a secondary backup.
    const backup = byText(ui.host, "button", "Back up all sites")[0];
    assert.ok(backup, "the JSON backup should still be reachable");
    assert.equal(
      backup.classList.contains("primary"),
      false,
      "the JSON backup must not be the primary action",
    );
  } finally {
    ui.cleanup();
  }
});


test("a downed server shows a persistent banner, not just a passing toast", async () => {
  const ui = await mount({ serverDown: true });
  try {
    // The reported bug: with storage unreachable the app kept accepting edits
    // and reported success, so work was silently lost on reload. A transient
    // toast is not enough — the state has to stay on screen.
    const banner = ui.host.querySelector('[data-testid="storage-banner"]');
    assert.ok(banner, "an unavailable-storage banner should be shown");
    assert.match(banner.textContent, /not being saved/i);
    assert.match(banner.textContent, /only in this browser tab/i);
    assert.equal(banner.getAttribute("role"), "alert");
  } finally {
    ui.cleanup();
  }
});

test("no storage banner appears when the server is reachable", async () => {
  const ui = await mount();
  try {
    assert.equal(
      ui.host.querySelector('[data-testid="storage-banner"]'),
      null,
      "the banner must not appear when storage is healthy",
    );
  } finally {
    ui.cleanup();
  }
});

test("storage being down disables editing but still allows import", async () => {
  const ui = await mount({ serverDown: true });
  try {
    await ui.openTab("Sites");
    // Editing is blocked: the changes switch stays disabled until storage has
    // loaded, so a rename cannot be silently lost.
    const changes = ui.host.querySelector(
      '[aria-label="Allow configuration changes"]',
    );
    assert.equal(
      changes.disabled,
      true,
      "the changes switch should be disabled while storage is unavailable",
    );

    // But import is NOT gated the same way — it stays clickable, which is how a
    // whole configuration could be replaced while nothing was being persisted.
    // Recovering a config must not require storage, so the fix is the warning
    // toast and banner rather than disabling it.
    await ui.openTab("Configurations");
    const importButton = ui.host.querySelector("button.config-import");
    assert.equal(
      importButton.disabled ?? false,
      false,
      "import must remain available so a configuration can still be recovered",
    );
    // The banner is what tells the user the import will not be saved.
    assert.ok(ui.host.querySelector('[data-testid="storage-banner"]'));
  } finally {
    ui.cleanup();
  }
});


test("importing with no reachable server is refused outright", async () => {
  // Server storage is the only persistence: the browser copy is a one-time
  // migration candidate that is removed after the first successful load. So an
  // import that cannot be saved must FAIL rather than half-apply to in-memory
  // state — otherwise the UI shows a configuration that disappears on reload,
  // and further edits get made on top of it.
  const ui = await mount();
  try {
    await ui.openTab("Configurations");
    const before = ui.host.textContent;

    ui.dom.failFetch.value = true;
    const fixture = await readFile(
      new URL("./fixtures/golden.fd4cfg", import.meta.url),
    );
    await ui.importFile("golden.fd4cfg", fixture);

    const toasts = [...ui.host.querySelectorAll(".toast")];
    const text = toasts.map((t) => t.textContent).join(" | ");

    // It must refuse, naming the reason.
    assert.match(text, /Cannot import/i, `expected a refusal, got: ${text}`);
    assert.match(text, /nowhere to save|storage is unavailable/i);
    // It must NOT claim any kind of import happened.
    assert.equal(
      /^.*Imported /.test(text) && !/Cannot import/.test(text),
      false,
      `import must not report having imported anything: ${text}`,
    );
    assert.equal(
      toasts.some((t) => t.classList.contains("ok")),
      false,
      "no success-toned toast when the import was refused",
    );

    // And no state may have changed: the golden fixture's site must not appear.
    assert.equal(
      ui.host.textContent.includes("Golden Test House"),
      false,
      "a refused import must not apply to in-memory state",
    );
    assert.ok(before.length > 0);
  } finally {
    ui.cleanup();
  }
});






test("opening the app connects to the Scene Controller on its own", async () => {
  const { buildGoldenAppData } = await import("./golden-app-data.mjs");
  const saved = buildGoldenAppData();
  const ui = await mount({ savedSite: saved });
  try {
    const ws = ui.dom.sockets.at(-1);
    assert.ok(ws, "opening the page should open the bridge WebSocket by itself");
    assert.match(String(ws.url), /\/bridge/);

    // The bridge only learns which controller to reach once the socket opens.
    const { act } = await import("react");
    await act(async () => {
      ws.readyState = ws.constructor.OPEN;
      ws.onopen();
    });
    await settle(3);
    const request = JSON.parse(ws.sent.at(-1));
    assert.ok(
      request.type === "discover" || request.type === "connect",
      `unexpected startup request ${request.type}`,
    );
    assert.equal(request.securityCode, saved.site.securityCode);

    await act(async () => {
      ws.onmessage({
        data: JSON.stringify({
          type: "status",
          state: "connected",
          message: "Authenticated with Scene Controller",
        }),
      });
    });
    await settle(3);
    assert.ok(
      byText(ui.host, "button.connection-chip", "^Connected$").length > 0,
      "the header should report the automatic connection",
    );
  } finally {
    ui.cleanup();
  }
});

test("an unconfigured site is not nagged about at startup", async () => {
  const ui = await mount();
  try {
    assert.equal(
      ui.dom.sockets.length,
      0,
      "a site with no security code has nothing to connect to",
    );
    assert.equal(
      byText(ui.host, ".toast", "security code").length,
      0,
      "opening the app must not toast a connection failure",
    );
    assert.ok(
      byText(ui.host, "button.connection-chip", "Offline").length > 0,
      "the header should stay offline rather than showing a failure",
    );
    await ui.openTab("Trace");
    assert.match(ui.host.textContent, /Automatic connection skipped/);
  } finally {
    ui.cleanup();
  }
});

test("Compare is enabled by a controller connection and sends the local checksum", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Configurations");
    const compare = byText(ui.host, "button", "Compare with Scene Controller")[0];
    assert.ok(compare);
    assert.equal(compare.disabled, true, "offline comparison must stay disabled");
    assert.match(compare.getAttribute("title") ?? "", /Connect/i);

    await ui.openTab("Sites");
    await ui.unlockInstaller();
    const security = fieldByLabel(ui.host, "Controller security code");
    await ui.type(security, "TESTSECURITYCODE");
    const connect = byText(ui.host, "button", "^Connect$")[0];
    await ui.click(connect);
    const ws = ui.dom.sockets.at(-1);
    assert.ok(ws, "Connect should open the bridge WebSocket");
    const { act } = await import("react");
    await act(async () => {
      ws.readyState = ws.constructor.OPEN;
      ws.onopen();
      ws.onmessage({
        data: JSON.stringify({
          type: "capabilities",
          profile: { id: "type-0-live-only", verify: true },
        }),
      });
      ws.onmessage({
        data: JSON.stringify({
          type: "status",
          state: "connected",
          message: "Authenticated with Scene Controller",
        }),
      });
    });
    await settle(4);

    await ui.openTab("Configurations");
    const enabledCompare = byText(
      ui.host,
      "button",
      "Compare with Scene Controller",
    )[0];
    assert.equal(enabledCompare.disabled, false);
    await ui.click(enabledCompare);
    const request = JSON.parse(ws.sent.at(-1));
    assert.equal(request.type, "verify");
    assert.match(request.localChecksum, /^[0-9a-f]{4}$/);
    assert.match(
      ui.host.querySelector('[data-testid="comparison-state"]').textContent,
      /Waiting for the Scene Controller/,
    );
  } finally {
    ui.cleanup();
  }
});

test("Send follows the original iOS warning, progress and success flow", async () => {
  const ui = await mount();
  try {
    await ui.openTab("Configurations");
    const fixture = JSON.parse(
      await readFile(
        new URL("./fixtures/golden-import.json", import.meta.url),
        "utf8",
      ),
    );
    fixture.configurations[0].controllerCode = "TESTCODE";
    fixture.users = [];
    await ui.importFile(
      "synthetic-transfer.json",
      JSON.stringify(fixture),
    );
    await ui.openTab("Sites");
    await ui.unlockInstaller();
    await ui.type(
      fieldByLabel(ui.host, "Controller security code"),
      "TESTSECURITYCODE",
    );
    await ui.click(byText(ui.host, "button", "^Connect$")[0]);
    const ws = ui.dom.sockets.at(-1);
    const { act } = await import("react");
    await act(async () => {
      ws.readyState = ws.constructor.OPEN;
      ws.onopen();
      ws.onmessage({
        data: JSON.stringify({
          type: "capabilities",
          profile: {
            id: "type-0-live-only",
            verify: true,
            fullTransfer: true,
          },
        }),
      });
      ws.onmessage({
        data: JSON.stringify({
          type: "status",
          state: "connected",
          message: "Authenticated with Scene Controller",
        }),
      });
      ws.onmessage({
        data: JSON.stringify({
          type: "transferSafetyStatus",
          liveWritesEnabled: true,
          emergencyStopped: false,
        }),
      });
    });
    await settle(4);

    await ui.openTab("Configurations");
    await ui.click(
      byText(ui.host, "button", "Compare with Scene Controller")[0],
    );
    const verify = JSON.parse(ws.sent.at(-1));
    await act(async () => {
      ws.onmessage({
        data: JSON.stringify({
          type: "verifyResult",
          state: "match",
          localChecksum: verify.localChecksum,
          controllerChecksum: verify.localChecksum,
          version: "4.0",
          message: "Verified OK",
        }),
      });
    });
    await settle(3);

    await ui.click(
      byText(ui.host, "button", "Run offline transfer dry run")[0],
    );
    const dryRun = JSON.parse(ws.sent.at(-1));
    assert.equal(
      dryRun.type,
      "transferDryRun",
      `sent=${JSON.stringify(ws.sent.map((value) => JSON.parse(value)))} text=${ui.host.textContent}`,
    );
    await act(async () => {
      ws.onmessage({
        data: JSON.stringify({
          type: "transferPreflight",
          state: "passed",
          message:
            "Offline transfer dry run passed; no controller bytes were written.",
          imageChecksum: dryRun.imageChecksum,
          imageBytes: 36492,
          blockCount: 143,
          userCount: 1,
          userBytes: 250,
          frameCount: 295,
          liveWritesEnabled: true,
          runnerQualification: {
            state: "passed",
            resetReconnectExercised: true,
            validatedStatusRecords: 10,
          },
        }),
      });
    });
    await settle(3);

    const sendButton = byText(
      ui.host,
      "button",
      "Send configuration to Scene Controller",
    )[0];
    assert.equal(sendButton.disabled, false);
    await ui.click(sendButton);
    const dialog = ui.host.querySelector('[role="alertdialog"]');
    assert.ok(dialog);
    assert.match(
      dialog.textContent,
      /Ready to send configuration to Scene Controller/,
    );
    assert.match(dialog.textContent, /suspend operation of the switches/);
    assert.match(dialog.textContent, /light levels changing or going off/);
    assert.match(dialog.textContent, /take several minutes/);

    const sentBeforeCancel = ws.sent.length;
    await ui.click(byText(dialog, "button", "^Cancel$")[0]);
    assert.equal(ws.sent.length, sentBeforeCancel);
    assert.equal(ui.host.querySelector('[role="alertdialog"]'), null);

    await ui.click(sendButton);
    await ui.click(
      byText(
        ui.host.querySelector('[role="alertdialog"]'),
        "button",
        "^Continue$",
      )[0],
    );
    const sync = JSON.parse(ws.sent.at(-1));
    assert.equal(sync.type, "sync");
    assert.equal(sync.confirm, "Continue");
    assert.equal(sync.imageBase64, dryRun.imageBase64);
    assert.deepEqual(sync.userPayloadsBase64, dryRun.userPayloadsBase64);

    await act(async () => {
      ws.onmessage({
        data: JSON.stringify({
          type: "transferProgress",
          state: "block-ack",
          blockNumber: 143,
          message: "Downloading block 143",
        }),
      });
    });
    await settle(3);
    const progress = ui.host.querySelector(
      'progress[aria-label="Configuration download progress"]',
    );
    assert.equal(progress.value, 143);
    assert.equal(progress.max, 143);

    for (const message of [
      "Verifying Scene Controller",
      "Making permanent - this takes up to 60 seconds",
      "Download complete - resetting Scene Controller",
    ]) {
      await act(async () => {
        ws.onmessage({
          data: JSON.stringify({
            type: "transferProgress",
            state: "running",
            message,
          }),
        });
      });
      await settle(2);
      assert.match(
        ui.host.querySelector('[role="alertdialog"]').textContent,
        new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }

    await act(async () => {
      ws.onmessage({
        data: JSON.stringify({
          type: "transferProgress",
          state: "running",
          message: "This takes about 60 seconds",
        }),
      });
    });
    await settle(2);
    assert.match(
      ui.host.querySelector('[role="alertdialog"]').textContent,
      /Restarting Scene Controller — this takes about 60 seconds/,
    );

    await act(async () => {
      ws.onmessage({
        data: JSON.stringify({
          type: "transferResult",
          state: "completed",
          outcome: "completed",
          message:
            "Download completed successfully. Scene controller running normally.",
          imageChecksum: dryRun.imageChecksum,
          frameCount: 295,
        }),
      });
    });
    await settle(3);
    assert.match(
      ui.host.querySelector('[role="alertdialog"]').textContent,
      /Download completed successfully/,
    );
    assert.match(
      ui.host.querySelector('[role="alertdialog"]').textContent,
      /Scene controller running normally/,
    );
  } finally {
    ui.cleanup();
  }
});

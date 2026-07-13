"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";

type Tab = "Sites" | "Configurations" | "Equipment" | "Switches" | "Basic Assignments" | "Scenes" | "Scene to Button" | "Periods" | "Users" | "Trace";
type Room = { id: number; name: string; floor: string; icon: string };
type Channel = { id: number; name: string; roomId: number; module: string; kind: string; level: number };
type WallSwitch = { id: number; name: string; roomId: number; kind: string; buttons: number };
type Scene = { id: number; name: string; group: string; levels: Record<number, number>; fade: number; enabled: boolean; days: string[]; time: string };
type Period = { id: number; name: string; start: string; end: string; days: string[]; enabled: boolean };
type FlexUser = { id: number; name: string; remote: boolean; changes: boolean; key: string };
type Assignment = { switchId: number; button: number; sceneId: number };
type Site = { name: string; id: string; ip: string; port: number; description: string; address: string; timezone: string; dst: string; remote: boolean };
type AppData = { site: Site; rooms: Room[]; channels: Channel[]; switches: WallSwitch[]; scenes: Scene[]; periods: Period[]; users: FlexUser[]; assignments: Assignment[] };
type TraceItem = { at: string; text: string; tone?: "ok" | "warn" };

const tabs: { name: Tab; icon: string }[] = [
  { name: "Sites", icon: "/flexidim/sites.png" },
  { name: "Configurations", icon: "/flexidim/configurations.png" },
  { name: "Equipment", icon: "/flexidim/equipment.png" },
  { name: "Switches", icon: "/flexidim/switches.png" },
  { name: "Basic Assignments", icon: "/flexidim/assignments.png" },
  { name: "Scenes", icon: "/flexidim/scenes.png" },
  { name: "Scene to Button", icon: "/flexidim/scene-button.png" },
  { name: "Periods", icon: "/flexidim/periods.png" },
  { name: "Users", icon: "/flexidim/users.png" },
  { name: "Trace", icon: "/flexidim/wireless.png" },
];

const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const roomIcons = ["/flexidim/room-0.png", "/flexidim/room-3.png", "/flexidim/room-10.png", "/flexidim/room-100.png"];

const initialData: AppData = {
  site: { name: "Home", id: "FD4-0001", ip: "192.168.1.50", port: 15273, description: "FlexiDim lighting system", address: "", timezone: "Europe/London", dst: "UK / Europe", remote: false },
  rooms: [
    { id: 1, name: "Kitchen", floor: "Ground floor", icon: roomIcons[0] },
    { id: 2, name: "Living room", floor: "Ground floor", icon: roomIcons[3] },
    { id: 3, name: "Hall", floor: "Ground floor", icon: roomIcons[2] },
  ],
  channels: [
    { id: 1, name: "Kitchen pendants", roomId: 1, module: "Module 1 / Ch1", kind: "Trailing edge", level: 72 },
    { id: 2, name: "Worktop", roomId: 1, module: "Module 1 / Ch2", kind: "DALI", level: 48 },
    { id: 3, name: "Living room lamps", roomId: 2, module: "Module 1 / Ch3", kind: "Trailing edge", level: 35 },
    { id: 4, name: "Hall", roomId: 3, module: "Module 1 / Ch4", kind: "Relay", level: 100 },
  ],
  switches: [
    { id: 1, name: "Kitchen entrance", roomId: 1, kind: "4 scene", buttons: 4 },
    { id: 2, name: "Living room", roomId: 2, kind: "8 scene", buttons: 8 },
  ],
  scenes: [
    { id: 1, name: "All Off", group: "Whole house", levels: { 1: 0, 2: 0, 3: 0, 4: 0 }, fade: 1, enabled: true, days: dayNames, time: "" },
    { id: 2, name: "Bright", group: "Kitchen", levels: { 1: 100, 2: 100 }, fade: 2, enabled: true, days: dayNames, time: "" },
    { id: 3, name: "Evening", group: "Living room", levels: { 1: 25, 2: 35, 3: 28, 4: 15 }, fade: 5, enabled: true, days: dayNames, time: "19:00" },
  ],
  periods: [{ id: 1, name: "Evening", start: "18:00", end: "23:30", days: dayNames, enabled: true }],
  users: [{ id: 1, name: "Home owner", remote: false, changes: true, key: "1234 5678 abcd efgh" }],
  assignments: [{ switchId: 1, button: 1, sceneId: 2 }, { switchId: 1, button: 2, sceneId: 3 }, { switchId: 1, button: 4, sceneId: 1 }],
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <label className="toggle-row"><span>{label}</span><button type="button" className={`ios-toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} aria-pressed={checked}><i /></button></label>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty"><span>＋</span><p>{children}</p></div>;
}

function newId(items: { id: number }[]) { return Math.max(0, ...items.map((item) => item.id)) + 1; }
function now() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }

export default function FlexiDimWeb() {
  const [data, setData] = useState<AppData>(initialData);
  const [tab, setTab] = useState<Tab>("Sites");
  const [selectedScene, setSelectedScene] = useState(2);
  const [selectedRoom, setSelectedRoom] = useState(1);
  const [selectedSwitch, setSelectedSwitch] = useState(1);
  const [connection, setConnection] = useState<"offline" | "bridge" | "connecting" | "connected" | "error">("offline");
  const [trace, setTrace] = useState<TraceItem[]>([{ at: now(), text: "FlexiDim Web ready" }]);
  const [installer, setInstaller] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    const saved = localStorage.getItem("flexidim-web-data");
    if (saved) { try { const parsed = JSON.parse(saved); window.setTimeout(() => setData(parsed), 0); } catch { /* keep safe defaults */ } }
    hydrated.current = true;
    navigator.serviceWorker?.register("/sw.js").catch(() => undefined);
    return () => socket.current?.close();
  }, []);

  useEffect(() => {
    if (hydrated.current) localStorage.setItem("flexidim-web-data", JSON.stringify(data));
  }, [data]);

  const addTrace = (text: string, tone?: "ok" | "warn") => setTrace((items) => [{ at: now(), text, tone }, ...items].slice(0, 150));
  const roomName = (id: number) => data.rooms.find((room) => room.id === id)?.name ?? "Unassigned";
  const currentScene = data.scenes.find((scene) => scene.id === selectedScene) ?? data.scenes[0];
  const assignedScene = (switchId: number, button: number) => {
    const id = data.assignments.find((a) => a.switchId === switchId && a.button === button)?.sceneId;
    return data.scenes.find((scene) => scene.id === id);
  };

  const send = (payload: object) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(payload));
    else addTrace("Command not sent — local bridge is offline", "warn");
  };

  const connect = () => {
    socket.current?.close();
    setConnection("connecting");
    addTrace(`Connecting to ${data.site.ip}:${data.site.port}…`);
    const ws = new WebSocket("ws://127.0.0.1:8765");
    socket.current = ws;
    ws.onopen = () => { setConnection("bridge"); ws.send(JSON.stringify({ type: "connect", host: data.site.ip, port: data.site.port })); };
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "status") {
          setConnection(message.state === "connected" ? "connected" : message.state === "connecting" ? "connecting" : message.state === "bridge" ? "bridge" : "error");
          addTrace(message.message, message.state === "connected" ? "ok" : message.state === "error" ? "warn" : undefined);
        } else if (message.type === "trace") addTrace(message.message);
      } catch { addTrace(String(event.data)); }
    };
    ws.onerror = () => { setConnection("error"); addTrace("Local bridge is not running. Start it with npm run bridge.", "warn"); };
    ws.onclose = () => setConnection((state) => state === "error" ? state : "offline");
  };

  const setChannelLevel = (id: number, level: number, transmit = true) => {
    setData((old) => ({ ...old, channels: old.channels.map((channel) => channel.id === id ? { ...channel, level } : channel) }));
    if (transmit) { send({ type: "dim", channel: id, level, transition: 2 }); addTrace(`Channel ${id} set to ${level}%`); }
  };

  const runScene = (scene: Scene | undefined) => {
    if (!scene) return;
    Object.entries(scene.levels).forEach(([channel, level]) => setChannelLevel(Number(channel), level, false));
    send({ type: "scene", levels: scene.levels, transition: scene.fade });
    addTrace(`Scene “${scene.name}” run`, "ok");
  };

  const pressSwitch = (wallSwitch: WallSwitch, button: number) => {
    send({ type: "switch", switch: wallSwitch.id, button });
    const scene = assignedScene(wallSwitch.id, button);
    if (scene) runScene(scene);
    else addTrace(`${wallSwitch.name}: button ${button} pressed`);
  };

  const updateSite = (patch: Partial<Site>) => setData((old) => ({ ...old, site: { ...old.site, ...patch } }));

  const exportConfig = () => {
    const blob = new Blob([JSON.stringify({ format: "FlexiDim Web Configuration", version: 1, exportedAt: new Date().toISOString(), data }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `${data.site.name.replace(/\s+/g, "-").toLowerCase()}.fd4web.json`; link.click(); URL.revokeObjectURL(url);
    addTrace("Configuration exported", "ok");
  };

  const importConfig = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    try { const parsed = JSON.parse(await file.text()); setData(parsed.data ?? parsed); addTrace(`Imported ${file.name}`, "ok"); }
    catch { addTrace("That configuration file could not be read", "warn"); }
    event.target.value = "";
  };

  const unlock = () => {
    const answer = window.prompt("Type FLEXIDIM to enable installer changes");
    if (answer === "FLEXIDIM") { setInstaller(true); addTrace("Installer equipment changes enabled", "ok"); }
    else if (answer !== null) addTrace("Installer changes remain disabled", "warn");
  };

  const addRoom = () => {
    const name = window.prompt("Room name"); if (!name?.trim()) return;
    const id = newId(data.rooms); setData((old) => ({ ...old, rooms: [...old.rooms, { id, name: name.trim(), floor: "Ground floor", icon: roomIcons[id % roomIcons.length] }] })); setSelectedRoom(id);
  };
  const addChannel = () => {
    const name = window.prompt("Channel name"); if (!name?.trim()) return;
    const id = newId(data.channels); setData((old) => ({ ...old, channels: [...old.channels, { id, name: name.trim(), roomId: selectedRoom, module: `Module 1 / Ch${id}`, kind: "Dimmable", level: 0 }] }));
  };
  const addSwitch = () => {
    const name = window.prompt("Switch name"); if (!name?.trim()) return;
    const id = newId(data.switches); setData((old) => ({ ...old, switches: [...old.switches, { id, name: name.trim(), roomId: selectedRoom, kind: "4 scene", buttons: 4 }] })); setSelectedSwitch(id);
  };
  const addScene = () => {
    const name = window.prompt("Scene name"); if (!name?.trim()) return;
    const id = newId(data.scenes); const levels = Object.fromEntries(data.channels.map((channel) => [channel.id, channel.level]));
    setData((old) => ({ ...old, scenes: [...old.scenes, { id, name: name.trim(), group: roomName(selectedRoom), levels, fade: 2, enabled: true, days: dayNames, time: "" }] })); setSelectedScene(id);
  };

  const connectionLabel = connection === "connected" ? "Connected" : connection === "connecting" ? "Connecting…" : connection === "bridge" ? "Bridge ready" : connection === "error" ? "Bridge unavailable" : "Offline";

  const sitesPanel = <div className="content-grid site-grid">
    <section className="card site-identity">
      <div className="card-title"><div><small>ACTIVE SITE</small><h2>{data.site.name}</h2></div><span className={`status-pill ${connection}`}>● {connectionLabel}</span></div>
      <div className="site-hero"><img src="/flexidim/sites.png" alt="" /><div><b>{data.site.description}</b><span>Site ID {data.site.id}</span><span>{data.rooms.length} rooms · {data.channels.length} channels · {data.scenes.length} scenes</span></div></div>
      <div className="connect-box"><Field label="Scene Controller IP"><input value={data.site.ip} onChange={(e) => updateSite({ ip: e.target.value })} inputMode="decimal" /></Field><Field label="Port"><input type="number" value={data.site.port} onChange={(e) => updateSite({ port: Number(e.target.value) })} /></Field><button className="primary" onClick={connect}>{connection === "connected" ? "Reconnect" : "Connect"}</button></div>
      <p className="hint">The browser uses the bundled local bridge to reach the Scene Controller on your home network.</p>
    </section>
    <section className="card form-card"><div className="card-title"><div><small>SITE DETAILS</small><h2>Home and location</h2></div></div>
      <div className="form-grid"><Field label="Site name"><input value={data.site.name} onChange={(e) => updateSite({ name: e.target.value })} /></Field><Field label="Site ID"><input value={data.site.id} onChange={(e) => updateSite({ id: e.target.value })} /></Field><Field label="Address"><input value={data.site.address} placeholder="Optional" onChange={(e) => updateSite({ address: e.target.value })} /></Field><Field label="Time zone"><input value={data.site.timezone} onChange={(e) => updateSite({ timezone: e.target.value })} /></Field><Field label="DST rules"><select value={data.site.dst} onChange={(e) => updateSite({ dst: e.target.value })}><option>UK / Europe</option><option>USA</option><option>No daylight saving</option></select></Field></div>
      <Toggle label="Enable remote access" checked={data.site.remote} onChange={(remote) => updateSite({ remote })} />
    </section>
    <section className="card room-strip"><div className="card-title"><div><small>AREAS</small><h2>Rooms</h2></div><button className="text-button" onClick={addRoom}>＋ Add room</button></div><div className="room-cards">{data.rooms.map((room) => <button key={room.id} onClick={() => { setSelectedRoom(room.id); setTab("Equipment"); }}><img src={room.icon} alt="" /><b>{room.name}</b><span>{room.floor}</span></button>)}</div></section>
  </div>;

  const configPanel = <div className="content-grid config-grid">
    <section className="card"><div className="card-title"><div><small>LOCAL CONFIGURATION</small><h2>{data.site.name}</h2></div><span className="version">v2.97 migrated</span></div><div className="summary-list"><div><span>Configuration name</span><b>{data.site.name}</b></div><div><span>Description</span><b>{data.site.description}</b></div><div><span>Format</span><b>FlexiDim Web · fd4web</b></div><div><span>Saved</span><b>Automatically on this device</b></div></div><div className="button-row"><button className="primary" onClick={exportConfig}>Export configuration</button><button onClick={() => fileInput.current?.click()}>Import configuration</button><input ref={fileInput} type="file" accept=".json,.fd4web" onChange={importConfig} hidden /></div></section>
    <section className="card sync-card"><div className="card-title"><div><small>SCENE CONTROLLER</small><h2>Configuration transfer</h2></div></div><div className="sync-graphic"><img src="/flexidim/configurations.png" alt="" /><div className="sync-line"><i /><i /><i /></div><img src="/flexidim/connected.png" alt="" /></div><button onClick={() => addTrace("Configuration comparison requested")}>Compare with Scene Controller</button><button className="primary" disabled={connection !== "connected"} onClick={() => { send({ type: "sync", data }); addTrace("Configuration transfer started"); }}>Send configuration to Scene Controller</button><p className="warning-copy">Full binary configuration transfer is retained as an advanced bridge operation. Live lighting control remains available without it.</p></section>
    <section className={`card installer-card ${installer ? "enabled" : ""}`}><div><small>INSTALLER ACCESS</small><h2>{installer ? "Equipment changes enabled" : "Equipment changes are disabled"}</h2><p>Making changes to equipment can affect proper operation of the FlexiDim system.</p></div><button onClick={installer ? () => setInstaller(false) : unlock}>{installer ? "Disable changes" : "Enable changes"}</button></section>
  </div>;

  const equipmentPanel = <div className="master-detail">
    <section className="master card"><div className="master-head"><div><small>EQUIPMENT</small><h2>Rooms & channels</h2></div><button onClick={addRoom}>＋</button></div>{data.rooms.map((room) => <button key={room.id} className={selectedRoom === room.id ? "selected" : ""} onClick={() => setSelectedRoom(room.id)}><img src={room.icon} alt="" /><span><b>{room.name}</b><small>{data.channels.filter((c) => c.roomId === room.id).length} channels · {data.switches.filter((s) => s.roomId === room.id).length} switches</small></span><em>›</em></button>)}</section>
    <section className="detail card"><div className="card-title"><div><small>{data.rooms.find((r) => r.id === selectedRoom)?.floor ?? "AREA"}</small><h2>{roomName(selectedRoom)}</h2></div><div className="button-row compact"><button onClick={addSwitch}>＋ Switch</button><button className="primary" onClick={addChannel}>＋ Channel</button></div></div><h3>Lighting channels</h3><div className="channel-list">{data.channels.filter((channel) => channel.roomId === selectedRoom).map((channel) => <div className="channel-row" key={channel.id}><div className="channel-number">{channel.id}</div><div className="channel-copy"><b>{channel.name}</b><span>{channel.module} · {channel.kind}</span></div><input aria-label={`${channel.name} brightness`} type="range" min="0" max="100" value={channel.level} onChange={(e) => setChannelLevel(channel.id, Number(e.target.value))} /><output>{channel.level}%</output><button className="power" onClick={() => setChannelLevel(channel.id, channel.level ? 0 : 100)} aria-label={`Toggle ${channel.name}`}>⏻</button></div>)}</div><h3>Wall switches</h3><div className="switch-mini-list">{data.switches.filter((item) => item.roomId === selectedRoom).map((item) => <button key={item.id} onClick={() => { setSelectedSwitch(item.id); setTab("Switches"); }}><img src="/flexidim/switches.png" alt="" /><span><b>{item.name}</b><small>Switch {item.id} · {item.kind}</small></span><em>Configure ›</em></button>)}</div></section>
  </div>;

  const switchesPanel = <div className="master-detail">
    <section className="master card"><div className="master-head"><div><small>SWITCHES</small><h2>Switch overview</h2></div><button onClick={addSwitch}>＋</button></div>{data.switches.map((item) => <button key={item.id} className={selectedSwitch === item.id ? "selected" : ""} onClick={() => setSelectedSwitch(item.id)}><img src="/flexidim/switches.png" alt="" /><span><b>{item.name}</b><small>{roomName(item.roomId)} · {item.kind}</small></span><em>›</em></button>)}</section>
    <section className="detail card">{(() => { const item = data.switches.find((s) => s.id === selectedSwitch) ?? data.switches[0]; if (!item) return <Empty>Add a switch to begin.</Empty>; return <><div className="card-title"><div><small>{roomName(item.roomId)}</small><h2>{item.name}</h2></div><span className="version">Switch {item.id}</span></div><div className="wall-switch"><div className="switch-label">FlexiDim</div><div className={`switch-grid buttons-${item.buttons}`}>{Array.from({ length: item.buttons }, (_, index) => index + 1).map((button) => <button key={button} onClick={() => pressSwitch(item, button)}><span>{button}</span><small>{assignedScene(item.id, button)?.name ?? "Unassigned"}</small></button>)}</div></div><p className="center hint">Press a button to send the original FlexiDim switch command and run its assigned scene.</p><div className="form-grid narrow"><Field label="Switch name"><input value={item.name} onChange={(e) => setData((old) => ({ ...old, switches: old.switches.map((s) => s.id === item.id ? { ...s, name: e.target.value } : s) }))} /></Field><Field label="Switch type"><select value={item.kind} onChange={(e) => setData((old) => ({ ...old, switches: old.switches.map((s) => s.id === item.id ? { ...s, kind: e.target.value, buttons: e.target.value.startsWith("8") ? 8 : 4 } : s) }))}><option>4 scene</option><option>8 scene</option><option>2 channel opto</option><option>8 channel opto</option></select></Field></div></>; })()}</section>
  </div>;

  const assignmentsPanel = <div className="content-grid"><section className="card wide"><div className="card-title"><div><small>BASIC ASSIGNMENTS</small><h2>Channels assigned to switches</h2></div><button className="primary" onClick={() => addTrace("Basic assignments auto-filled")}>Auto fill</button></div><div className="assignment-table"><div className="table-head"><span>Switch</span><span>Button</span><span>Scene / function</span><span>Channels</span></div>{data.switches.flatMap((item) => Array.from({ length: item.buttons }, (_, i) => i + 1).map((button) => { const scene = assignedScene(item.id, button); return <div key={`${item.id}-${button}`}><span><b>{item.name}</b><small>{roomName(item.roomId)}</small></span><span>Button {button}</span><select value={scene?.id ?? ""} onChange={(e) => { const sceneId = Number(e.target.value); setData((old) => ({ ...old, assignments: [...old.assignments.filter((a) => !(a.switchId === item.id && a.button === button)), ...(sceneId ? [{ switchId: item.id, button, sceneId }] : [])] })); }}><option value="">Unassigned</option>{data.scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><span>{scene ? Object.keys(scene.levels).length : 0} channels</span></div>; }))}</div></section></div>;

  const scenesPanel = <div className="master-detail scene-layout">
    <section className="master card"><div className="master-head"><div><small>SCENES</small><h2>Scene folders</h2></div><button onClick={addScene}>＋</button></div>{data.scenes.map((scene) => <button key={scene.id} className={selectedScene === scene.id ? "selected" : ""} onClick={() => setSelectedScene(scene.id)}><img src="/flexidim/scenes.png" alt="" /><span><b>{scene.name}</b><small>{scene.group} · {Object.keys(scene.levels).length} channels</small></span><em>›</em></button>)}</section>
    <section className="detail card">{currentScene ? <><div className="card-title"><div><small>{currentScene.group}</small><h2>{currentScene.name}</h2></div><button className="run-scene" onClick={() => runScene(currentScene)}>▶ Run scene</button></div><div className="scene-controls"><Field label="Scene name"><input value={currentScene.name} onChange={(e) => setData((old) => ({ ...old, scenes: old.scenes.map((s) => s.id === currentScene.id ? { ...s, name: e.target.value } : s) }))} /></Field><Field label="Fade time"><select value={currentScene.fade} onChange={(e) => setData((old) => ({ ...old, scenes: old.scenes.map((s) => s.id === currentScene.id ? { ...s, fade: Number(e.target.value) } : s) }))}><option value="0">Immediate</option><option value="1">1 sec.</option><option value="2">2 secs.</option><option value="5">5 secs.</option><option value="10">10 secs.</option></select></Field><Field label="At time (optional)"><input type="time" value={currentScene.time} onChange={(e) => setData((old) => ({ ...old, scenes: old.scenes.map((s) => s.id === currentScene.id ? { ...s, time: e.target.value } : s) }))} /></Field></div><h3>Channels affected by scene</h3><div className="scene-channel-grid">{data.channels.map((channel) => { const included = currentScene.levels[channel.id] !== undefined; const value = currentScene.levels[channel.id] ?? channel.level; return <div className={included ? "included" : ""} key={channel.id}><label><input type="checkbox" checked={included} onChange={(e) => setData((old) => ({ ...old, scenes: old.scenes.map((s) => { if (s.id !== currentScene.id) return s; const levels = { ...s.levels }; if (e.target.checked) levels[channel.id] = channel.level; else delete levels[channel.id]; return { ...s, levels }; }) }))} /><span><b>{channel.name}</b><small>{roomName(channel.roomId)}</small></span></label><input type="range" min="0" max="100" disabled={!included} value={value} onChange={(e) => setData((old) => ({ ...old, scenes: old.scenes.map((s) => s.id === currentScene.id ? { ...s, levels: { ...s.levels, [channel.id]: Number(e.target.value) } } : s) }))} /><output>{value}%</output></div>; })}</div><div className="day-picker">{dayNames.map((day) => <button key={day} className={currentScene.days.includes(day) ? "active" : ""} onClick={() => setData((old) => ({ ...old, scenes: old.scenes.map((s) => s.id === currentScene.id ? { ...s, days: s.days.includes(day) ? s.days.filter((d) => d !== day) : [...s.days, day] } : s) }))}>{day}</button>)}</div></> : <Empty>Add a scene to begin.</Empty>}</section>
  </div>;

  const sceneButtonPanel = <div className="content-grid"><section className="card wide"><div className="card-title"><div><small>SCENE TO BUTTON</small><h2>Put scenes on wall controls</h2></div></div><div className="mapping-grid">{data.switches.map((item) => <div className="mapping-card" key={item.id}><div><img src="/flexidim/switches.png" alt="" /><span><b>{item.name}</b><small>{roomName(item.roomId)}</small></span></div>{Array.from({ length: item.buttons }, (_, i) => i + 1).map((button) => <label key={button}><span>Button {button}</span><select value={assignedScene(item.id, button)?.id ?? ""} onChange={(e) => { const sceneId = Number(e.target.value); setData((old) => ({ ...old, assignments: [...old.assignments.filter((a) => !(a.switchId === item.id && a.button === button)), ...(sceneId ? [{ switchId: item.id, button, sceneId }] : [])] })); }}><option value="">None</option>{data.scenes.map((scene) => <option value={scene.id} key={scene.id}>{scene.name}</option>)}</select><button onClick={() => pressSwitch(item, button)}>Test</button></label>)}</div>)}</div></section></div>;

  const periodsPanel = <div className="content-grid"><section className="card wide"><div className="card-title"><div><small>PERIODS</small><h2>Lighting schedule periods</h2></div><button className="primary" onClick={() => setData((old) => ({ ...old, periods: [...old.periods, { id: newId(old.periods), name: "New period", start: "08:00", end: "18:00", days: dayNames, enabled: true }] }))}>＋ New period</button></div><div className="period-list">{data.periods.map((period) => <div key={period.id} className={period.enabled ? "" : "disabled"}><button className={`period-power ${period.enabled ? "on" : ""}`} onClick={() => setData((old) => ({ ...old, periods: old.periods.map((p) => p.id === period.id ? { ...p, enabled: !p.enabled } : p) }))}>●</button><input className="period-name" value={period.name} onChange={(e) => setData((old) => ({ ...old, periods: old.periods.map((p) => p.id === period.id ? { ...p, name: e.target.value } : p) }))} /><label>From <input type="time" value={period.start} onChange={(e) => setData((old) => ({ ...old, periods: old.periods.map((p) => p.id === period.id ? { ...p, start: e.target.value } : p) }))} /></label><label>To <input type="time" value={period.end} onChange={(e) => setData((old) => ({ ...old, periods: old.periods.map((p) => p.id === period.id ? { ...p, end: e.target.value } : p) }))} /></label><div className="mini-days">{dayNames.map((day) => <button key={day} className={period.days.includes(day) ? "active" : ""} onClick={() => setData((old) => ({ ...old, periods: old.periods.map((p) => p.id === period.id ? { ...p, days: p.days.includes(day) ? p.days.filter((d) => d !== day) : [...p.days, day] } : p) }))}>{day[0]}</button>)}</div><button className="delete" onClick={() => setData((old) => ({ ...old, periods: old.periods.filter((p) => p.id !== period.id) }))}>Delete</button></div>)}</div></section></div>;

  const usersPanel = <div className="content-grid users-grid"><section className="card"><div className="card-title"><div><small>USERS</small><h2>Remote Control profiles</h2></div><button className="primary" onClick={() => setData((old) => ({ ...old, users: [...old.users, { id: newId(old.users), name: "New user", remote: false, changes: false, key: crypto.randomUUID().replace(/-/g, " ").slice(0, 19) }] }))}>＋ New user</button></div><div className="user-list">{data.users.map((user) => <div key={user.id}><img src="/flexidim/users.png" alt="" /><input value={user.name} onChange={(e) => setData((old) => ({ ...old, users: old.users.map((u) => u.id === user.id ? { ...u, name: e.target.value } : u) }))} /><code>{user.key}</code><Toggle label="Remote access" checked={user.remote} onChange={(remote) => setData((old) => ({ ...old, users: old.users.map((u) => u.id === user.id ? { ...u, remote } : u) }))} /><Toggle label="Allow changes" checked={user.changes} onChange={(changes) => setData((old) => ({ ...old, users: old.users.map((u) => u.id === user.id ? { ...u, changes } : u) }))} /><button className="delete" onClick={() => setData((old) => ({ ...old, users: old.users.filter((u) => u.id !== user.id) }))}>Delete</button></div>)}</div></section><section className="card user-info"><img src="/flexidim/icon.png" alt="FlexiDim" /><h2>User security keys</h2><p>Keys are kept in this browser with the rest of the local configuration. Export a backup before clearing browser data.</p><button onClick={() => { navigator.clipboard?.writeText(data.users.map((u) => `${u.name}: ${u.key}`).join("\n")); addTrace("User keys copied"); }}>Copy all keys</button></section></div>;

  const tracePanel = <div className="content-grid"><section className="card wide trace-card"><div className="card-title"><div><small>TRACE</small><h2>Controller activity</h2></div><div className="button-row compact"><button onClick={() => send({ type: "periodFlags" })}>Request period flags</button><button onClick={() => setTrace([])}>Clear</button></div></div><div className="trace-list" role="log">{trace.length ? trace.map((item, index) => <div key={`${item.at}-${index}`} className={item.tone ?? ""}><time>{item.at}</time><i /><span>{item.text}</span></div>) : <Empty>No activity yet.</Empty>}</div></section></div>;

  const panels: Record<Tab, React.ReactNode> = { Sites: sitesPanel, Configurations: configPanel, Equipment: equipmentPanel, Switches: switchesPanel, "Basic Assignments": assignmentsPanel, Scenes: scenesPanel, "Scene to Button": sceneButtonPanel, Periods: periodsPanel, Users: usersPanel, Trace: tracePanel };

  return <main className="app-shell">
    <header className="topbar"><button className="brand" onClick={() => setTab("Sites")}><span className="brand-mark"><b>J</b><b>C</b><b>L</b></span><span><strong>FlexiDim</strong><small>Configuration</small></span></button><div className="site-chip"><span>{data.site.name}</span><small>{data.site.id}</small></div><button className={`connection-chip ${connection}`} onClick={connect}><i />{connectionLabel}</button><button className="more-button" onClick={() => setShowMenu(!showMenu)} aria-label="Configuration menu">•••</button>{showMenu && <div className="more-menu"><button onClick={() => { exportConfig(); setShowMenu(false); }}>Export backup</button><button onClick={() => { fileInput.current?.click(); setShowMenu(false); }}>Import backup</button><button onClick={() => { setData(initialData); setShowMenu(false); addTrace("Demo configuration restored"); }}>Restore example</button></div>}</header>
    <nav className="tabbar" aria-label="FlexiDim sections">{tabs.map((item) => <button key={item.name} className={tab === item.name ? "active" : ""} onClick={() => setTab(item.name)}><img src={item.icon} alt="" /><span>{item.name}</span></button>)}</nav>
    <section className="workspace"><div className="section-heading"><div><small>FLEXIDIM / {data.site.name.toUpperCase()}</small><h1>{tab}</h1></div>{tab !== "Sites" && <span className={`status-pill ${connection}`}>● {connectionLabel}</span>}</div>{panels[tab]}</section>
    <footer><span>FlexiDim Web</span><span>Local-first · Configuration saved on this device</span><span>Recovered from iOS v2.97</span></footer>
  </main>;
}

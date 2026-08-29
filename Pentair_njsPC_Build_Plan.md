# Pentair Pool Automation — RS-485 Bypass Build Plan

**Date:** 2026-08-28
**Goal:** Replace the failed Pentair ScreenLogic Protocol Adapter with an Orange Pi Zero 2W running nodejs-poolController (njsPC), wired directly to the EasyTouch RS-485 bus.

> **Read this first if you are a fresh Claude session.** This document is the complete context. Section 2 contains hard constraints that were decided deliberately — do not propose alternatives to them.

---

## 1. Background — why we are doing this

The Pentair ScreenLogic Protocol Adapter failed. It was diagnosed down to the board level:

- Green Pentair carrier board 5 V rail: **5.0030 V** (good)
- Digi RabbitCore RCM3710 module 3.3 V rail: **~3.27 V** (good)
- Rabbit `/RES` line: **3.265 V** — reset released, CPU not held in reset
- `SMODE0` / `SMODE1`: **0 V / 0 V** — correct for normal boot
- CPU oscillator: **~11.1 MHz** — running normally

Despite all of that being healthy, the adapter produces **no DHCP, no ARP, no Ethernet frames at all** from its MAC `00:13:A2:22:67:BB` on a direct-cable Wireshark capture. Pentair's own `UDPDownload.exe` recovery path at `192.168.2.2` also fails to discover it.

Conclusion: the RabbitCore is electrically alive but never reaches a functioning ScreenLogic application — most likely corrupted program flash.

**Repair was ruled out.** Recovery requires a Digi Rabbit cold-boot handshake over the `J2` header, which requires an obsolete Digi programming cable (`20-101-1183` USB or `20-101-0542` serial). Those are unobtainable, and building a replacement was rejected as too much effort for an uncertain outcome.

**Do not discard the failed adapter.** The Pentair 5.2.738 firmware payload was successfully extracted from `pentairupdate.exe` and is preserved (`pool.bin`, 226,080 bytes). If a Rabbit programmer ever turns up, the repair is still viable.

---

## 2. Hard constraints — these are decided, do not relitigate

1. **RS-485 is the ONLY interface to the Pentair box.** No EW11, no serial-over-WiFi bridge, no intermediate device. Direct wire from the Zero to the EasyTouch COM port.
2. **Pentair's wireless link is abandoned entirely.** Both transceivers come out of the picture. We are not tapping the indoor wireless link.
3. **njsPC runs on the Orange Pi Zero 2W itself.** Not on another host. The Zero is dedicated to this project.
4. **The Zero joins the home network over WiFi.** WiFi is confirmed working on the Orange Pi vendor Ubuntu image — that is why we are using that image and not Armbian.
5. **A custom web UI may be built later.** dashPanel is installed initially as a diagnostic only.

---

## 3. Hardware

### Compute
- **Orange Pi Zero 2W**, 2 GB, Allwinner H618 (quad Cortex-A53, arm64)
- 2× USB-C ports (one is power/OTG), 40-pin GPIO header, microSD
- Onboard WiFi: Unisoc UWE5622 module
- External antenna connector present; antenna ships with the board
  - **Verify whether it is U.FL or MHF4** — sources disagree and they are physically different connectors

### RS-485 interface
- **DSD TECH SH-U10 USB to RS485 Converter** (Amazon B078X5H8H7)
- Chipset: **Silicon Labs CP2102** — `cp210x` driver is in-kernel on Ubuntu 11.10 / kernel 3.0.0 and newer, so no driver install needed
- 15KV ESD protection and TVS overvoltage protection
- Terminal block pinout: `A+`, `B-`, `GND`, `GND`, `5V0`
- Enumerates as `/dev/ttyUSB0`

### Supporting parts
- **USB-C male to USB-A female OTG adapter** (the SH-U10 is a USB-A plug; the Zero has only USB-C)
- **5V / 3A USB-C wall supply** — for Phase 0 bench work only; at the pad the Zero is powered from the panel (see §4a). Any decent USB-C phone charger works; the Zero 2W does not negotiate USB-PD, so it just takes the 5V default.
- **DC-DC buck converter: PlusRoc Waterproof DC 8-32V → 5V/3A, USB-C output** (Amazon B09DGDQ48H) — powers the Zero from the EasyTouch's own +15V COM-port supply (see §4a). Potted waterproof enclosure, captive USB-C plug, fixed 5V output with no USB-PD negotiation (correct for the Zero 2W): two input wires to the panel, USB-C straight into the Zero.
- **Inline fuse, 1 A** (mini blade or glass, with holder) for the 15V feed to the buck — cheap insurance for the panel's supply
- **High-endurance microSD**, 32 GB (SanDisk High Endurance or Max Endurance) — outdoor heat and unclean power-downs kill standard cards
- **CAT5e** for the RS-485 run; use one twisted pair for DATA+/DATA-
- **Antenna pigtail + bulkhead connector** if the Zero is mounted inside the metal load center
- **IP65 non-metallic enclosure + cable glands** if not mounting inside the LV compartment

---

## 4. Wiring

### SH-U10 to Pentair EasyTouch COM port

| SH-U10 terminal | Connect to |
|---|---|
| `A+` | Pentair DATA+ |
| `B-` | Pentair DATA- |
| `GND` | Pentair COM ground |
| `GND` | (spare, unused) |
| `5V0` | **LEAVE DISCONNECTED** |

**On `5V0`:** DSD's own documentation states this pin is a 5 V *output*, to be used only if the connected device needs a 5 V supply, and otherwise kept disconnected. Pentair does not need it. Wiring it is a good way to damage something.

**On ground:** RS-485 is differential but still needs a common-mode reference. On a long outdoor run, skipping ground is where problems show up. Connect it.

**On polarity:** There are only two possible ways to wire DATA+/DATA-. If it does not work, reverse them. That is the only wiring mistake possible here.

### 4a. Powering the Zero from the panel

The EasyTouch COM port is a 4-terminal block, and the terminal we are *not* using for data is the power tap:

| COM terminal (Pentair color) | Function |
|---|---|
| Red | **+15 VDC** (unregulated — measures anywhere from ~15 to low-20s unloaded) |
| Yellow | DATA+ |
| Green | DATA− |
| Black | GND |

This +15V pin is what powered the old ScreenLogic **outdoor wireless transceiver**. Since the wireless link is abandoned (constraint #2), disconnecting the transceiver frees up that exact power budget for the Zero.

Wiring: Red → fuse (1 A) → buck converter input +, Black → buck input −, buck's USB-C output → Zero's power port. The buck's ground ties the Zero to panel ground, which doubles as the RS-485 common-mode reference — one clean shared ground, no loop.

Rules:
1. **Measure the red terminal with a meter before connecting anything.** It is unregulated; pick a buck rated for at least 30V input so the unloaded voltage can't hurt it.
2. **Use a fixed 5V-output buck, not an adjustable one** — or if adjustable, set and verify 5.0-5.2V on a bench supply *before* it ever touches the Zero.
3. **Never power the Zero from the buck and a USB-C wall supply at the same time.**
4. Zero 2W worst-case draw is ~5W (~0.35 A at 15V) — well within what the transceiver's removal frees up. If the panel's 15V ever sags or other COM-port accessories misbehave after install, fall back to a dedicated supply from the pad's GFCI outlet.

### Termination resistor — check before installing

DSD explicitly states the SH-U10**L** cable variant has no 120 Ω resistor between A+ and B-, but says nothing either way about the SH-U10 terminal-block version.

**Measure across A+ and B- with a meter before installing.** We are joining an existing bus mid-span, not terminating an endpoint. If there is a 120 Ω resistor on board, consider lifting it — and revisit this if comms error rates come out high.

---

## 5. Software build sequence

### Phase 0 — Bench test before any wiring goes outside

Do all of this on a desk, not at the pool pad.

> **Status 2026-08-28 — SD card is flashed and ready.**
> - Image: **`Orangepizero2w_1.0.4_ubuntu_noble_desktop_xfce_linux6.1.31`** (vendor Ubuntu 24.04 Noble, XFCE desktop, vendor 6.1.31 kernel with UWE5622 WiFi). SHA-256 verified against the vendor `.sha`.
> - The image on disk at `images\Orangepizero2w_1.0.4_ubuntu_noble_desktop_xfce_linux6.1.31\` was **modified before flashing**: a NetworkManager profile (`/etc/NetworkManager/system-connections/pool-wifi.nmconnection`) was baked in so the Zero auto-joins the home 2.4 GHz WiFi on first boot. Re-flashing this same `.img` reproduces the exact card. The pristine original is the `.7z` in the project root.
> - The image layout is a **single ext4 partition** (no FAT boot partition) — Windows cannot edit the card directly; use WSL loop-mount of the `.img` for any future preseeding.
> - Enabled out of the box: SSH via `ssh.socket` (root login permitted), **xrdp** (Windows Remote Desktop → XFCE, no HDMI needed), NetworkManager. Default logins: `orangepi`/`orangepi`, `root`/`orangepi`. **Change these once on the network.**
> - First boot: takes a few minutes (filesystem auto-expand + first-run services). Find the IP in the router's client list, then `ssh orangepi@<ip>` or RDP to it.

1. Flash the **Orange Pi vendor Ubuntu image** to the microSD. ✅ **DONE** (see status above)
2. Boot, connect to WiFi, confirm it associates and **stays** associated over several hours.
3. **Immediately hold the kernel packages** once WiFi is confirmed working:
   ```
   sudo apt-mark hold linux-image-* linux-dtb-*
   ```
   WiFi works because of the vendor kernel and its UWE5622 module. An `apt upgrade` into a new kernel has a good chance of breaking it.
4. **Take an image backup of the SD card at this point.** This is the known-good baseline.

### Phase 1 — Node.js

njsPC requires **Node.js v20 or higher**. The vendor Ubuntu repo will ship something much older.

Install via **nvm** (preferred — keeps Node entirely out of the system package manager, which matters given the kernel hold) or NodeSource. Verify with `node --version`.

> ✅ **DONE 2026-08-28.** Zero booted, WiFi joined automatically, SSH in at `192.168.1.221`. Kernel packages `linux-image-next-sun50iw9` / `linux-dtb-next-sun50iw9` held. Node **v24.20.0 LTS** + npm 11.19.0 installed via nvm (user `orangepi`).

### Phase 2 — Prove the bus before installing njsPC

1. Plug in the SH-U10 via the OTG adapter. Confirm `/dev/ttyUSB0` appears.
2. Wire A+/B-/GND to the Pentair COM port.
3. Run:
   ```
   od -x < /dev/ttyUSB0
   ```
4. **Success looks like repeated `ffa5ff` in the output.** Port settings are 9600 baud, no parity, 8 data bits, 1 stop bit, no flow control.
5. If you see noise with no `ffa5ff`, swap A+ and B- and retry.

**Do not proceed until this test passes.** Everything downstream depends on it.

### Phase 3 — njsPC

```
git clone https://github.com/tagyoureit/nodejs-poolController.git
cd nodejs-poolController
npm install
npm start
```

Notes:
- Cloning the source is the recommended install method — updates are pushed frequently, releases are infrequent.
- `npm start` compiles the TypeScript every time. On an H618 the first compile will take a while — it is not hung.
- After the first build, `npm run start:cached` runs without compiling and is much faster.
- Set the serial port either from dashPanel (Setup → Controller → RS485 port) or by editing `rs485Port` in `config.json` to `/dev/ttyUSB0`.

Server listens on port **4200** by default. Note that the default listen IP of `127.0.0.1` is loopback only — set it to `0.0.0.0` to reach it from other machines on the LAN.

> ✅ **DONE 2026-08-28** (out of order — Phase 2 awaits the SH-U10 delivery). njsPC cloned to `~/nodejs-poolController`, `npm install` clean, first build + run OK. REST API verified from the LAN: `http://192.168.1.221:4200/state/all` returns HTTP 200 (controller mode Auto/Nixie until a panel is heard). Config already binds `0.0.0.0`; `rs485Port` is `/dev/ttyUSB0` and njsPC retries it every 10 s, so it will latch onto the SH-U10 when plugged in. Currently launched manually (`setsid nohup npm run start:cached`) — **not yet boot-persistent; Phase 5 (PM2/systemd) still to do.** Helper scripts from this session: `zssh.py` (scripted SSH), `setup_njspc.sh`, `restart_njspc.sh`.

### Phase 4 — dashPanel (diagnostic only)

Install [dashPanel](https://github.com/rstrouse/nodejs-poolController-dashPanel) and point it at njsPC. Its purpose here is to confirm njsPC is decoding the EasyTouch correctly — circuits, bodies, pump, heater, chlorinator all appearing and responding.

Once the bus is proven end to end, dashPanel can be replaced with a custom UI.

> ✅ **DONE 2026-08-28.** dashPanel installed at `~/nodejs-poolController-dashPanel`, serving at `http://192.168.1.221:5150`, connected to njsPC with **"Use Proxy to njsPC Server" enabled** (all browser traffic flows through :5150 — works from any LAN device and avoids cross-origin issues). Shows "Nixie Single Body / Ready"; the warning badge is the expected missing `/dev/ttyUSB0`.

### Phase 5 — Run at boot

Set up PM2 or systemd so njsPC survives reboots and power cycles. See the njsPC wiki page "Automatically start at boot - PM2 & Systemd".

> ✅ **DONE 2026-08-28.** PM2 manages both apps (`pm2 ls`: **njsPC**, **dashPanel**, run as `npm start` under user `orangepi`); process list saved and the `pm2-orangepi` systemd unit is enabled. **Reboot-tested:** full power-cycle → both services returned on their own, verified by HTTP 200 on :4200 and :5150 from the LAN (milestone 11 ✅). Note: PM2 runs `npm start` (rebuilds on boot, a few minutes on the H618) — deliberate, so a future `git pull` is picked up automatically.

---

## 6. What njsPC gives us

Confirmed from the njsPC README as supported for this setup:

- **Controllers:** EasyTouch (RS-485)
- **Pumps:** IntelliFlo VS / VSF / VF, and others — this covers pump speed control
- **Chlorinators:** IntelliChlor — this covers chlorinator output control
- **Heaters, lights, chemistry, schedules, valves, covers, filters**
- Live **REST + WebSocket API**
- Home automation bindings: MQTT (Home Assistant), Homebridge/HomeKit, Hubitat, InfluxDB, Alexa

### Clarification on two things that were asked about

- **Salt ppm is not a setpoint.** You set the IntelliChlor **output percentage** (0-100%). Salt ppm is a *reading* the cell reports back. njsPC exposes both — the percentage as a control, the salt level as a sensor.
- **Pump RPM on EasyTouch is nuanced.** The panel normally drives speed through circuit-to-speed assignments. Sending direct RPM commands can result in fighting the OCP, which reasserts its programmed speed. njsPC handles this, but it is the least clean part of the control surface.

---

## 7. Known risks and gotchas

| Risk | Mitigation |
|---|---|
| Kernel upgrade breaks UWE5622 WiFi | `apt-mark hold` the kernel; keep an SD image backup |
| WiFi unusable inside metal load center | External antenna on a pigtail routed outside the enclosure, or mount the Zero in a separate non-metallic box |
| SD card corruption from heat / power loss | High-endurance card, move logs to tmpfs, keep a known-good image |
| Termination resistor on SH-U10 | Measure A+ to B- before install |
| Node version too old in distro repo | Install Node 20+ via nvm |
| Serial console squatting on the port | Only relevant if using GPIO UART instead of USB — not applicable to this build |
| Overloading the panel's +15V supply | Zero draws ~0.35 A at 15V, freed by removing the wireless transceiver; fuse the feed at 1 A; fall back to a GFCI-outlet supply if the rail sags |
| High RS-485 failure rate | Below 5% is normal, often below 1%. Usual causes in order: loose wires, bad adapter, multiple apps competing for the serial port, unstable network bridge, failing equipment |

---

## 8. Verification milestones

Work through these in order. Each one should pass before moving on.

> ✅ **2026-08-29 — BUS IS LIVE, SYSTEM WORKS.** Temp-wired at the panel: njsPC identified the **EasyTouch2 4P** (state 100%), IntelliFlo VS and IntelliChlor IC40 both reporting. Verified from the custom dashboard: pool circuit toggle turns real equipment on/off (milestone 8 ✓), pump runs its programmed 1,900 RPM at ~490 W with live watts logged (9 ✓), IC40 reports Ok at 40% output with salt 2,650 ppm (10 read-side ✓; setpoint-change test pending), water temp goes live with flow. Milestones 4–9 and 11 ✓. Remaining: 10 write-side, 12 (windowed RS-485 error-rate check), permanent wiring/mounting, SD image backup of final state. This build replaced Pentair's ~$1,200 "upgrade kit" path.

1. Zero boots on vendor Ubuntu, WiFi associates and stays up
2. Kernel held, SD image backed up
3. Node 20+ installed and reporting correct version
4. COM-port red terminal voltage measured; buck output verified at 5.0–5.2V *before* the Zero is connected
5. Zero boots from the buck at the pad
6. `/dev/ttyUSB0` appears when SH-U10 is plugged in
7. `od -x < /dev/ttyUSB0` shows repeating `ffa5ff`
8. njsPC starts and connects to the port without errors
9. dashPanel shows correct EasyTouch configuration — circuits, bodies, equipment
10. Circuit toggle from dashPanel actually switches equipment at the pad
11. Pump speed change works
12. Chlorinator output percentage change works
13. njsPC survives a reboot via PM2/systemd
14. RS-485 failure rate confirmed under 5%

---

## 9. Future work

- Custom web UI built against njsPC's REST + WebSocket API, replacing dashPanel
  > 🚧 **IN PROGRESS 2026-08-28** — first version live at `http://192.168.1.221:8080`, source in [`pool-dashboard/`](pool-dashboard/) (deploy: scratchpad `deploy_dashboard.py` + `pm2 restart dashboard`). Node/Express + built-in SQLite; mirrors njsPC over socket.io, logs one sample/min (temps, RPM, watts, chlorinator %, salt ppm), SSE live updates, same-origin proxy to njsPC. UI: dark theme, hero temp, pump card with **real cost from reported watts** (rate configurable), IC40 output slider + salt ppm, light theme swatches, circuit toggles, schedule list, 6h/12h/24h/7d history charts. Runs under PM2 (`dashboard`, boot-persistent). Charts/equipment cards show "collecting data" placeholders until the EasyTouch is on the bus.
- Home Assistant integration via the MQTT binding
- Optional: InfluxDB + Grafana for pool telemetry history

---

## 9a. Recovery procedure

Everything that matters lives on the SD card; the panel holds its own config. Three
scenarios, in order of likelihood.

### A. SD card dies or corrupts (most likely — heat + power cuts)

1. Get the backup: **`orangepi-pool-controller-2026-08-29.img.gz`** (2.24 GB, on
   **Google Drive in the `Poolstuff` folder**; MD5 recorded below). Any 32 GB card
   works — high-endurance preferred.
2. Flash it with **Raspberry Pi Imager** → "Use custom" → pick the `.img.gz` directly
   (no need to un-gzip) → target the card. CLI equivalent:
   `rpi-imager --cli <path>.img.gz \\.\PhysicalDriveN` (elevated).
3. Insert into the Zero at the pad, power up. Nothing else to do: WiFi credentials
   are baked in, PM2 resurrects njsPC + dashboard + dashPanel on boot
   (allow several minutes — njsPC recompiles at startup).
4. Verify: `http://192.168.1.221:8080` names the EasyTouch and the RS-485 footer is
   green. If the IP differs, the router assigned a new lease — check the router's
   client list (hostname `orangepizero2w`), and set a **DHCP reservation** for the
   Zero's MAC to pin 192.168.1.221 permanently (recommended).
5. Caveats: telemetry history restores only to the backup date (the sampler resumes
   on its own); on a larger-than-32 GB card the extra space sits unused unless
   manually expanded (`sudo growpart` + `resize2fs`) — harmless to skip.

### B. Orange Pi hardware dies

Buy another Zero 2W (2 GB), move the SD card (or flash a fresh card per A), reattach
the antenna and the two USB-C connections per [docs/pad-day-hookup.html](docs/pad-day-hookup.html).
All identity and config is on the card — the board is a commodity.

### C. No usable backup — rebuild from scratch

All source and scripts are in this repo ([tools/](tools/)) plus the vendor image:

1. Vendor Ubuntu Noble desktop image: pristine `.7z` per §Phase 0 (re-download from
   Orange Pi's Google Drive if lost). Flash, then bake WiFi in by loop-mounting the
   `.img` in WSL and writing `/etc/NetworkManager/system-connections/pool-wifi.nmconnection`
   (chmod 600, root:root) — see §Phase 0 status notes for the exact file content.
2. Boot, SSH in (`orangepi`/`orangepi` unless changed), hold the kernel:
   `sudo apt-mark hold linux-image-next-sun50iw9 linux-dtb-next-sun50iw9`
3. Run [tools/setup_njspc.sh](tools/setup_njspc.sh) (nvm + Node LTS + njsPC clone +
   npm install), then [tools/setup_dashpanel_pm2.sh](tools/setup_dashpanel_pm2.sh)
   (dashPanel + PM2 + pm2 save), then as root:
   `pm2 startup systemd -u orangepi --hp /home/orangepi` (run the command it prints).
4. Deploy the dashboard from this repo: [tools/deploy_dashboard.py](tools/deploy_dashboard.py)
   (edit HOST/PASS at top if changed), then on the Zero:
   `cd ~/pool-dashboard && npm install && pm2 start server.js --name dashboard && pm2 save`.
5. njsPC serial port is `/dev/ttyUSB0` by default — no config needed with the SH-U10.

[tools/zssh.py](tools/zssh.py) runs any command on the Zero from Windows
(`python tools/zssh.py [--user root] "command"`). **Note:** helper scripts carry the
factory `orangepi` password — update them when production passwords land.

### Backup artifact record

| Item | Value |
|---|---|
| File | `orangepi-pool-controller-2026-08-29.img.gz` |
| Captured | 2026-08-29, post-verification state (EasyTouch live, all services under PM2) |
| Contents | Full 29.7 GB card image, free space zeroed, gzip -1 · **2.25 GB** (2,410,471,826 bytes) |
| MD5 | `40c60d11c2511b3a205ee9595fa18f98` |
| Stored | **Google Drive → `Poolstuff` folder** (also in `images\` locally) |
| Notes | e2fsck clean at capture. Source card has bad sectors in the unpartitioned tail (CRC on raw read; tail zero-padded — no data affected). **Recommend flashing this image to the high-endurance card and retiring the old camera card.** |

---

## 10. Preserved artifacts from the failed adapter

Keep these — they are the only path back to a working Protocol Adapter if one is ever wanted.

- `pentairupdate.exe` — official Pentair updater
  SHA-256: `bc3a19b1b01a0d0aeedfdc85584ef77b6a8ed783e0d0befeb4f3291761afa3ba`
- `pool.bin` — extracted Pentair 5.2.738 application firmware, 226,080 bytes
- `UDPDownload.exe` — Pentair Ethernet firmware loader

**Warning on `pool.bin`:** it is the Pentair application image consumed by Pentair's UDP downloader. It is **not** a raw full-flash image and must not be blindly written as one. Any future Rabbit cold-boot repair must first understand the flash layout and preserve the Rabbit System ID / User block.

### Reference data for the failed adapter

- Protocol Adapter MAC: `00:13:A2:22:67:BB`
- Previously held IP: `192.168.1.119`
- ScreenLogic wireless pair ID: `0003EF4B`
- Pentair service/recovery address: `192.168.2.2`
- Rabbit `J2` orientation established: bottom-left pin nearest `R24` is **pin 2 (GND)**; pin 9 = SMODE0, pin 10 = SMODE1
- Digi programming cables: `20-101-1183` (USB), `20-101-0542` (serial)
- Digi software: Dynamic C 9.62A, Rabbit Field Utility (RFU)

---

## 11. Key references

- njsPC: https://github.com/tagyoureit/nodejs-poolController
- njsPC RS-485 adapter wiki: https://github.com/tagyoureit/nodejs-poolController/wiki/RS-485-Adapter-Details
- dashPanel: https://github.com/rstrouse/nodejs-poolController-dashPanel
- SH-U10 product page: https://www.amazon.com/DSD-TECH-SH-U10-Converter-Compatible/dp/B078X5H8H7

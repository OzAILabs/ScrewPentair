# ScrewPentair

Replacing a dead Pentair ScreenLogic Protocol Adapter with an Orange Pi Zero 2W
running [nodejs-poolController](https://github.com/tagyoureit/nodejs-poolController),
wired straight into the EasyTouch RS-485 bus — plus a custom modern dashboard.

## Contents

- **[Pentair_njsPC_Build_Plan.md](Pentair_njsPC_Build_Plan.md)** — the complete build
  plan and running log: hardware, wiring (including powering the Pi from the panel's
  +15V COM-port supply), software phases, verification milestones, and status.
- **[pool-dashboard/](pool-dashboard/)** — custom web UI that replaces dashPanel.
  Node/Express + SQLite (via `node:sqlite`), mirrors njsPC over socket.io, logs
  minute-by-minute history, serves a dark single-page dashboard with live SSE updates:
  hero water temp, pump RPM/watts with real energy cost, IC40 salt + output slider,
  light color themes, circuit toggles, schedules, history charts.

## Deployment target

Orange Pi Zero 2W (vendor Ubuntu Noble, kernel held), all services under PM2:
`njsPC` (:4200), `dashPanel` (:5150, diagnostic), `dashboard` (:8080).

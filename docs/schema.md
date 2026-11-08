# Flight log database schema

SQLite, one file on the Railway volume (`DB_PATH=/data/flightlog.db`). `db.js` builds every table on startup if it's missing, so a blank volume sets itself up. Seed rows go in only when a table is empty.

## Tables

### aircraft
One row per drone. Seeded with the Blinory HK55 (199 g, "exempt <250 g").

| Column | Type | Notes |
|---|---|---|
| name | text, unique | Shown in the flight form dropdown |
| make_model, serial | text | |
| weight_g | integer | |
| registration | text | Defaults to "exempt <250 g"; change to the FAA number before flying Part 107 |
| remote_id | text | Remote ID serial, if any |
| active | 0/1 | Hide retired aircraft from the form |
| notes | text | |

### batteries
| Column | Type | Notes |
|---|---|---|
| label | text, unique | e.g. B1 |
| aircraft_id | → aircraft | Which drone it fits |
| capacity_mah | integer | |
| in_service_date, retired_date | date | Retired batteries drop out of the form |
| notes | text | Puffing, damage, etc. |

### locations
| Column | Type | Notes |
|---|---|---|
| name | text, unique | Field name |
| lat, lon | real | |
| airspace | G, E, D, C, B | Usual class here; pre-fills the flight form |
| laanc_ceiling_ft | 0–400 | LAANC grid ceiling, for spots under JAN Class C |
| notes | text | |

### flights
One row per battery. A battery swap starts a new entry.

| Column | Type | Notes |
|---|---|---|
| flight_date, start_time | date, HH:MM | Local takeoff |
| end_date, end_time | date, HH:MM | Local landing; end_date differs only past midnight |
| minutes | integer, computed | The database works it out; 23:50 → 00:15 the next day = 25 |
| rule | 44809 or 107 | Recreational until the Part 107 certificate is in hand |
| aircraft_id | → aircraft | Required |
| registration | text | Copied from the aircraft when the flight is saved, so old flights keep "exempt <250 g" after you register |
| battery_id | → batteries | |
| location_id / location_text | → locations / text | One is required; text covers a one-off lat/long |
| airspace | G, E, D, C, B | Required |
| auth | text | LAANC or DroneZone number |
| max_alt_ft | 0–400 | Over 400 is rejected |
| wind_mph, gust_mph, temp_f | integer | |
| wx | text | Sky and anything else |
| practice | text | Maneuvers practiced |
| notes | text | Issues, incidents |

The database rejects a landing before takeoff, a flight longer than one day, a malformed time, and altitude over 400 ft.

### certifications
Seeded with four rows:

| Name | Status |
|---|---|
| TRUST certificate (UAV Coach, UAVC14180509051, 2026-11-05) | done |
| CAPR 70-4 sUAS Flight Exam (2026-11-05) | done |
| FAA Part 107 Remote Pilot | open; recurrent training every 24 calendar months once earned |
| FEMA IS-5 Hazmat Awareness | open |

## View

**battery_usage**: flights, total minutes and last-used date per battery, for cycle tracking.

## Not here yet

- Login sessions: the SQLite session store creates its own table when the server is added.
- v1 import: a script that refuses to run if `flights` already has rows.

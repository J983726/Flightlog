// db.js — SQLite connection and schema for the sUAS flight log.
// Runs CREATE TABLE IF NOT EXISTS on every start, so a blank volume builds itself.
// Seed rows go in only when their table is empty.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'flightlog.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Say where the data lives, and warn loudly if it isn't on the Railway volume
// (anything off the volume is erased on every deploy).
console.log(`Database file: ${DB_PATH}`);
const MOUNT = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (process.env.RAILWAY_ENVIRONMENT) {
  if (!MOUNT) {
    console.warn('WARNING: no Railway volume attached. Flights will be lost on the next deploy.');
  } else if (!path.resolve(DB_PATH).startsWith(path.resolve(MOUNT) + path.sep)) {
    console.warn(`WARNING: DB_PATH is not on the volume (mounted at ${MOUNT}). Flights will be lost on the next deploy.`);
  } else {
    console.log(`Volume OK: mounted at ${MOUNT}`);
  }
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS aircraft (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,              -- what shows in the dropdown, e.g. "Blinory HK55"
  make_model     TEXT,
  serial         TEXT,
  weight_g       INTEGER CHECK (weight_g IS NULL OR weight_g > 0),
  registration   TEXT NOT NULL DEFAULT 'exempt <250 g', -- FAA number once flown under Part 107
  remote_id      TEXT,                              -- Remote ID serial, if any
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS batteries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL UNIQUE,             -- e.g. "B1"
  aircraft_id     INTEGER REFERENCES aircraft(id) ON DELETE SET NULL,
  capacity_mah    INTEGER CHECK (capacity_mah IS NULL OR capacity_mah > 0),
  in_service_date TEXT,                             -- YYYY-MM-DD
  retired_date    TEXT,                             -- YYYY-MM-DD; NULL = in service
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,                 -- field name
  lat         REAL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lon         REAL CHECK (lon IS NULL OR lon BETWEEN -180 AND 180),
  airspace    TEXT CHECK (airspace IS NULL OR airspace IN ('G','E','D','C','B')), -- usual class here
  laanc_ceiling_ft INTEGER CHECK (laanc_ceiling_ft IS NULL OR laanc_ceiling_ft BETWEEN 0 AND 400),
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flights (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_date   TEXT NOT NULL,                      -- local date of takeoff, YYYY-MM-DD
  start_time    TEXT NOT NULL,                      -- HH:MM, local
  end_date      TEXT NOT NULL,                      -- local date of landing; same as flight_date unless past midnight
  end_time      TEXT NOT NULL,                      -- HH:MM, local
  minutes       INTEGER GENERATED ALWAYS AS (
                  CAST(round((julianday(end_date || ' ' || end_time)
                            - julianday(flight_date || ' ' || start_time)) * 1440) AS INTEGER)
                ) STORED,
  rule          TEXT NOT NULL DEFAULT '44809' CHECK (rule IN ('44809','107')),
  aircraft_id   INTEGER NOT NULL REFERENCES aircraft(id) ON DELETE RESTRICT,
  registration  TEXT NOT NULL,                      -- copied from aircraft at entry time, so old flights keep "exempt <250 g"
  battery_id    INTEGER REFERENCES batteries(id) ON DELETE RESTRICT,
  location_id   INTEGER REFERENCES locations(id) ON DELETE RESTRICT,
  location_text TEXT,                               -- free-text fallback, e.g. lat/long for a one-off spot
  airspace      TEXT NOT NULL CHECK (airspace IN ('G','E','D','C','B')),
  auth          TEXT,                               -- LAANC or DroneZone authorization number
  max_alt_ft    INTEGER CHECK (max_alt_ft IS NULL OR max_alt_ft BETWEEN 0 AND 400),
  wind_mph      INTEGER CHECK (wind_mph IS NULL OR wind_mph >= 0),
  gust_mph      INTEGER CHECK (gust_mph IS NULL OR gust_mph >= 0),
  temp_f        INTEGER,
  wx            TEXT,                               -- sky and anything else about the weather
  practice      TEXT,                               -- maneuvers practiced
  notes         TEXT,                               -- issues, incidents
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  CHECK (julianday(end_date || ' ' || end_time) > julianday(flight_date || ' ' || start_time)),
  CHECK (julianday(end_date) - julianday(flight_date) <= 1),
  CHECK (location_id IS NOT NULL OR location_text IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_flights_date     ON flights(flight_date, start_time);
CREATE INDEX IF NOT EXISTS idx_flights_aircraft ON flights(aircraft_id);
CREATE INDEX IF NOT EXISTS idx_flights_battery  ON flights(battery_id);

CREATE TABLE IF NOT EXISTS certifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  issuer        TEXT,
  number        TEXT,                               -- token, certificate or course number
  issued_date   TEXT,                               -- YYYY-MM-DD
  expires_date  TEXT,                               -- YYYY-MM-DD; NULL = never expires
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','expired')),
  notes         TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Flights and minutes per battery, for cycle tracking.
CREATE VIEW IF NOT EXISTS battery_usage AS
SELECT b.id, b.label, b.retired_date,
       COUNT(f.id)                AS flights,
       COALESCE(SUM(f.minutes),0) AS minutes,
       MAX(f.flight_date)         AS last_used
FROM batteries b
LEFT JOIN flights f ON f.battery_id = b.id
GROUP BY b.id;
`);

// Seed data, only when the table is empty.
const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

if (count('aircraft') === 0) {
  db.prepare(`INSERT INTO aircraft (name, make_model, weight_g, registration, notes)
              VALUES (?, ?, ?, ?, ?)`).run(
    'Blinory HK55',
    'Blinory HK55 foldable GPS quadcopter, brushless, WiFi FPV',
    199,
    'exempt <250 g',
    'From CAP summer encampment 2026. Weighed 199 g with battery. Needs FAA registration before any Part 107 flight.'
  );
}

if (count('certifications') === 0) {
  const ins = db.prepare(`INSERT INTO certifications
    (name, issuer, number, issued_date, expires_date, status, notes, sort_order)
    VALUES (@name, @issuer, @number, @issued_date, @expires_date, @status, @notes, @sort_order)`);
  const seed = db.transaction((rows) => rows.forEach((r) => ins.run(r)));
  seed([
    { name: 'TRUST certificate', issuer: 'UAV Coach', number: 'UAVC14180509051',
      issued_date: '2026-11-05', expires_date: null, status: 'done',
      notes: 'Never expires. Keep a copy with the drone.', sort_order: 1 },
    { name: 'CAPR 70-4 sUAS Flight Exam', issuer: 'Civil Air Patrol (Absorb LMS)', number: null,
      issued_date: '2026-11-05', expires_date: null, status: 'done',
      notes: 'CAPID 692796.', sort_order: 2 },
    { name: 'FAA Part 107 Remote Pilot', issuer: 'FAA', number: null,
      issued_date: null, expires_date: null, status: 'open',
      notes: 'Knowledge test at an FAA testing center. Recurrent training due every 24 calendar months.', sort_order: 3 },
    { name: 'FEMA IS-5 Hazmat Awareness', issuer: 'FEMA EMI', number: null,
      issued_date: null, expires_date: null, status: 'open',
      notes: 'Needed for CAP sUAS duty.', sort_order: 4 },
  ]);
}

// One-time rename (Nov 8, 2026): the "Waypoint" is a Blinory HK55. Safe to run on every start.
db.prepare(`UPDATE aircraft SET name = 'Blinory HK55',
  make_model = 'Blinory HK55 foldable GPS quadcopter, brushless, WiFi FPV',
  updated_at = datetime('now') WHERE name = 'Waypoint'`).run();

module.exports = db;

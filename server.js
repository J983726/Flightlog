require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const SqliteStore = require('better-sqlite3-session-store')(session);

const db = require('./db');
const requireAuth = require('./middleware/auth');
const { hmm, todayLocal, addDays } = require('./lib/format');

const { ADMIN_PASSWORD_HASH, SESSION_SECRET } = process.env;
if (!ADMIN_PASSWORD_HASH || !SESSION_SECRET) {
  console.error('Missing ADMIN_PASSWORD_HASH or SESSION_SECRET. See .env.example.');
  process.exit(1);
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // Railway sits in front; needed for secure cookies
app.locals.hmm = hmm;

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// Sessions live in the same SQLite file, so a deploy doesn't sign you out.
app.use(session({
  store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

// ---------- Public routes ----------

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Slow down password guessing: 5 misses per IP locks login for 15 minutes.
const misses = new Map();
const LOCK_MS = 15 * 60 * 1000;
function locked(ip) {
  const m = misses.get(ip);
  if (!m) return false;
  if (Date.now() - m.first > LOCK_MS) { misses.delete(ip); return false; }
  return m.n >= 5;
}

app.get('/login', (req, res) => {
  if (req.session.authed) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const ip = req.ip;
  if (locked(ip)) {
    return res.status(429).render('login', { error: 'Too many tries. Wait 15 minutes.' });
  }
  const ok = bcrypt.compareSync(String(req.body.password || ''), ADMIN_PASSWORD_HASH);
  if (!ok) {
    const m = misses.get(ip) || { n: 0, first: Date.now() };
    m.n += 1;
    misses.set(ip, m);
    return res.status(401).render('login', { error: 'Wrong password.' });
  }
  misses.delete(ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Session error');
    req.session.authed = true;
    res.redirect('/');
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- Everything below needs a login ----------

app.use(requireAuth);

const FLIGHT_SELECT = `
  SELECT f.*, a.name AS aircraft_name, b.label AS battery_label, l.name AS location_name
  FROM flights f
  JOIN aircraft a       ON a.id = f.aircraft_id
  LEFT JOIN batteries b ON b.id = f.battery_id
  LEFT JOIN locations l ON l.id = f.location_id`;

const q = {
  flights:   db.prepare(`${FLIGHT_SELECT} ORDER BY f.flight_date DESC, f.start_time DESC, f.id DESC`),
  flight:    db.prepare(`${FLIGHT_SELECT} WHERE f.id = ?`),
  totals:    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(minutes), 0) AS m, MAX(flight_date) AS last FROM flights`),
  monthMin:  db.prepare(`SELECT COALESCE(SUM(minutes), 0) AS m FROM flights WHERE substr(flight_date, 1, 7) = ?`),
  aircraft:  db.prepare(`SELECT * FROM aircraft WHERE active = 1 ORDER BY name`),
  aircraftById: db.prepare(`SELECT * FROM aircraft WHERE id = ?`),
  batteries: db.prepare(`SELECT label, aircraft_id FROM batteries WHERE retired_date IS NULL ORDER BY label`),
  locations: db.prepare(`SELECT name, airspace FROM locations ORDER BY name`),
  batteryAdd: db.prepare(`INSERT INTO batteries (label, aircraft_id) VALUES (?, ?) ON CONFLICT(label) DO NOTHING`),
  batteryId:  db.prepare(`SELECT id FROM batteries WHERE label = ?`),
  locationAdd: db.prepare(`INSERT INTO locations (name, airspace) VALUES (?, ?) ON CONFLICT(name) DO NOTHING`),
  locationId:  db.prepare(`SELECT id FROM locations WHERE name = ?`),
  insert: db.prepare(`INSERT INTO flights
    (flight_date, start_time, end_date, end_time, rule, aircraft_id, registration, battery_id, location_id,
     airspace, auth, max_alt_ft, wind_mph, gust_mph, temp_f, wx, practice, notes)
    VALUES (@flight_date, @start_time, @end_date, @end_time, @rule, @aircraft_id, @registration, @battery_id, @location_id,
     @airspace, @auth, @max_alt_ft, @wind_mph, @gust_mph, @temp_f, @wx, @practice, @notes)`),
  update: db.prepare(`UPDATE flights SET
    flight_date=@flight_date, start_time=@start_time, end_date=@end_date, end_time=@end_time, rule=@rule,
    aircraft_id=@aircraft_id, registration=@registration, battery_id=@battery_id, location_id=@location_id,
    airspace=@airspace, auth=@auth, max_alt_ft=@max_alt_ft, wind_mph=@wind_mph, gust_mph=@gust_mph,
    temp_f=@temp_f, wx=@wx, practice=@practice, notes=@notes, updated_at=datetime('now')
    WHERE id=@id`),
  remove: db.prepare(`DELETE FROM flights WHERE id = ?`),
};

const AIRSPACE = ['G', 'E', 'D', 'C', 'B'];

// Turn the posted form into clean values plus a list of problems.
function readForm(body) {
  const s = (k) => String(body[k] ?? '').trim();
  const v = {
    flight_date: s('flight_date'),
    start_time: s('start_time'),
    end_time: s('end_time'),
    rule: s('rule') || '44809',
    aircraft_id: Number(s('aircraft_id')),
    battery: s('battery'),
    location: s('location'),
    airspace: s('airspace'),
    auth: s('auth'),
    max_alt_ft: s('max_alt_ft'),
    wind_mph: s('wind_mph'),
    gust_mph: s('gust_mph'),
    temp_f: s('temp_f'),
    wx: s('wx'),
    practice: s('practice'),
    notes: s('notes'),
  };
  const errors = [];
  const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.flight_date)) errors.push('Date is required.');
  if (!isTime(v.start_time)) errors.push('Takeoff time must be HH:MM.');
  if (!isTime(v.end_time)) errors.push('Landing time must be HH:MM.');
  if (isTime(v.start_time) && v.start_time === v.end_time) errors.push('Landing time equals takeoff time.');
  if (!['44809', '107'].includes(v.rule)) errors.push('Pick a rule.');
  if (!q.aircraftById.get(v.aircraft_id)) errors.push('Pick an aircraft.');
  if (!v.location) errors.push('Location is required.');
  if (!AIRSPACE.includes(v.airspace)) errors.push('Pick an airspace class.');

  const int = (k, lo, hi, label) => {
    if (v[k] === '') { v[k] = null; return; }
    const n = Number(v[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) errors.push(`${label} must be a whole number from ${lo} to ${hi}.`);
    else v[k] = n;
  };
  int('max_alt_ft', 0, 400, 'Max altitude');
  int('wind_mph', 0, 99, 'Wind');
  int('gust_mph', 0, 99, 'Gusts');
  int('temp_f', -40, 130, 'Temperature');

  // Landing earlier than takeoff means the flight crossed midnight.
  v.end_date = (!errors.length && v.end_time < v.start_time) ? addDays(v.flight_date, 1) : v.flight_date;
  return { v, errors };
}

// Battery and location are typed (with suggestions); new names are created on save.
const saveFlight = db.transaction((v, existing) => {
  let battery_id = null;
  if (v.battery) {
    q.batteryAdd.run(v.battery, v.aircraft_id);
    battery_id = q.batteryId.get(v.battery).id;
  }
  q.locationAdd.run(v.location, v.airspace);
  const location_id = q.locationId.get(v.location).id;

  // Registration is copied at save time. Editing keeps the old value unless the aircraft changed.
  const registration = existing && existing.aircraft_id === v.aircraft_id
    ? existing.registration
    : q.aircraftById.get(v.aircraft_id).registration;

  const row = {
    ...v, battery_id, location_id, registration,
    auth: v.auth || null, wx: v.wx || null, practice: v.practice || null, notes: v.notes || null,
  };
  delete row.battery; delete row.location;
  if (existing) q.update.run({ ...row, id: existing.id });
  else q.insert.run(row);
});

function formData(values, errors, mode) {
  // Active aircraft, plus the flight's own aircraft if it has since been retired.
  const aircraft = q.aircraft.all();
  const current = q.aircraftById.get(Number(values.aircraft_id));
  if (current && !aircraft.some((a) => a.id === current.id)) aircraft.push(current);
  return {
    values, errors, mode,
    aircraft,
    batteries: q.batteries.all(),
    locations: q.locations.all(),
    airspaces: AIRSPACE,
  };
}

function getFlight(req, res) {
  const id = Number(req.params.id);
  const f = Number.isInteger(id) ? q.flight.get(id) : null;
  if (!f) res.status(404).render('not-found');
  return f;
}

app.get('/', (req, res) => {
  const t = q.totals.get();
  const month = todayLocal().slice(0, 7);
  res.render('dashboard', {
    flights: q.flights.all(),
    totals: { flights: t.n, minutes: t.m, last: t.last, month: q.monthMin.get(month).m },
  });
});

// Printable logbook: oldest first, optional date range (?from=YYYY-MM-DD&to=YYYY-MM-DD).
const q_print = db.prepare(`${FLIGHT_SELECT}
  WHERE (@from IS NULL OR f.flight_date >= @from) AND (@to IS NULL OR f.flight_date <= @to)
  ORDER BY f.flight_date ASC, f.start_time ASC, f.id ASC`);
const q_certs = db.prepare(`SELECT name, number, issued_date FROM certifications
  WHERE status = 'done' ORDER BY sort_order`);

app.get('/print', (req, res) => {
  const ymd = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null);
  let from = ymd(req.query.from);
  let to = ymd(req.query.to);
  if (from && to && from > to) [from, to] = [to, from];

  const flights = q_print.all({ from, to });
  const minutes = flights.reduce((sum, f) => sum + f.minutes, 0);

  const today = todayLocal();
  const monthStart = `${today.slice(0, 7)}-01`;
  const [y, m] = today.split('-').map(Number);
  const lastMonthStart = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
  const lastMonthEnd = addDays(monthStart, -1);

  res.render('print', {
    flights, minutes, from, to, today,
    pilot: process.env.PILOT_NAME || 'Jason Mann',
    certs: q_certs.all(),
    ranges: [
      { label: 'All flights', from: null, to: null },
      { label: 'This month', from: monthStart, to: today },
      { label: 'Last month', from: lastMonthStart, to: lastMonthEnd },
      { label: `${y}`, from: `${y}-01-01`, to: `${y}-12-31` },
    ],
  });
});

// /flights/new must come before /flights/:id (the Job Ledger 404 lesson).
app.get('/flights/new', (req, res) => {
  const last = q.flights.get(); // newest flight, to pre-fill the gear and field
  const values = {
    flight_date: todayLocal(), start_time: '', end_time: '',
    rule: last ? last.rule : '44809',
    aircraft_id: last ? last.aircraft_id : (q.aircraft.get() || {}).id,
    battery: last ? last.battery_label || '' : '',
    location: last ? last.location_name || '' : '',
    airspace: last ? last.airspace : 'G',
    auth: '', max_alt_ft: '', wind_mph: '', gust_mph: '', temp_f: '', wx: '', practice: '', notes: '',
  };
  res.render('flight-form', formData(values, [], 'new'));
});

app.post('/flights', (req, res) => {
  const { v, errors } = readForm(req.body);
  if (errors.length) return res.status(400).render('flight-form', formData({ ...req.body, ...v }, errors, 'new'));
  saveFlight(v, null);
  res.redirect('/');
});

app.get('/flights/:id/edit', (req, res) => {
  const f = getFlight(req, res);
  if (!f) return;
  const values = {
    ...f,
    battery: f.battery_label || '',
    location: f.location_name || f.location_text || '',
  };
  for (const k of ['max_alt_ft', 'wind_mph', 'gust_mph', 'temp_f', 'auth', 'wx', 'practice', 'notes']) {
    if (values[k] === null) values[k] = '';
  }
  res.render('flight-form', formData(values, [], 'edit'));
});

app.post('/flights/:id', (req, res) => {
  const f = getFlight(req, res);
  if (!f) return;
  const { v, errors } = readForm(req.body);
  if (errors.length) return res.status(400).render('flight-form', formData({ ...req.body, ...v, id: f.id }, errors, 'edit'));
  saveFlight(v, f);
  res.redirect('/');
});

app.get('/flights/:id/delete', (req, res) => {
  const f = getFlight(req, res);
  if (!f) return;
  res.render('confirm-delete', { f });
});

app.post('/flights/:id/delete', (req, res) => {
  const f = getFlight(req, res);
  if (!f) return;
  q.remove.run(f.id);
  res.redirect('/');
});

// ---------- Aircraft ----------

const qa = {
  list: db.prepare(`SELECT a.*, COUNT(f.id) AS flights, COALESCE(SUM(f.minutes), 0) AS minutes,
                           MAX(f.flight_date) AS last_flight
                    FROM aircraft a LEFT JOIN flights f ON f.aircraft_id = a.id
                    GROUP BY a.id ORDER BY a.active DESC, a.name`),
  byName: db.prepare(`SELECT id FROM aircraft WHERE name = ? AND id <> ?`),
  insert: db.prepare(`INSERT INTO aircraft (name, make_model, serial, weight_g, registration, remote_id, active, notes)
                      VALUES (@name, @make_model, @serial, @weight_g, @registration, @remote_id, @active, @notes)`),
  update: db.prepare(`UPDATE aircraft SET name=@name, make_model=@make_model, serial=@serial, weight_g=@weight_g,
                      registration=@registration, remote_id=@remote_id, active=@active, notes=@notes,
                      updated_at=datetime('now') WHERE id=@id`),
};

function readAircraft(body, id) {
  const s = (k) => String(body[k] ?? '').trim();
  const v = {
    name: s('name'), make_model: s('make_model') || null, serial: s('serial') || null,
    weight_g: s('weight_g'), registration: s('registration') || 'exempt <250 g',
    remote_id: s('remote_id') || null, active: body.retired ? 0 : 1, notes: s('notes') || null,
  };
  const errors = [];
  if (!v.name) errors.push('Name is required.');
  else if (qa.byName.get(v.name, id || 0)) errors.push('Another aircraft already has that name.');
  if (v.weight_g === '') v.weight_g = null;
  else {
    const n = Number(v.weight_g);
    if (!Number.isInteger(n) || n < 1 || n > 25000) errors.push('Weight must be a whole number of grams.');
    else v.weight_g = n;
  }
  return { v, errors };
}

const blankAircraft = { name: '', make_model: '', serial: '', weight_g: '', registration: 'exempt <250 g', remote_id: '', active: 1, notes: '' };

app.get('/aircraft', (req, res) => res.render('aircraft-list', { aircraft: qa.list.all() }));

// /aircraft/new before /aircraft/:id
app.get('/aircraft/new', (req, res) => res.render('aircraft-form', { values: blankAircraft, errors: [], mode: 'new' }));

app.post('/aircraft', (req, res) => {
  const { v, errors } = readAircraft(req.body, 0);
  if (errors.length) return res.status(400).render('aircraft-form', { values: { ...req.body, ...v }, errors, mode: 'new' });
  qa.insert.run(v);
  res.redirect('/aircraft');
});

function getAircraft(req, res) {
  const id = Number(req.params.id);
  const a = Number.isInteger(id) ? q.aircraftById.get(id) : null;
  if (!a) res.status(404).render('not-found');
  return a;
}

app.get('/aircraft/:id/edit', (req, res) => {
  const a = getAircraft(req, res);
  if (!a) return;
  const values = { ...a };
  for (const k of Object.keys(values)) if (values[k] === null) values[k] = '';
  res.render('aircraft-form', { values, errors: [], mode: 'edit' });
});

app.post('/aircraft/:id', (req, res) => {
  const a = getAircraft(req, res);
  if (!a) return;
  const { v, errors } = readAircraft(req.body, a.id);
  if (errors.length) return res.status(400).render('aircraft-form', { values: { ...req.body, ...v, id: a.id }, errors, mode: 'edit' });
  qa.update.run({ ...v, id: a.id });
  res.redirect('/aircraft');
});

app.use((req, res) => res.status(404).render('not-found'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Flight log listening on port ${PORT}`));

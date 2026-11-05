// Small helpers for dates and times. All "local" means Central time (Brandon, MS).
const TZ = 'America/Chicago';

// 135 -> "2:15"
function hmm(minutes) {
  const m = Math.max(0, Number(minutes) || 0);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

// Today's date in Central time, as YYYY-MM-DD.
function todayLocal(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// "2026-11-05" + 1 -> "2026-11-06"
function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = { TZ, hmm, todayLocal, addDays };

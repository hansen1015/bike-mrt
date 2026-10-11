// MRT/LRT card fares, and Singapore-time helpers (peak detection, weekday early-bird discount, fare-review date).
//
// Fare tables: LTA, effective 27 Dec 2025 (https://sbstransit.com.sg/fares-and-concessions, "all other times" column).
// Public Transport Fare Review 2026, effective 26 Dec 2026: adult card +12 cents (up to 3.2 km) / +13 cents (above),
// student and senior/disability concession cards +5 cents. Workfare and cash fares are not modelled.
// Fares depend on the distance travelled, which we estimate from the track length, so the result can be one fare band off.

// Adult card fare by distance band, "all other times". Band 0 = up to 3.2 km, then 1 km bands: 3.3-4.2, 4.3-5.2, ...
const ADULT = [1.28, 1.38, 1.49, 1.59, 1.68, 1.75, 1.82, 1.86, 1.90, 1.94, 1.98, 2.02, 2.07, 2.11, 2.15, 2.20, 2.24, 2.27, 2.30, 2.33,
  2.36, 2.38, 2.40, 2.42, 2.43, 2.44, 2.45, 2.46, 2.47, 2.48, 2.49, 2.50, 2.51, 2.52, 2.53, 2.54, 2.55, 2.56]; // band 37 = 39.3-40.2 km
const ADULT_OVER_40 = 2.57;
// Concession cards: bands up to 3.2, 4.2, 5.2, 6.2, 7.2 km, then one fare for anything longer
const STUDENT = [0.52, 0.60, 0.66, 0.71, 0.74, 0.78];
const SENIOR = [0.69, 0.79, 0.87, 0.94, 1.00, 1.07];
const EARLY_BIRD = 0.50;                 // weekdays before 7:45 am, all card types listed above are this much cheaper
const REVIEW_2026 = '2026-12-26';        // first day of the 2026 fare review fares

export const FARE_TYPES = { adult: 'Adult', student: 'Student', senior: 'Senior / disability' };

// ---- Singapore clock ----
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// `value`: undefined/'' = right now (Singapore time), or a "YYYY-MM-DDTHH:mm" string read as Singapore local time.
export function sgClock(value, now = new Date()) {
  let y, mo, d, h, mi;
  if (value) {
    [y, mo, d, h, mi] = value.match(/\d+/g).map(Number);
  } else {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
    [y, mo, d, h, mi] = [+parts.year, +parts.month, +parts.day, +parts.hour, +parts.minute];
  }
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { iso, dow, day: DAYS[dow], minutes: h * 60 + mi, h, mi };
}

// Peak = weekdays 7:00-9:00 and 17:00-19:00 (LTA quotes 2-3 min trains in the peaks, about 5 min otherwise).
// Public holidays are not known to the app, so they count as ordinary weekdays/weekends.
export function timeInfo(clock) {
  const weekday = clock.dow >= 1 && clock.dow <= 5;
  const m = clock.minutes;
  const peak = weekday && ((m >= 7 * 60 && m < 9 * 60) || (m >= 17 * 60 && m < 19 * 60));
  const earlyBird = weekday && m < 7 * 60 + 45;
  const hh = clock.h % 12 || 12, ampm = clock.h < 12 ? 'am' : 'pm';
  return { peak, earlyBird, weekday, label: `${peak ? 'Peak' : 'Off-peak'} · ${clock.day} ${hh}:${String(clock.mi).padStart(2, '0')} ${ampm}` };
}

// ---- fares ----
const band = km => (km <= 3.2 ? 0 : Math.ceil(Math.round((km - 3.2) * 10) / 10));   // 3.3-4.2 -> 1, ... (rounded to 0.1 km first)

// Fare in dollars for one rail journey of `km`, or null for an unknown fare type.
export function railFare(km, { type = 'adult', earlyBird = false, date = '' } = {}) {
  const b = band(km);
  let f;
  if (type === 'adult') f = b < ADULT.length ? ADULT[b] : ADULT_OVER_40;
  else if (type === 'student') f = STUDENT[Math.min(b, STUDENT.length - 1)];
  else if (type === 'senior') f = SENIOR[Math.min(b, SENIOR.length - 1)];
  else return null;
  if (date >= REVIEW_2026) f += type === 'adult' ? (b === 0 ? 0.12 : 0.13) : 0.05;
  if (earlyBird) f -= EARLY_BIRD;
  return Math.round(f * 100) / 100;
}

// Length of a [[lat, lon], ...] polyline in km.
export function polyKm(coords) {
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    const [a, b] = [coords[i - 1], coords[i]];
    km += Math.hypot((b[0] - a[0]) * 111.195, (b[1] - a[1]) * 111.195 * Math.cos(a[0] * Math.PI / 180));
  }
  return km;
}

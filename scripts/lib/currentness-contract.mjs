// Project 04: read-only, cross-category currentness semantics.
// This pure evaluator does not grant publication, directory, or Home eligibility.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_ZONE = 'Atlantic/Cape_Verde';

function validDay(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
function requireInstant(value) {
  if (typeof value !== 'string' || !STAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('CURRENTNESS_INVALID_INSTANT: timestamp must include a verified UTC offset');
  }
  const parts = STAMP.exec(value);
  if (!validDay(parts[1]) || +parts[2] > 23 || +parts[3] > 59 || +parts[4] > 59) {
    throw new Error('CURRENTNESS_INVALID_INSTANT: invalid civil date or time');
  }
  const milliseconds = Date.parse(value);
  return milliseconds;
}
function localParts(instant, zone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'});
  } catch { throw new Error('CURRENTNESS_INVALID_TIME_ZONE'); }
  const p = Object.fromEntries(formatter.formatToParts(instant).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
function calendarDay(instant, zone=DEFAULT_ZONE) { return localParts(instant,zone).slice(0,10); }
function boundary(spec, purpose) {
  if (spec == null) return null;
  if (typeof spec!=='object' || Array.isArray(spec)) throw new Error(`CURRENTNESS_INVALID_${purpose}`);
  if (spec.precision === 'month') {
    if(typeof spec.month!=='string'||!MONTH.test(spec.month)||+spec.month.slice(5)<1||+spec.month.slice(5)>12) throw new Error('CURRENTNESS_INVALID_MONTH');
    return {kind:'review-only',month:spec.month};
  }
  if (spec.precision === 'day') {
    if (!validDay(spec.date)) throw new Error('CURRENTNESS_INVALID_DAY');
    // Cabo Verde is UTC-01, does not observe DST. End dates are inclusive.
    const date = new Date(`${spec.date}T00:00:00Z`);
    if(purpose==='END') date.setUTCDate(date.getUTCDate()+1);
    date.setUTCHours(1,0,0,0);
    return {kind:'instant',at:date.valueOf()};
  }
  if (spec.precision === 'instant') {
    if(typeof spec.time_zone!=='string'||!spec.time_zone.trim()) throw new Error('CURRENTNESS_TIME_ZONE_REQUIRED');
    const at=requireInstant(spec.datetime);
    // The declared local wall time must match the verified instant in its source zone.
    const expected=spec.datetime.slice(0,19);
    if(localParts(new Date(at), spec.time_zone)!==expected) throw new Error('CURRENTNESS_TIME_ZONE_OFFSET_MISMATCH');
    return {kind:'instant',at};
  }
  throw new Error(`CURRENTNESS_UNSUPPORTED_${purpose}_PRECISION`);
}
const iso = milliseconds=> milliseconds == null ? null : new Date(milliseconds).toISOString();
function statusFromEnd(spec, now, zoneDay) {
  if(!spec) return {ended:false,reviewDue:false,expiryInstant:null};
  if(spec.kind==='review-only') return {ended:false,reviewDue:zoneDay>=`${spec.month}-01`,expiryInstant:null};
  return {ended:now>=spec.at,reviewDue:false,expiryInstant:iso(spec.at)};
}
function daysApart(first, second) {
  return Math.round((Date.parse(`${second}T00:00:00Z`)-Date.parse(`${first}T00:00:00Z`))/86400000);
}
/**
 * @param {object} input Read-only normalized record dates: applicationDeadline,
 * activityStart, activityEnd, each null or {precision:'day',date},
 * {precision:'instant',datetime:'ISO-with-offset',time_zone:'IANA/Zone'},
 * or {precision:'month',month:'YYYY-MM'} (review-only).
 * @param {string} asOf Fixed ISO datetime with explicit Z/offset.
 * @returns {object} Derived states; no editorial or publication decisions.
 */
export function evaluateCurrentness(input, asOf, {upcomingDays=60}={}) {
  if(!input || typeof input!=='object'||Array.isArray(input)) throw new Error('CURRENTNESS_INVALID_INPUT');
  if(!Number.isInteger(upcomingDays)||upcomingDays<0) throw new Error('CURRENTNESS_INVALID_WINDOW');
  const now=requireInstant(asOf);
  const today=calendarDay(new Date(now));
  const deadline=boundary(input.applicationDeadline,'END');
  const start=boundary(input.activityStart,'START');
  const end=boundary(input.activityEnd,'END');
  const a=statusFromEnd(deadline,now,today);
  const e=statusFromEnd(end,now,today);
  // Verified activity chronology must not silently contradict itself.
  if(start?.kind==='instant' && end?.kind==='instant' && start.at>=end.at) {
    throw new Error('CURRENTNESS_CONTRADICTORY_ACTIVITY_RANGE');
  }
  let applicationStatus='unknown';
  if(deadline) applicationStatus=a.ended?'closed':deadline.kind==='review-only'?(a.reviewDue?'review-due':'unknown'):'not-closed';
  let activityStatus='unknown';
  if(e.ended) activityStatus='ended';
  else if(start?.kind==='instant') {
    if(now>=start.at) {
      // A known start is not proof the activity is still underway.
      // An exact end establishes the finite underway window; month-only ends
      // become review-due at their review boundary without inventing expiry.
      if(end?.kind==='instant') activityStatus='underway';
      else if(e.reviewDue) activityStatus='review-due';
      else if(input.ongoing===true && !end) activityStatus='ongoing';
      else activityStatus='unknown';
    } else activityStatus=daysApart(today,calendarDay(new Date(start.at)))<=upcomingDays?'upcoming':'future';
  } else if((start?.kind==='review-only' && today>=`${start.month}-01`) || e.reviewDue) activityStatus='review-due';
  else if(input.ongoing===true && !end) activityStatus='ongoing';
  return Object.freeze({applicationStatus, activityStatus, reviewDue:a.reviewDue||e.reviewDue||(start?.kind==='review-only'&&today>=`${start.month}-01`)||false,
    applicationExpiryInstant:a.expiryInstant, activityExpiryInstant:e.expiryInstant,
    // Deliberately never returns or alters canonical identity, eligibility or Home selection.
  });
}

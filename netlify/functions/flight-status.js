// Looks up live flight status: FlightAware AeroAPI first (better data quality,
// free up to $5/month usage on the Personal tier), falling back to AviationStack
// only if FlightAware errors out (bad key, rate-limited, network failure, or a
// billing-related rejection once past the free threshold).
//
// Required environment variables (set in Netlify site settings, same place as
// NETLIFY_SITE_ID / NETLIFY_ACCESS_TOKEN):
//   FLIGHTAWARE_API_KEY   - from a FlightAware AeroAPI Personal-tier signup
//   AVIATIONSTACK_API_KEY - from an Aviationstack free-tier signup
//
// Usage: GET /.netlify/functions/flight-status?flightNo=EK2480&date=2026-08-30
//   flightNo - the flight identifier as stored in the flight master (e.g. "EK2480")
//   date     - ISO date (YYYY-MM-DD) of the scheduled flight, used to disambiguate
//              recurring flight numbers
//
// Returns a normalized shape regardless of which provider answered:
//   { source: 'flightaware'|'aviationstack', status, scheduledArrival, estimatedArrival, actualArrival, gate, terminal }
//
// Status values:
//   cancelled           - flight cancelled
//   landed_on_time      - arrived, within 15 min of scheduled
//   landed_delayed      - arrived, 15+ min later than scheduled
//   arrival_delayed     - en route or on ground, but arrival is now expected
//                         later than originally scheduled (15+ min)
//   active              - en route, arrival still expected on time
//   departure_delayed   - still on the ground, departure itself is running
//                         late (15+ min) - arrival will very likely also slip
//   scheduled           - still on the ground, on time so far
//   unknown             - provider returned something outside the above

const DELAY_THRESHOLD_MIN = 15;

function minutesLate(scheduled, estimated) {
  if (!scheduled || !estimated) return 0;
  const sched = new Date(scheduled), est = new Date(estimated);
  if (isNaN(sched) || isNaN(est)) return 0;
  return (est - sched) / 60000;
}

// Takes a normalized set of fields so both providers can share this logic
// despite using different raw field names.
function computeStatus({ cancelled, scheduledOut, estimatedOut, actualOut, scheduledIn, estimatedIn, actualIn }) {
  if (cancelled) return 'cancelled';
  if (actualIn) {
    const arrivedLateMin = minutesLate(scheduledIn, actualIn);
    return arrivedLateMin >= DELAY_THRESHOLD_MIN ? 'landed_delayed' : 'landed_on_time';
  }

  const arrivalLateMin = minutesLate(scheduledIn, estimatedIn);
  const departureLateMin = minutesLate(scheduledOut, estimatedOut);

  if (actualOut) {
    // Already departed, still en route
    return arrivalLateMin >= DELAY_THRESHOLD_MIN ? 'arrival_delayed' : 'active';
  }
  // Still on the ground
  if (departureLateMin >= DELAY_THRESHOLD_MIN) return 'departure_delayed';
  if (arrivalLateMin >= DELAY_THRESHOLD_MIN) return 'arrival_delayed'; // pre-departure but already predicted late
  return 'scheduled';
}

// Converts a UTC ISO timestamp to the Bangkok-local calendar date (YYYY-MM-DD)
// it falls on. Critical for early-morning Bangkok arrivals/departures (roughly
// midnight-7am Bangkok time), whose UTC timestamp falls on the PREVIOUS UTC
// calendar date - naive string-prefix matching against the UTC timestamp
// silently picks up the wrong day's occurrence of a daily flight number.
function utcToBangkokDateStr(utcIso) {
  const d = new Date(utcIso);
  if (isNaN(d)) return null;
  const bangkok = new Date(d.getTime() + 7 * 60 * 60000);
  return bangkok.toISOString().slice(0, 10);
}

async function queryFlightAware(flightNo, date) {
  const key = process.env.FLIGHTAWARE_API_KEY;
  if (!key) throw new Error('FLIGHTAWARE_API_KEY not configured');

  // Query window must span the full Bangkok-local calendar day for `date`,
  // expressed correctly in UTC terms - Bangkok midnight is 17:00 UTC the
  // PREVIOUS day, not the same calendar date's 00:00 UTC.
  const dateStartUtc = new Date(`${date}T00:00:00Z`).getTime() - 7 * 60 * 60000;
  const dateEndUtc = dateStartUtc + 24 * 60 * 60000;
  const start = new Date(dateStartUtc).toISOString().slice(0, 19) + 'Z';
  const end = new Date(dateEndUtc).toISOString().slice(0, 19) + 'Z';

  const res = await fetch(
    `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(flightNo)}?start=${start}&end=${end}`,
    { headers: { 'x-apikey': key } }
  );
  if (!res.ok) throw new Error(`FlightAware error: ${res.status}`);
  const data = await res.json();

  // Require an exact date match on the scheduled arrival/departure - never
  // fall back to "just pick one," since a recurring flight number can span
  // many different days and showing the wrong day's status would be worse
  // than showing nothing.
  const flights = data.flights || [];
  const match = flights.find(f => {
    const ts = f.scheduled_in || f.scheduled_out;
    return ts && utcToBangkokDateStr(ts) === date;
  });
  if (!match) throw new Error(`FlightAware: no flight found for ${flightNo} on ${date}`);

  const status = computeStatus({
    cancelled: match.cancelled,
    scheduledOut: match.scheduled_out, estimatedOut: match.estimated_out, actualOut: match.actual_out,
    scheduledIn: match.scheduled_in, estimatedIn: match.estimated_in, actualIn: match.actual_in,
  });

  return {
    source: 'flightaware',
    status,
    scheduledArrival: match.scheduled_in,
    estimatedArrival: match.estimated_in,
    actualArrival: match.actual_in,
    gate: match.gate_destination || null,
    terminal: match.terminal_destination || null,
  };
}

async function queryAviationStack(flightNo, date) {
  const key = process.env.AVIATIONSTACK_API_KEY;
  if (!key) throw new Error('AVIATIONSTACK_API_KEY not configured');

  const url = `http://api.aviationstack.com/v1/flights?access_key=${key}&flight_iata=${encodeURIComponent(flightNo)}&flight_date=${date}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok || (body && body.error)) {
    const detail = body && body.error ? `${body.error.code || ''} ${body.error.message || body.error.info || ''}`.trim() : `HTTP ${res.status}`;
    throw new Error(`AviationStack error: ${detail}`);
  }
  const data = body;

  const match = (data.data || [])[0];
  if (!match) throw new Error('AviationStack: no matching flight found');
  // Defense in depth: verify the API's own flight_date filter actually worked,
  // rather than trusting it blindly - never show a different day's status.
  if (match.flight_date && match.flight_date !== date) {
    throw new Error(`AviationStack: returned flight date ${match.flight_date} does not match requested ${date}`);
  }

  const dep = match.departure || {};
  const arr = match.arrival || {};
  const status = match.flight_status === 'cancelled' ? 'cancelled' : computeStatus({
    cancelled: false,
    scheduledOut: dep.scheduled, estimatedOut: dep.estimated, actualOut: dep.actual,
    scheduledIn: arr.scheduled, estimatedIn: arr.estimated, actualIn: arr.actual,
  });

  return {
    source: 'aviationstack',
    status,
    scheduledArrival: arr.scheduled || null,
    estimatedArrival: arr.estimated || null,
    actualArrival: arr.actual || null,
    gate: arr.gate || null,
    terminal: arr.terminal || null,
  };
}

exports.handler = async (event) => {
  const { flightNo, date } = event.queryStringParameters || {};
  if (!flightNo || !date) {
    return { statusCode: 400, body: JSON.stringify({ error: 'flightNo and date are required' }) };
  }

  try {
    const result = await queryFlightAware(flightNo, date);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(result),
    };
  } catch (faErr) {
    // Reactive fallback - FlightAware failed for any reason, try AviationStack
    try {
      const result = await queryAviationStack(flightNo, date);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(result),
      };
    } catch (asErr) {
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          error: 'Both providers failed',
          flightaware: faErr.message,
          aviationstack: asErr.message,
        }),
      };
    }
  }
};

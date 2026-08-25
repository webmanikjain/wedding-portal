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
//   { source: 'flightaware'|'aviationstack', status: 'scheduled'|'active'|'landed'|'cancelled'|'delayed'|'unknown',
//     scheduledArrival, estimatedArrival, actualArrival, gate, terminal }

async function queryFlightAware(flightNo, date) {
  const key = process.env.FLIGHTAWARE_API_KEY;
  if (!key) throw new Error('FLIGHTAWARE_API_KEY not configured');

  // Constrain the query to a tight window around the requested date so we
  // don't have to rely purely on client-side filtering of whatever FlightAware
  // happens to return by default.
  const start = `${date}T00:00:00Z`;
  const endDate = new Date(`${date}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = endDate.toISOString().slice(0, 19) + 'Z';

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
  const match = flights.find(f => (f.scheduled_in || f.scheduled_out || '').startsWith(date));
  if (!match) throw new Error(`FlightAware: no flight found for ${flightNo} on ${date}`);

  let status = 'unknown';
  if (match.cancelled) status = 'cancelled';
  else if (match.actual_in) status = 'landed';
  else if (match.actual_out) status = 'active';
  else if (match.scheduled_in) status = 'scheduled';

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

  const statusMap = { scheduled: 'scheduled', active: 'active', landed: 'landed', cancelled: 'cancelled', incident: 'unknown', diverted: 'unknown' };

  return {
    source: 'aviationstack',
    status: statusMap[match.flight_status] || 'unknown',
    scheduledArrival: match.arrival ? match.arrival.scheduled : null,
    estimatedArrival: match.arrival ? match.arrival.estimated : null,
    actualArrival: match.arrival ? match.arrival.actual : null,
    gate: match.arrival ? match.arrival.gate : null,
    terminal: match.arrival ? match.arrival.terminal : null,
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

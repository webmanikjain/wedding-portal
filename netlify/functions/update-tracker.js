const { getStore } = require('@netlify/blobs');
const seed = require('../../tracker_seed.json');

function getTrackerStore() {
  return getStore({
    name: 'wedding-tracker',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });
}

// Body shape (one of):
//   { type: 'message', guestName, field, value }        field: hotelConfirmationSent | flightConfirmationSent | preArrivalWelcomeSent | preDepartureReminderSent
//   { type: 'transportReceived', guestName, value }     value: true|false  (arrivals - picked up from airport)
//   { type: 'roomCheckedIn', listNum, value }            value: true|false  (arrivals - hotel check-in confirmed)
//   { type: 'transportPickedUp', guestName, value }      value: true|false  (departures - return transport picked up guest from hotel)
//   { type: 'roomCheckedOut', listNum, value }           value: true|false  (departures - hotel checkout confirmed)
//   { type: 'vanPickupTime', vanId, value }              value: 'HH:MM'     (departures - planner-edited per-van pickup time override)
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  try {
    const body = JSON.parse(event.body);
    const store = getTrackerStore();
    let data = await store.get('state-v2', { type: 'json' });
    if (!data) data = seed;
    // Backward-compatible: older saved state predates these fields
    if (!data.transportPickedUp) data.transportPickedUp = {};
    if (!data.roomCheckedOut) data.roomCheckedOut = {};
    if (!data.vanPickupTime) data.vanPickupTime = {};

    if (body.type === 'message') {
      if (!data.messages[body.guestName]) data.messages[body.guestName] = {};
      data.messages[body.guestName][body.field] = body.value;
    } else if (body.type === 'transportReceived') {
      data.transportReceived[body.guestName] = body.value;
    } else if (body.type === 'roomCheckedIn') {
      data.roomCheckedIn[String(body.listNum)] = body.value;
    } else if (body.type === 'transportPickedUp') {
      data.transportPickedUp[body.guestName] = body.value;
    } else if (body.type === 'roomCheckedOut') {
      data.roomCheckedOut[String(body.listNum)] = body.value;
    } else if (body.type === 'vanPickupTime') {
      data.vanPickupTime[body.vanId] = body.value;
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'Unknown type' }) };
    }

    await store.setJSON('state-v2', data);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ ok: true, data }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

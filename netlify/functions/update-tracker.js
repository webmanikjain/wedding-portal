const { getStore } = require('@netlify/blobs');
const seed = require('../../tracker_seed.json');

function getTrackerStore() {
  // See get-tracker.js — auto-config keeps this stable across env-var churn.
  return getStore('wedding-tracker');
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
    // Read back to confirm the write actually persisted (guards against silent
    // blob-store failures that used to leave the frontend thinking a save
    // worked). If the read comes back different, we return 500 so the client
    // can retry instead of assuming success.
    const verifyRead = await store.get('state-v2', { type: 'json' });
    const wroteVal = (
      body.type === 'transportPickedUp' ? (verifyRead && verifyRead.transportPickedUp && verifyRead.transportPickedUp[body.guestName]) :
      body.type === 'roomCheckedOut' ? (verifyRead && verifyRead.roomCheckedOut && verifyRead.roomCheckedOut[String(body.listNum)]) :
      body.type === 'roomCheckedIn' ? (verifyRead && verifyRead.roomCheckedIn && verifyRead.roomCheckedIn[String(body.listNum)]) :
      body.type === 'transportReceived' ? (verifyRead && verifyRead.transportReceived && verifyRead.transportReceived[body.guestName]) :
      body.type === 'vanPickupTime' ? (verifyRead && verifyRead.vanPickupTime && verifyRead.vanPickupTime[body.vanId]) :
      body.type === 'message' ? (verifyRead && verifyRead.messages && verifyRead.messages[body.guestName] && verifyRead.messages[body.guestName][body.field]) :
      undefined
    );
    const persisted = (wroteVal === body.value) || (body.value === false && !wroteVal);
    return {
      statusCode: persisted ? 200 : 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        ok: persisted,
        data: verifyRead || data,
        __backendVersion: 'auto-config-v1',
        __verifyReadShowedValue: wroteVal,
        __persistedCheck: persisted ? 'yes' : 'FAILED_VERIFY_READ_MISMATCH',
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message, stack: err.stack, __backendVersion: 'auto-config-v1' }),
    };
  }
};

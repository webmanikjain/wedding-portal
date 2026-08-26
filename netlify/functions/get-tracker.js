const { getStore } = require('@netlify/blobs');
const seed = require('../../tracker_seed.json');
const pickupDropoff = require('../../pickup_dropoff_data.json');
const NO_PICKUP_SET = new Set(pickupDropoff.noPickupNames);
const NO_DROPOFF_SET = new Set(pickupDropoff.noDropoffNames);

function getTrackerStore() {
  return getStore({
    name: 'wedding-tracker',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });
}

// One-time safe backfill: fills 'No Pickup'/'No Dropoff' ONLY where the
// field is currently blank or the generic 'Ok to send' default - never
// touches anything already marked Yes-Sent or Error, so real planner
// progress is never overwritten.
//
// Pre-Arrival Welcome deliberately has NO 'No Pickup' backfill: unlike
// Flight Confirmation, a no-pickup guest still needs a real Pre-Arrival
// message (the 5b safe-travels variant) - it's not a message to skip, just
// one gated by the same 2-day time window as everyone else. An earlier
// version of this backfill ran on every load and treated 'Ok to send' as
// still-blank, which meant any manual change away from 'No Pickup' got
// silently reverted on the next page load. migrateAwayFromNoPickupPreArrival
// below cleans up any guests still stuck with that stale value.
function backfillPickupDropoff(data) {
  let changed = false;
  for (const name of Object.keys(data.messages)) {
    const m = data.messages[name];
    const isBlankish = (v) => !v || v.toLowerCase() === 'ok to send';
    if (NO_PICKUP_SET.has(name) && isBlankish(m.flightConfirmationSent)) {
      m.flightConfirmationSent = 'No Pickup'; changed = true;
    }
    if (NO_DROPOFF_SET.has(name) && isBlankish(m.preDepartureReminderSent)) {
      m.preDepartureReminderSent = 'No Dropoff'; changed = true;
    }
  }
  return changed;
}

// One-time cleanup: any guest whose Pre-Arrival Welcome is still stuck on
// the old 'No Pickup' value (from before this fix) gets moved to 'Ok to
// send' so they fall into the normal time-gated flow like everyone else.
function migrateAwayFromNoPickupPreArrival(data) {
  let changed = false;
  for (const name of Object.keys(data.messages)) {
    const m = data.messages[name];
    if ((m.preArrivalWelcomeSent || '').toLowerCase() === 'no pickup') {
      m.preArrivalWelcomeSent = 'Ok to send';
      changed = true;
    }
  }
  return changed;
}

exports.handler = async () => {
  try {
    const store = getTrackerStore();
    let data = await store.get('state-v2', { type: 'json' });
    if (!data) {
      // First run - seed from the uploaded Google Tracker export
      data = seed;
      backfillPickupDropoff(data);
      migrateAwayFromNoPickupPreArrival(data);
      if (!data.transportPickedUp) data.transportPickedUp = {};
      if (!data.roomCheckedOut) data.roomCheckedOut = {};
      await store.setJSON('state-v2', data);
    } else {
      const a = backfillPickupDropoff(data);
      const b = migrateAwayFromNoPickupPreArrival(data);
      let c = false;
      if (!data.transportPickedUp) { data.transportPickedUp = {}; c = true; }
      if (!data.roomCheckedOut) { data.roomCheckedOut = {}; c = true; }
      if (a || b || c) await store.setJSON('state-v2', data);
    }
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

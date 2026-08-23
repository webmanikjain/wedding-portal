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
function backfillPickupDropoff(data) {
  let changed = false;
  for (const name of Object.keys(data.messages)) {
    const m = data.messages[name];
    const isBlankish = (v) => !v || v.toLowerCase() === 'ok to send';
    if (NO_PICKUP_SET.has(name) && isBlankish(m.flightConfirmationSent)) {
      m.flightConfirmationSent = 'No Pickup'; changed = true;
    }
    if (NO_PICKUP_SET.has(name) && isBlankish(m.preArrivalWelcomeSent)) {
      m.preArrivalWelcomeSent = 'No Pickup'; changed = true;
    }
    if (NO_DROPOFF_SET.has(name) && isBlankish(m.preDepartureReminderSent)) {
      m.preDepartureReminderSent = 'No Dropoff'; changed = true;
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
      await store.setJSON('state-v2', data);
    } else if (backfillPickupDropoff(data)) {
      // Existing data - backfill only blank/generic fields, save if anything changed
      await store.setJSON('state-v2', data);
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

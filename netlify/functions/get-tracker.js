const { getStore } = require('@netlify/blobs');
const seed = require('../../tracker_seed.json');

function getTrackerStore() {
  return getStore({
    name: 'wedding-tracker',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });
}

exports.handler = async () => {
  try {
    const store = getTrackerStore();
    let data = await store.get('state-v2', { type: 'json' });
    if (!data) {
      // First run - seed from the uploaded Google Tracker export
      data = seed;
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

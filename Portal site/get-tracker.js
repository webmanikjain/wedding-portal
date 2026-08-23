const { getStore } = require('@netlify/blobs');
const seed = require('../../tracker_seed.json');

exports.handler = async () => {
  try {
    const store = getStore('wedding-tracker');
    let data = await store.get('state', { type: 'json' });
    if (!data) {
      // First run - seed from the uploaded Google Tracker export
      data = seed;
      await store.setJSON('state', data);
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

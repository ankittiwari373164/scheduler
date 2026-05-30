// api/clients/[id].js
const { idRoute } = require('../_lib/crud');
const { getCollection } = require('../_lib/db');

// When a client is deleted, also remove their brand details, meta accounts,
// and scheduled posts — same behavior as the localStorage deleteClient().
async function cascade(clientId) {
  const bd = await getCollection('brandDetails');
  const ma = await getCollection('metaAccounts');
  const sp = await getCollection('scheduledPosts');
  await Promise.all([
    bd.deleteMany({ clientId }),
    ma.deleteMany({ clientId }),
    sp.deleteMany({ clientId })
  ]);
}

module.exports = idRoute('clients', cascade);

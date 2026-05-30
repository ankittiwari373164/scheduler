// api/portfolios/[id].js
const { idRoute } = require('../_lib/crud');

// Cascade: when a portfolio is deleted, move its clients to "unassigned" (id=1)
// or simply detach them. For now, we just leave them alone — frontend handles it.
module.exports = idRoute('portfolios');

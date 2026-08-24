require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';

if (!API_KEY) {
  console.warn('\n⚠️  WARNING: No API_KEY set in .env — your history server is UNPROTECTED.');
  console.warn('   Anyone who finds the URL can read/delete your import history.');
  console.warn('   Set API_KEY in your .env file before deploying.\n');
}

app.use(cors()); // extension calls this from a chrome-extension:// origin
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Auth middleware: checks X-Api-Key header against API_KEY ----
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // no key configured = open (dev only)
  const key = req.header('x-api-key') || req.query.key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// ---- Health check (no auth, handy for hosting platforms) ----
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- Create an import record ----
// Called by the extension after every single or bulk import attempt.
app.post('/api/imports', requireApiKey, (req, res) => {
  const b = req.body || {};
  if (!b.title && !b.sku) {
    return res.status(400).json({ error: 'title or sku is required' });
  }

  const id = crypto.randomUUID();
  const stmt = db.prepare(`
    INSERT INTO imports
      (id, sku, title, image, price, compare_at_price, website, vendor, status, message,
       shopify_product_id, shopify_store, shopify_link, batch_id, imported_at)
    VALUES
      (@id, @sku, @title, @image, @price, @compare_at_price, @website, @vendor, @status, @message,
       @shopify_product_id, @shopify_store, @shopify_link, @batch_id, @imported_at)
  `);

  stmt.run({
    id,
    sku: b.sku || null,
    title: b.title || null,
    image: b.image || null,
    price: b.price != null ? String(b.price) : null,
    compare_at_price: b.compareAtPrice != null ? String(b.compareAtPrice) : null,
    website: b.website || 'Shein',
    vendor: b.vendor || null,
    status: b.status || 'success',
    message: b.message || null,
    shopify_product_id: b.shopifyProductId ? String(b.shopifyProductId) : null,
    shopify_store: b.shopifyStore || null,
    shopify_link: b.shopifyLink || null,
    batch_id: b.batchId || null,
    imported_at: b.importedAt || new Date().toISOString()
  });

  const row = db.prepare('SELECT * FROM imports WHERE id = ?').get(id);
  res.status(201).json(row);
});

// ---- List imports (search, filter, paginate) ----
app.get('/api/imports', requireApiKey, (req, res) => {
  const { search = '', status, website, page = '1', limit = '25', sort = 'imported_at', dir = 'desc' } = req.query;

  const allowedSort = ['imported_at', 'title', 'sku', 'website', 'price', 'status'];
  const sortCol = allowedSort.includes(sort) ? sort : 'imported_at';
  const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const conditions = [];
  const params = {};

  if (search) {
    conditions.push('(title LIKE @search OR sku LIKE @search)');
    params.search = `%${search}%`;
  }
  if (status) {
    conditions.push('status = @status');
    params.status = status;
  }
  if (website) {
    conditions.push('website = @website');
    params.website = website;
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
  const offset = (pageNum - 1) * limitNum;

  const total = db.prepare(`SELECT COUNT(*) AS count FROM imports ${whereClause}`).get(params).count;

  const rows = db.prepare(`
    SELECT * FROM imports
    ${whereClause}
    ORDER BY ${sortCol} ${sortDir}
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: limitNum, offset });

  res.json({ data: rows, page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) });
});

// ---- Dashboard stats ----
app.get('/api/stats', requireApiKey, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS c FROM imports').get().c;
  const success = db.prepare("SELECT COUNT(*) AS c FROM imports WHERE status = 'success'").get().c;
  const failed = db.prepare("SELECT COUNT(*) AS c FROM imports WHERE status = 'error'").get().c;
  const today = db.prepare("SELECT COUNT(*) AS c FROM imports WHERE date(imported_at) = date('now')").get().c;
  const last7Days = db.prepare("SELECT COUNT(*) AS c FROM imports WHERE imported_at >= datetime('now', '-7 days')").get().c;

  res.json({ total, success, failed, today, last7Days });
});

// ---- Get single import ----
app.get('/api/imports/:id', requireApiKey, (req, res) => {
  const row = db.prepare('SELECT * FROM imports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// ---- Delete an import record ----
app.delete('/api/imports/:id', requireApiKey, (req, res) => {
  const result = db.prepare('DELETE FROM imports WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: true });
});

// ---- Export all imports as CSV ----
app.get('/api/imports/export/csv', requireApiKey, (req, res) => {
  const rows = db.prepare('SELECT * FROM imports ORDER BY imported_at DESC').all();
  const headers = ['id', 'sku', 'title', 'price', 'compare_at_price', 'website', 'vendor', 'status', 'shopify_product_id', 'shopify_link', 'imported_at'];

  const escapeCsv = (val) => {
    if (val == null) return '';
    const s = String(val);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => escapeCsv(row[h])).join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="import-history.csv"');
  res.send(lines.join('\n'));
});

// ============================================================
// CATALOG — products synced from a Shein collection page,
// browsed/selected in the dashboard, then queued for the
// extension to pick up and import automatically.
// ============================================================

// ---- Bulk-add scraped collection items (called by the extension) ----
app.post('/api/catalog/bulk', requireApiKey, (req, res) => {
  const { collectionUrl, collectionTitle, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items array is required' });
  }

  const insertStmt = db.prepare(`
    INSERT INTO catalog_items
      (id, sku, title, image, price, compare_price, product_url, website, source_collection, status, added_at, updated_at)
    VALUES
      (@id, @sku, @title, @image, @price, @compare_price, @product_url, 'Shein', @source_collection, 'available', @now, @now)
    ON CONFLICT(product_url) DO UPDATE SET
      title = excluded.title,
      image = excluded.image,
      price = excluded.price,
      compare_price = excluded.compare_price,
      updated_at = excluded.updated_at
    WHERE catalog_items.status = 'available'
  `);

  const now = new Date().toISOString();
  let added = 0;
  const tx = db.transaction((rows) => {
    for (const item of rows) {
      if (!item.product_url) continue;
      insertStmt.run({
        id: crypto.randomUUID(),
        sku: item.sku || null,
        title: item.title || null,
        image: item.image || null,
        price: item.price != null ? String(item.price) : null,
        compare_price: item.compare_price != null ? String(item.compare_price) : null,
        product_url: item.product_url,
        source_collection: collectionTitle || collectionUrl || null,
        now
      });
      added++;
    }
  });
  tx(items);

  res.status(201).json({ added, total: items.length });
});

// ---- List catalog items (dashboard "Product Finder") ----
app.get('/api/catalog', requireApiKey, (req, res) => {
  const { search = '', status = 'available', page = '1', limit = '30' } = req.query;

  const conditions = [];
  const params = {};

  if (status && status !== 'all') {
    conditions.push('status = @status');
    params.status = status;
  }
  if (search) {
    conditions.push('(title LIKE @search OR sku LIKE @search)');
    params.search = `%${search}%`;
  }

  const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 30));
  const offset = (pageNum - 1) * limitNum;

  const total = db.prepare(`SELECT COUNT(*) AS count FROM catalog_items ${whereClause}`).get(params).count;
  const rows = db.prepare(`
    SELECT * FROM catalog_items
    ${whereClause}
    ORDER BY added_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit: limitNum, offset });

  res.json({ data: rows, page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) });
});

// ---- Mark selected items as queued (dashboard "Import Selected") ----
app.post('/api/catalog/queue', requireApiKey, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`
    UPDATE catalog_items
    SET status = 'queued', updated_at = datetime('now')
    WHERE id IN (${placeholders}) AND status IN ('available', 'error')
  `);
  const result = stmt.run(...ids);
  res.json({ queued: result.changes });
});

// ---- Extension polls this to find work ----
app.get('/api/catalog/queued', requireApiKey, (req, res) => {
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 5));
  const rows = db.prepare(`
    SELECT * FROM catalog_items WHERE status = 'queued' ORDER BY updated_at ASC LIMIT ?
  `).all(limit);
  res.json({ data: rows });
});

// ---- Extension updates status as it processes each item ----
app.patch('/api/catalog/:id', requireApiKey, (req, res) => {
  const b = req.body || {};
  const allowedStatus = ['available', 'queued', 'importing', 'imported', 'error'];
  const fields = [];
  const params = { id: req.params.id };

  if (b.status && allowedStatus.includes(b.status)) {
    fields.push('status = @status');
    params.status = b.status;
  }
  if (b.message !== undefined) { fields.push('message = @message'); params.message = b.message; }
  if (b.shopifyProductId !== undefined) { fields.push('shopify_product_id = @shopify_product_id'); params.shopify_product_id = String(b.shopifyProductId); }
  if (b.shopifyStore !== undefined) { fields.push('shopify_store = @shopify_store'); params.shopify_store = b.shopifyStore; }
  if (b.shopifyLink !== undefined) { fields.push('shopify_link = @shopify_link'); params.shopify_link = b.shopifyLink; }

  if (fields.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  fields.push("updated_at = datetime('now')");

  const result = db.prepare(`UPDATE catalog_items SET ${fields.join(', ')} WHERE id = @id`).run(params);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });

  const row = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(req.params.id);
  res.json(row);
});

// ---- Remove a catalog item ----
app.delete('/api/catalog/:id', requireApiKey, (req, res) => {
  const result = db.prepare('DELETE FROM catalog_items WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: true });
});


app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Importify History Server running on http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   API base:  http://localhost:${PORT}/api`);
});

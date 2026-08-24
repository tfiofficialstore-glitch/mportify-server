// db.js — SQLite setup. Uses a single file (importify.db) so there is
// nothing extra to install or manage — the file is created automatically
// on first run in the same folder as this script (or DB_PATH if set).
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'importify.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY,
    sku TEXT,
    title TEXT,
    image TEXT,
    price TEXT,
    compare_at_price TEXT,
    website TEXT DEFAULT 'Shein',
    vendor TEXT,
    status TEXT DEFAULT 'success',
    message TEXT,
    shopify_product_id TEXT,
    shopify_store TEXT,
    shopify_link TEXT,
    batch_id TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_imports_imported_at ON imports (imported_at DESC);
  CREATE INDEX IF NOT EXISTS idx_imports_sku ON imports (sku);
  CREATE INDEX IF NOT EXISTS idx_imports_status ON imports (status);

  CREATE TABLE IF NOT EXISTS catalog_items (
    id TEXT PRIMARY KEY,
    sku TEXT,
    title TEXT,
    image TEXT,
    price TEXT,
    compare_price TEXT,
    product_url TEXT UNIQUE NOT NULL,
    website TEXT DEFAULT 'Shein',
    source_collection TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    message TEXT,
    shopify_product_id TEXT,
    shopify_store TEXT,
    shopify_link TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_catalog_status ON catalog_items (status);
  CREATE INDEX IF NOT EXISTS idx_catalog_added_at ON catalog_items (added_at DESC);
`);

module.exports = db;

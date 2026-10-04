'use strict';

// 数据库封装：使用 Node 24 内置的 node:sqlite，无需编译任何原生模块。
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// 数据库文件放在项目根目录的 data/ 下，目录不存在时自动创建（data/ 已被 .gitignore 忽略）。
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// 建表：如果没有 runs 表就创建，字段与 SPEC 要求一致。
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool TEXT,
    model TEXT,
    input TEXT,
    output TEXT,
    elapsed_ms INTEGER,
    created_at TEXT
  );
`);

// 插入一条生成记录，返回新记录的 id。
function insertRun({ tool, model, input, output, elapsedMs }) {
  const stmt = db.prepare(
    `INSERT INTO runs (tool, model, input, output, elapsed_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const result = stmt.run(
    String(tool == null ? '' : tool),
    String(model == null ? '' : model),
    String(input == null ? '' : input),
    String(output == null ? '' : output),
    Number.isFinite(elapsedMs) ? Math.round(elapsedMs) : 0,
    new Date().toISOString()
  );
  return Number(result.lastInsertRowid);
}

// 按时间倒序列出历史记录，limit 限制条数（默认 50，最大 200）。
function listRuns(limit = 50) {
  let n = Number.parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) n = 50;
  if (n > 200) n = 200;
  const stmt = db.prepare(
    `SELECT id, tool, model, input, output, elapsed_ms, created_at
     FROM runs ORDER BY id DESC LIMIT ?`
  );
  return stmt.all(n);
}

// 删除单条历史记录，返回是否真的删掉了。
function deleteRun(id) {
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n)) return false;
  const stmt = db.prepare('DELETE FROM runs WHERE id = ?');
  const result = stmt.run(n);
  return result.changes > 0;
}

module.exports = { insertRun, listRuns, deleteRun, DB_PATH };

// Minimal in-memory stand-in for the MongoDB driver surface used by server/ (NOT a general Mongo emulator).
// Supports: equality + $gt/$gte/$lt/$lte/$ne/$in/$nin/$exists/$or/$and, dotted paths, unique indexes (incl. partial-ish),
// $set/$setOnInsert/$inc/$unset/$push($each,$slice)/$addToSet/$max/$min, upsert, sort/limit, snapshot "transactions".
const clone = (x) => structuredClone(x);
const isOp = (o) => o && typeof o === 'object' && !(o instanceof Date) && !Array.isArray(o) && Object.keys(o).some((k) => k.startsWith('$'));
const num = (x) => (x instanceof Date ? x.getTime() : x);
export const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function setPath(o, p, val) { const ks = p.split('.'); let c = o; for (let i = 0; i < ks.length - 1; i++) { if (c[ks[i]] == null || typeof c[ks[i]] !== 'object') c[ks[i]] = {}; c = c[ks[i]]; } c[ks.at(-1)] = val; }
function unsetPath(o, p) { const ks = p.split('.'); let c = o; for (let i = 0; i < ks.length - 1; i++) { c = c?.[ks[i]]; if (c == null) return; } delete c[ks.at(-1)]; }
const eq = (a, b) => (a instanceof Date || b instanceof Date ? num(a) === num(b) : JSON.stringify(a) === JSON.stringify(b));

function matchValue(val, cond) {
  if (!isOp(cond)) return Array.isArray(val) && !Array.isArray(cond) ? val.some((x) => eq(x, cond)) : eq(val, cond);
  return Object.entries(cond).every(([op, c]) => {
    switch (op) {
      case '$gt': return val != null && num(val) > num(c);
      case '$gte': return val != null && num(val) >= num(c);
      case '$lt': return val != null && num(val) < num(c);
      case '$lte': return val != null && num(val) <= num(c);
      case '$ne': return Array.isArray(val) ? !val.some((x) => eq(x, c)) : !eq(val, c) || (val === undefined && c !== undefined);
      case '$in': return c.some((x) => (Array.isArray(val) ? val.some((y) => eq(y, x)) : eq(val, x)));
      case '$nin': return !c.some((x) => eq(val, x));
      case '$exists': return (val !== undefined) === c;
      case '$type': return c === 'string' ? typeof val === 'string' : true;
      default: throw new Error('fakeDb: unsupported operator ' + op);
    }
  });
}
function match(doc, f) {
  return Object.entries(f).every(([k, c]) => {
    if (k === '$or') return c.some((x) => match(doc, x));
    if (k === '$and') return c.every((x) => match(doc, x));
    return matchValue(getPath(doc, k), c);
  });
}
function applyUpdate(doc, u, inserting) {
  for (const [op, spec] of Object.entries(u)) {
    for (const [p, val] of Object.entries(spec)) {
      switch (op) {
        case '$set': setPath(doc, p, clone(val)); break;
        case '$setOnInsert': if (inserting) setPath(doc, p, clone(val)); break;
        case '$inc': setPath(doc, p, (getPath(doc, p) || 0) + val); break;
        case '$unset': unsetPath(doc, p); break;
        case '$max': { const cur = getPath(doc, p); if (cur === undefined || num(val) > num(cur)) setPath(doc, p, val); break; }
        case '$min': { const cur = getPath(doc, p); if (cur === undefined || num(val) < num(cur)) setPath(doc, p, val); break; }
        case '$addToSet': { const a = getPath(doc, p) || []; if (!a.some((x) => eq(x, val))) a.push(clone(val)); setPath(doc, p, a); break; }
        case '$push': {
          const a = getPath(doc, p) || [];
          if (val && val.$each) { a.push(...clone(val.$each)); if (val.$slice) a.splice(0, Math.max(0, a.length + val.$slice)); } else a.push(clone(val));
          setPath(doc, p, a); break;
        }
        default: throw new Error('fakeDb: unsupported update op ' + op);
      }
    }
  }
}
const dupErr = (n) => Object.assign(new Error(`E11000 duplicate key (${n})`), { code: 11000 });

class Cursor {
  constructor(rows) { this.rows = rows; }
  sort(spec) { const ks = Object.entries(spec); this.rows.sort((a, b) => { for (const [k, d] of ks) { const x = num(getPath(a, k)), y = num(getPath(b, k)); if (x < y) return -d; if (x > y) return d; } return 0; }); return this; }
  limit(n) { this.rows = this.rows.slice(0, n); return this; }
  skip(n) { this.rows = this.rows.slice(n); return this; }
  async toArray() { return this.rows.map(clone); }
}

class Collection {
  constructor(name) { this.name = name; this.docs = []; this.indexes = []; this.seq = 0; }
  async createIndex(keys, opts = {}) { if (opts.unique) this.indexes.push({ keys: Object.keys(keys), partial: !!opts.partialFilterExpression }); return 'ok'; }
  checkUnique(doc, ignore) {
    for (const ix of this.indexes) {
      const vals = ix.keys.map((k) => getPath(doc, k));
      if (vals.some((x) => x === undefined || x === null)) continue;                         // missing key → not indexed (sparse/partial)
      if (this.docs.some((d) => d !== ignore && ix.keys.every((k, i) => eq(getPath(d, k), vals[i])))) throw dupErr(ix.keys.join('+'));
    }
  }
  async findOne(f = {}) { const d = this.docs.find((x) => match(x, f)); return d ? clone(d) : null; }
  find(f = {}) { return new Cursor(this.docs.filter((x) => match(x, f))); }
  async countDocuments(f = {}) { return this.docs.filter((x) => match(x, f)).length; }
  async insertOne(doc) { const d = clone(doc); if (d._id === undefined) d._id = `${this.name}#${++this.seq}`; if (this.docs.some((x) => x._id === d._id)) throw dupErr('_id'); this.checkUnique(d); this.docs.push(d); return { insertedId: d._id }; }
  async insertMany(docs) { for (const d of docs) await this.insertOne(d); return { insertedCount: docs.length }; }
  _upsertBase(f) { const base = {}; for (const [k, c] of Object.entries(f)) if (!k.startsWith('$') && !isOp(c)) setPath(base, k, clone(c)); return base; }
  async updateOne(f, u, opts = {}) {
    const d = this.docs.find((x) => match(x, f));
    if (!d) {
      if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const nd = this._upsertBase(f); applyUpdate(nd, u, true); if (nd._id === undefined) nd._id = `${this.name}#${++this.seq}`;
      this.checkUnique(nd); this.docs.push(nd); return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    const before = JSON.stringify(d), copy = clone(d); applyUpdate(copy, u, false); this.checkUnique(copy, d);
    const changed = JSON.stringify(copy) !== before; if (changed) Object.assign(d, copy), Object.keys(d).forEach((k) => { if (!(k in copy)) delete d[k]; });
    return { matchedCount: 1, modifiedCount: changed ? 1 : 0, upsertedCount: 0 };
  }
  async updateMany(f, u) { let n = 0; for (const d of this.docs.filter((x) => match(x, f))) { const copy = clone(d); applyUpdate(copy, u, false); Object.assign(d, copy); n++; } return { matchedCount: n, modifiedCount: n }; }
  async findOneAndUpdate(f, u, opts = {}) {
    let rows = this.docs.filter((x) => match(x, f));
    if (opts.sort) rows = new Cursor(rows).sort(opts.sort).rows;
    let d = rows[0];
    if (!d) { if (!opts.upsert) return null; await this.updateOne(f, u, { upsert: true }); d = this.docs.at(-1); return opts.returnDocument === 'after' ? clone(d) : null; }
    const before = clone(d), copy = clone(d); applyUpdate(copy, u, false); this.checkUnique(copy, d);
    Object.keys(d).forEach((k) => delete d[k]); Object.assign(d, copy);
    return opts.returnDocument === 'after' ? clone(d) : before;
  }
  async deleteMany(f = {}) { const n = this.docs.length; this.docs = this.docs.filter((x) => !match(x, f)); return { deletedCount: n - this.docs.length }; }
}

export class FakeDb {
  constructor() { this.cols = new Map(); }
  collection(n) { if (!this.cols.has(n)) this.cols.set(n, new Collection(n)); return this.cols.get(n); }
  /** Snapshot/rollback transaction (matches the all-or-nothing semantics the services rely on). */
  async __fakeTxn(fn) {
    const snap = new Map([...this.cols].map(([n, c]) => [n, { docs: clone(c.docs), seq: c.seq }]));
    try { return await fn({ fake: true }); }
    catch (e) { for (const [n, s] of snap) { const c = this.cols.get(n); c.docs = s.docs; c.seq = s.seq; } throw e; }
  }
  async ensureIndexes() {
    const u = (n, ...keys) => keys.forEach((k) => this.collection(n).createIndex(Object.fromEntries(k.map((x) => [x, 1])), { unique: true }));
    u('users', ['uid'], ['wallet.address']); u('player_progress', ['uid']); u('transactions', ['idemKey']); u('withdrawals', ['idemKey']);
    u('game_sessions', ['sid']); u('ad_logs', ['nonce'], ['providerEventId']); u('leaderboard', ['board', 'uid']);
  }
}

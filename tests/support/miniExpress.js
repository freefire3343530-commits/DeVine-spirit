// Tiny Express-compatible shim used ONLY when the real `express` package is not installed (see register.js).
// Implements the subset used by server/: app/Router use/get/post/patch/all, :params, json(), static(), error middleware.
import http from 'node:http';
import { parse } from 'node:url';

function compile(path) { const keys = []; const re = new RegExp('^' + path.replace(/\/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }).replace(/\/$/, '') + '/?$'); return { re, keys }; }
class Router {
  constructor() { this.stack = []; }
  use(a, ...fns) { const [prefix, handlers] = typeof a === 'string' ? [a, fns] : ['', [a, ...fns]]; for (const h of handlers) this.stack.push({ kind: 'use', prefix, h }); return this; }
  _route(method, path, fns) { const c = compile(path); for (const h of fns) this.stack.push({ kind: 'route', method, ...c, h }); return this; }
  get(p, ...f) { return this._route('GET', p, f); } post(p, ...f) { return this._route('POST', p, f); } patch(p, ...f) { return this._route('PATCH', p, f); }
  all(p, ...f) { return this._route('*', p, f); }
  handle(req, res, done) {
    let i = 0; const baseUrl = req.baseUrl || '', origPath = req.path;
    const next = (err) => {
      const layer = this.stack[i++];
      if (!layer) { req.baseUrl = baseUrl; req.path = origPath; return done(err); }
      try {
        if (layer.kind === 'use') {
          const p = layer.prefix;
          if (p && !(req.path === p || req.path.startsWith(p + '/'))) return next(err);
          const saved = req.path; if (p) req.path = req.path.slice(p.length) || '/';
          const after = (e) => { req.path = saved; next(e); };
          if (typeof layer.h.handle === 'function') return err ? after(err) : layer.h.handle(req, res, after);
          if (err) { if (layer.h.length === 4) return layer.h(err, req, res, after); return after(err); }
          if (layer.h.length === 4) return after();
          return layer.h(req, res, after);
        }
        if (err || (layer.method !== '*' && layer.method !== req.method)) return next(err);
        const m = layer.re.exec(req.path); if (!m) return next();
        req.params = Object.fromEntries(layer.keys.map((k, j) => [k, decodeURIComponent(m[j + 1])]));
        return layer.h(req, res, next);
      } catch (e) { next(e); }
    };
    next();
  }
}
function express() {
  const r = new Router(); const app = (req, res) => app.handle(req, res, () => {});
  Object.assign(app, { stack: r.stack, use: r.use.bind(r), get: r.get.bind(r), post: r.post.bind(r), patch: r.patch.bind(r), all: r.all.bind(r), handle: r.handle.bind(r), disable() {}, set() {} });
  app.listen = (port, cb) => { const s = http.createServer((req, res) => handleNode(app, req, res)); return s.listen(port, cb); };
  app.__server = (cb) => http.createServer((req, res) => handleNode(app, req, res));
  return app;
}
function handleNode(app, req, res) {
  const u = parse(req.url, true);
  req.path = u.pathname; req.query = u.query; req.ip = req.headers['x-test-ip'] || req.socket.remoteAddress; req.params = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.set = (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) res.setHeader(a, b); else res.setHeader(k, v); return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => { req.rawBody = Buffer.concat(chunks).toString(); app.handle(req, res, (err) => { res.statusCode = err ? 500 : 404; res.end(); }); });
}
express.Router = () => new Router();
express.json = ({ limit = '100kb' } = {}) => (req, res, next) => {
  const max = parseInt(limit) * 1024;
  if (req.rawBody && req.rawBody.length > max) return next(Object.assign(new Error('too large'), { type: 'entity.too.large' }));
  if (req.rawBody && /json/.test(req.headers['content-type'] || '')) { try { req.body = JSON.parse(req.rawBody); } catch { return next(Object.assign(new Error('bad json'), { type: 'entity.parse.failed' })); } } else req.body = req.body || {};
  next();
};
express.static = () => (_req, _res, next) => next();
export default express;

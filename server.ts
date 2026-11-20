// HTTP front door for forge-prime, built on node:http: bearer auth with a
// small verdict cache, body decoding, and hand-split routing (no regex in
// the dispatch path) to the REST, GraphQL, MCP and git handlers.
import { createServer } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';
import { HttpFault, lookupRepo } from './core.ts';
import { routeRest } from './restapi.ts';
import { handleGraphqlHttp } from './graphql.ts';
import { handleMcpHttp } from './mcp.ts';
import { advertiseRefs, handleUploadPack, handleReceivePack } from './gitserve.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN || '';
const FULL_BEARER = 'Bearer ' + TOKEN;
const JSON_CT = 'application/json; charset=utf-8';
const API_EXTRA = ['X-GitHub-Media-Type', 'github.v3; format=json', 'X-OAuth-Scopes', 'repo, read:org'];
let seq = 0;
const SEED_HEX = Math.floor(Math.random() * 0xffffff).toString(16).toUpperCase().padStart(6, '0');
const verdicts = new Map();

function isAuthed(header) {
  if (!header) return false;
  let v = verdicts.get(header);
  if (v !== undefined) return v;
  v = computeAuth(header);
  if (verdicts.size < 512) verdicts.set(header, v);
  return v;
}
function computeAuth(header) {
  if (TOKEN !== '' && header === FULL_BEARER) return true;
  const sp = header.indexOf(' ');
  if (sp < 0) return false;
  const scheme = header.slice(0, sp).toLowerCase();
  const value = header.slice(sp + 1).trim();
  if (value === '') return false;
  if (scheme === 'bearer' || scheme === 'token') return TOKEN === '' || value === TOKEN;
  if (scheme === 'basic') {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    const user = colon < 0 ? text : text.slice(0, colon);
    const pass = colon < 0 ? '' : text.slice(colon + 1);
    if (TOKEN === '') return text.length > 1;
    return pass === TOKEN || user === TOKEN;
  }
  return false;
}
function frame(status, type, body, extra) {
  const headers = { 'content-type': type, 'x-github-request-id': SEED_HEX + ':' + (++seq).toString(16).toUpperCase().padStart(8, '0') };
  if (extra) for (let i = 0; i + 1 < extra.length; i += 2) headers[extra[i].toLowerCase()] = extra[i + 1];
  const buf = body === undefined || body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  headers['content-length'] = buf.length;
  return { status, headers, buf };
}
function errorFrame(status, message, errors) {
  const body = { message, documentation_url: 'https://docs.github.com/rest', status: String(status) };
  if (errors) body.errors = errors;
  return frame(status, JSON_CT, JSON.stringify(body), status === 401 ? ['WWW-Authenticate', 'Basic realm="forge-prime"'] : undefined);
}
function decodeBody(raw, headers) {
  const enc = headers['content-encoding'];
  if (enc && raw.length) {
    if (/gzip/i.test(enc)) return gunzipSync(raw);
    if (/deflate/i.test(enc)) return inflateSync(raw);
  }
  return raw;
}
function segmentsOf(path) {
  const out = [];
  for (const raw of path.split('/')) {
    if (raw === '') continue;
    if (raw.indexOf('%') < 0) out.push(raw);
    else { try { out.push(decodeURIComponent(raw)); } catch { out.push(raw); } }
  }
  return out;
}
function tryGitRoute(req, path, queryText, body) {
  // shape: /{owner}/{repo}[.git]/{info/refs|git-upload-pack|git-receive-pack}
  const parts = path.split('/');
  if (parts[0] !== '') return null;
  const tail = parts.length === 5 && parts[3] === 'info' && parts[4] === 'refs' ? 'info/refs' : parts.length === 4 ? parts[3] : null;
  if (tail === null) return null;
  if (tail !== 'info/refs' && tail !== 'git-upload-pack' && tail !== 'git-receive-pack') return null;
  if (!isAuthed(req.headers.authorization)) return frame(401, 'text/plain', 'Authentication required\n', ['WWW-Authenticate', 'Basic realm="forge-prime"']);
  let owner = parts[1], name = parts[2];
  try { owner = decodeURIComponent(owner); name = decodeURIComponent(name); } catch {}
  if (name.endsWith('.git')) name = name.slice(0, -4);
  const repo = lookupRepo(owner, name);
  if (!repo) return frame(404, 'text/plain', 'Repository not found.\n');
  let out;
  if (tail === 'info/refs') {
    const service = new URLSearchParams(queryText).get('service');
    if (req.method !== 'GET' && req.method !== 'HEAD') out = { status: 405, type: 'text/plain', body: 'method not allowed\n' };
    else if (service !== 'git-upload-pack' && service !== 'git-receive-pack') out = { status: 403, type: 'text/plain', body: 'dumb HTTP transport is not served; use smart HTTP\n' };
    else out = advertiseRefs(repo, service, req.headers['git-protocol']);
  } else if (req.method !== 'POST') out = { status: 405, type: 'text/plain', body: 'method not allowed\n' };
  else if (tail === 'git-upload-pack') out = handleUploadPack(repo, body);
  else out = handleReceivePack(repo, body);
  return frame(out.status, out.type, out.body, out.headers);
}
function dispatch(req, rawBody) {
  const url = req.url || '/';
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const queryText = q < 0 ? '' : url.slice(q + 1);
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  if (path === '/healthz') return frame(200, JSON_CT, '{"ok":true}');
  const isApi = path.startsWith('/api/v3') && (path.length === 7 || path.charCodeAt(7) === 47);
  const isGql = path === '/api/graphql' || path === '/graphql' || path === '/api/v3/graphql';
  const isMcp = path === '/mcp' || path === '/mcp/';
  try {
    if (!isApi && !isGql && !isMcp) {
      let body;
      try { body = decodeBody(rawBody, req.headers); } catch { return frame(400, 'text/plain', 'request body could not be decoded\n'); }
      const git = tryGitRoute(req, path, queryText, body);
      if (git) return git;
      if (!isAuthed(req.headers.authorization)) return errorFrame(401, 'Requires authentication');
      return errorFrame(404, 'Not Found');
    }
    if (!isAuthed(req.headers.authorization)) {
      if (isMcp) return frame(401, JSON_CT, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } }), ['WWW-Authenticate', 'Bearer realm="forge-prime"']);
      return errorFrame(401, req.headers.authorization ? 'Bad credentials' : 'Requires authentication');
    }
    let body;
    try { body = decodeBody(rawBody, req.headers); } catch { return errorFrame(400, 'Problems parsing JSON'); }
    const base = 'http://' + (req.headers.host || 'localhost');
    if (isMcp) {
      const out = handleMcpHttp({ method, body, base, headers: req.headers });
      return frame(out.status, JSON_CT, out.body, out.headers);
    }
    if (isGql) {
      if (method !== 'POST') return errorFrame(404, 'Not Found');
      const out = handleGraphqlHttp({ body, base });
      return frame(out.status, JSON_CT, out.body, API_EXTRA);
    }
    const ctx = { method, path, segs: segmentsOf(path.slice(7)), query: new URLSearchParams(queryText), body, base };
    const out = routeRest(ctx);
    return frame(out.status, JSON_CT, out.body, out.headers ? API_EXTRA.concat(out.headers) : API_EXTRA);
  } catch (e) {
    if (e instanceof HttpFault) return errorFrame(e.status, e.message, e.errors);
    return errorFrame(500, 'Internal error: ' + String((e && e.message) || e));
  }
}
export function buildServer() {
  return createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const out = dispatch(req, chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
      res.writeHead(out.status, out.headers);
      res.end(req.method === 'HEAD' ? undefined : out.buf);
    });
    req.on('error', () => { try { res.destroy(); } catch {} });
  });
}

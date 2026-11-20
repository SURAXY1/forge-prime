// forge-prime core: shared state, git object store, and the domain operations
// that REST, GraphQL and MCP all funnel through. Everything lives in memory;
// a repository owns its objects, refs, issues and labels.
import { createHash } from 'node:crypto';

export const OWNER_LOGIN = 'adaiversen';
export const OWNER_ID = 1000;
export const OWNER_NAME = 'ada iversen';
export const OWNER_MAIL = 'adaiversen@example.invalid';

export class HttpFault extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors || null;
  }
}
export const fault = (status, message, errors) => new HttpFault(status, message, errors);

// ---------- clocks and ids (deterministic export: no wall time leaks into state) ----------
let tick = 1700000000000;
export function stamp() {
  tick += 1;
  return new Date(tick).toISOString();
}
let repoSeq = 5000;
let thingSeq = 900000;
export function freshThingId() { return thingSeq++; }
export function globalNodeId(kind, n) {
  return Buffer.from('0' + kind.length + ':' + kind + n).toString('base64').replace(/=+$/, '');
}

// ---------- repositories ----------
export const allRepos = new Map();
export const allNodes = new Map();

function keyOf(owner, name) { return (owner + '/' + name).toLowerCase(); }
export function lookupRepo(owner, name) { return allRepos.get(keyOf(owner, name)) || null; }
export function demandRepo(owner, name) {
  const r = lookupRepo(owner, name);
  if (!r) throw fault(404, 'Not Found');
  return r;
}
export function reposOf(owner) {
  const want = owner.toLowerCase();
  const out = [];
  for (const r of allRepos.values()) if (r.owner.toLowerCase() === want) out.push(r);
  return out;
}

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
export function openRepo(owner, input) {
  const name = input && input.name;
  if (typeof name !== 'string' || !NAME_RE.test(name) || name === '.' || name === '..') {
    throw fault(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is missing or invalid' }]);
  }
  if (allRepos.has(keyOf(owner, name))) {
    throw fault(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
  }
  const at = stamp();
  const id = repoSeq++;
  const repo = {
    id, nodeId: globalNodeId('Repository', id), owner, name,
    fullName: owner + '/' + name,
    description: typeof input.description === 'string' ? input.description : null,
    isPrivate: input.private === true,
    homepage: typeof input.homepage === 'string' ? input.homepage : null,
    issuesOn: input.has_issues !== false,
    trunk: 'main',
    createdAt: at, updatedAt: at, pushedAt: at,
    objects: new Map(), refs: new Map(),
    counter: 1,
    items: new Map(), onlyIssues: [], onlyPulls: [],
    labels: new Map(),
    epoch: 0, cache: new Map(), authCache: new Map(), repoJsonText: null, repoJsonBase: '',
  };
  storeObject(repo.objects, 'tree', Buffer.alloc(0));
  allRepos.set(keyOf(owner, name), repo);
  allNodes.set(repo.nodeId, { kind: 'Repository', repo, item: repo });
  return repo;
}
export function dropRepo(repo) {
  allRepos.delete(keyOf(repo.owner, repo.name));
  allNodes.delete(repo.nodeId);
  for (const it of repo.items.values()) {
    allNodes.delete(it.nodeId);
    for (const c of it.comments) allNodes.delete(c.nodeId);
  }
}
export function bump(repo) {
  repo.epoch += 1;
  repo.cache.clear();
  repo.authCache.clear();
  repo.repoJsonText = null;
  repo.updatedAt = stamp();
}
export function trunkTip(repo) { return repo.refs.get('refs/heads/' + repo.trunk) || null; }
export function fixTrunk(repo) {
  if (repo.refs.has('refs/heads/' + repo.trunk)) return;
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/') && (ref === 'refs/heads/main' || ref === 'refs/heads/master')) {
      repo.trunk = ref.slice(11);
      repo.repoJsonText = null;
      return;
    }
  }
}

// ---------- git objects ----------
export const EMPTY_OID = '0000000000000000000000000000000000000000';
export const KIND_NUM = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const NUM_KIND = [null, 'commit', 'tree', 'blob', 'tag'];

export function oidOf(kind, data) {
  const h = createHash('sha1');
  h.update(kind + ' ' + data.length + '\0');
  h.update(data);
  return h.digest('hex');
}
export function storeObject(objects, kind, data) {
  const oid = oidOf(kind, data);
  if (!objects.has(oid)) objects.set(oid, { kind, data, packed: null, decoded: null });
  return oid;
}
export function readTree(objects, oid) {
  const o = objects.get(oid);
  if (!o || o.kind !== 'tree') return null;
  if (o.decoded) return o.decoded;
  const rows = [];
  let p = 0;
  while (p < o.data.length) {
    const sp = o.data.indexOf(0x20, p);
    const nul = o.data.indexOf(0, sp + 1);
    rows.push({ mode: o.data.latin1Slice(p, sp), name: o.data.utf8Slice(sp + 1, nul), oid: o.data.hexSlice(nul + 1, nul + 21) });
    p = nul + 21;
  }
  o.decoded = rows;
  return rows;
}
export function writeTree(objects, rows) {
  const key = (e) => (e.mode === '40000' || e.mode === '040000' ? e.name + '/' : e.name);
  const sorted = rows.slice().sort((a, b) => Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b))));
  const parts = [];
  for (const e of sorted) {
    parts.push(Buffer.from((e.mode === '040000' ? '40000' : e.mode) + ' ' + e.name + '\0'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return storeObject(objects, 'tree', Buffer.concat(parts));
}
export function readCommit(objects, oid) {
  const o = objects.get(oid);
  if (!o || o.kind !== 'commit') return null;
  if (o.decoded) return o.decoded;
  const text = o.data.toString('utf8');
  const cut = text.indexOf('\n\n');
  const head = cut < 0 ? text : text.slice(0, cut);
  const c = { tree: '', parents: [], author: '', committer: '', message: cut < 0 ? '' : text.slice(cut + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) c.tree = line.slice(5);
    else if (line.startsWith('parent ')) c.parents.push(line.slice(7));
    else if (line.startsWith('author ')) c.author = line.slice(7);
    else if (line.startsWith('committer ')) c.committer = line.slice(10);
  }
  o.decoded = c;
  return c;
}
export function splitIdent(line) {
  const m = /^(.*?) <([^>]*)> (\d+)(?: ([+-]\d{4}))?$/.exec(line || '');
  if (!m) return { name: line || '', email: '', time: 0, date: new Date(0).toISOString().replace('.000Z', 'Z') };
  const time = Number(m[3]);
  return { name: m[1], email: m[2], time, date: new Date(time * 1000).toISOString().replace('.000Z', 'Z') };
}
export function peelTag(objects, oid) {
  let cur = oid;
  for (let i = 0; i < 16; i++) {
    const o = objects.get(cur);
    if (!o) return null;
    if (o.kind !== 'tag') return cur;
    const m = /^object ([0-9a-f]{40})/.exec(o.data.latin1Slice(0, 60));
    if (!m) return null;
    cur = m[1];
  }
  return null;
}
export function writeCommit(objects, tree, parents, author, committer, message) {
  let text = 'tree ' + tree + '\n';
  for (const p of parents) text += 'parent ' + p + '\n';
  text += 'author ' + author + '\ncommitter ' + (committer || author) + '\n\n' + message;
  return storeObject(objects, 'commit', Buffer.from(text, 'utf8'));
}
export function findInTree(objects, treeOid, path) {
  if (path === '') return { mode: '40000', oid: treeOid };
  const parts = path.split('/');
  let cur = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const rows = readTree(objects, cur);
    if (!rows) return null;
    const hit = rows.find((e) => e.name === parts[i]);
    if (!hit) return null;
    if (i === parts.length - 1) return hit;
    if (hit.mode !== '40000') return null;
    cur = hit.oid;
  }
  return null;
}
export function spliceTree(objects, treeOid, parts, blobOid, mode) {
  const rows = treeOid ? (readTree(objects, treeOid) || []).slice() : [];
  const name = parts[0];
  const at = rows.findIndex((e) => e.name === name);
  if (parts.length === 1) {
    if (blobOid === null) { if (at >= 0) rows.splice(at, 1); }
    else if (at >= 0) rows[at] = { mode: rows[at].mode === '40000' ? (mode || '100644') : rows[at].mode, name, oid: blobOid };
    else rows.push({ mode: mode || '100644', name, oid: blobOid });
  } else {
    const sub = at >= 0 && rows[at].mode === '40000' ? rows[at].oid : null;
    const next = spliceTree(objects, sub, parts.slice(1), blobOid, mode);
    if (next === null) { if (at >= 0) rows.splice(at, 1); }
    else if (at >= 0) rows[at] = { mode: '40000', name, oid: next };
    else rows.push({ mode: '40000', name, oid: next });
  }
  if (rows.length === 0) return null;
  return writeTree(objects, rows);
}
export function flattenTree(objects, treeOid, prefix, out) {
  const res = out || new Map();
  const rows = treeOid ? readTree(objects, treeOid) : null;
  if (!rows) return res;
  for (const e of rows) {
    if (e.mode === '40000') flattenTree(objects, e.oid, (prefix || '') + e.name + '/', res);
    else res.set((prefix || '') + e.name, { mode: e.mode, oid: e.oid });
  }
  return res;
}
export function treeFromFlat(objects, flat) {
  const root = { dirs: new Map(), files: [] };
  for (const [path, v] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let nx = node.dirs.get(parts[i]);
      if (!nx) { nx = { dirs: new Map(), files: [] }; node.dirs.set(parts[i], nx); }
      node = nx;
    }
    node.files.push({ mode: v.mode, name: parts[parts.length - 1], oid: v.oid });
  }
  const emit = (node) => {
    const rows = node.files.slice();
    for (const [name, child] of node.dirs) rows.push({ mode: '40000', name, oid: emit(child) });
    return writeTree(objects, rows);
  };
  return emit(root);
}
export function reaches(objects, ancestor, tip) {
  if (ancestor === tip) return true;
  const seen = new Set([tip]);
  const stack = [tip];
  while (stack.length) {
    const c = readCommit(objects, stack.pop());
    if (!c) continue;
    for (const p of c.parents) {
      if (p === ancestor) return true;
      if (!seen.has(p)) { seen.add(p); stack.push(p); }
    }
  }
  return false;
}
export function commonBase(objects, a, b) {
  if (a === b) return a;
  const anc = new Set();
  const stack = [a];
  while (stack.length) {
    const oid = stack.pop();
    if (anc.has(oid)) continue;
    anc.add(oid);
    const c = readCommit(objects, oid);
    if (c) for (const p of c.parents) stack.push(p);
  }
  let level = [b];
  const seen = new Set();
  while (level.length) {
    const next = [];
    for (const oid of level) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (anc.has(oid)) return oid;
      const c = readCommit(objects, oid);
      if (c) for (const p of c.parents) next.push(p);
    }
    level = next;
  }
  return null;
}
export function history(objects, tip, limit) {
  const cap = limit || 1e9;
  const out = [];
  const seen = new Set([tip]);
  let frontier = [tip];
  while (frontier.length && out.length < cap) {
    let best = 0, bestTime = -1;
    for (let i = 0; i < frontier.length; i++) {
      const c = readCommit(objects, frontier[i]);
      const t = c ? splitIdent(c.committer).time : 0;
      if (t > bestTime) { bestTime = t; best = i; }
    }
    const oid = frontier.splice(best, 1)[0];
    const c = readCommit(objects, oid);
    if (!c) continue;
    out.push(oid);
    for (const p of c.parents) if (!seen.has(p)) { seen.add(p); frontier.push(p); }
  }
  return out;
}

// ---------- domain operations ----------
export function actorIdent() {
  return OWNER_NAME + ' <' + OWNER_MAIL + '> ' + Math.floor(Date.now() / 1000) + ' +0000';
}
export function moveRef(repo, ref, oid) {
  if (oid === null) repo.refs.delete(ref); else repo.refs.set(ref, oid);
  fixTrunk(repo);
  repo.pushedAt = stamp();
  bump(repo);
}
export function resolveRev(repo, rev) {
  let r = rev || '';
  if (!r) r = repo.trunk;
  const candidates = [];
  if (r.startsWith('refs/')) candidates.push(r);
  candidates.push('refs/heads/' + r, 'refs/tags/' + r);
  if (r.startsWith('heads/') || r.startsWith('tags/')) candidates.push('refs/' + r);
  for (const c of candidates) if (repo.refs.has(c)) return peelTag(repo.objects, repo.refs.get(c));
  if (/^[0-9a-f]{40}$/.test(r) && repo.objects.has(r)) return peelTag(repo.objects, r);
  if (/^[0-9a-f]{7,39}$/.test(r)) {
    for (const [oid, o] of repo.objects) if (o.kind === 'commit' && oid.startsWith(r)) return oid;
  }
  return null;
}
export function shortBranch(input) {
  if (typeof input !== 'string') return '';
  return input.startsWith('refs/heads/') ? input.slice(11) : input;
}
function pathParts(path) {
  const parts = String(path || '').split('/').filter((p) => p !== '');
  if (parts.some((p) => p === '.' || p === '..')) throw fault(422, 'path contains a malformed path component');
  return parts;
}
export function putFile(repo, path, input, content) {
  const parts = pathParts(path);
  if (parts.length === 0) throw fault(422, 'path cannot be empty');
  if (!input || typeof input.message !== 'string' || input.message === '') throw fault(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  const branch = shortBranch(input.branch) || repo.trunk;
  const ref = 'refs/heads/' + branch;
  let parent = repo.refs.get(ref) || null;
  if (!parent && repo.refs.size > 0 && branch !== repo.trunk) {
    parent = repo.refs.get('refs/heads/' + repo.trunk) || null;
    if (!parent) throw fault(404, 'Branch ' + branch + ' not found');
  }
  const objects = repo.objects;
  const parentTree = parent ? readCommit(objects, parent).tree : null;
  const existing = parentTree ? findInTree(objects, parentTree, parts.join('/')) : null;
  if (existing && existing.mode === '40000') throw fault(422, 'path is a directory');
  if (content === null) {
    if (!existing) throw fault(404, 'Not Found');
    if (typeof input.sha !== 'string' || input.sha === '') throw fault(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (input.sha !== existing.oid) throw fault(409, parts.join('/') + ' does not match ' + input.sha);
  } else if (existing) {
    if (typeof input.sha !== 'string' || input.sha === '') throw fault(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (input.sha !== existing.oid) throw fault(409, parts.join('/') + ' does not match ' + input.sha);
  } else if (typeof input.sha === 'string' && input.sha !== '') {
    throw fault(409, parts.join('/') + ' does not match ' + input.sha);
  }
  const blob = content === null ? null : storeObject(objects, 'blob', content);
  let tree = spliceTree(objects, parentTree, parts, blob);
  if (tree === null) tree = storeObject(objects, 'tree', Buffer.alloc(0));
  const who = (p) => (p && typeof p.name === 'string' && typeof p.email === 'string' ? p.name + ' <' + p.email + '> ' + Math.floor(Date.now() / 1000) + ' +0000' : null);
  const committer = who(input.committer) || actorIdent();
  const author = who(input.author) || committer;
  const commit = writeCommit(objects, tree, parent ? [parent] : [], author, committer, input.message);
  moveRef(repo, ref, commit);
  return { commit, blob, created: !existing, path: parts.join('/') };
}
export function addLabel(repo, input) {
  const name = input && input.name;
  if (typeof name !== 'string' || name.trim() === '') throw fault(422, 'Validation Failed', [{ resource: 'Label', code: 'missing_field', field: 'name' }]);
  const key = name.toLowerCase();
  if (repo.labels.has(key)) throw fault(422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
  const id = freshThingId();
  const label = { id, nodeId: globalNodeId('Label', id), name, color: typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed', description: typeof input.description === 'string' ? input.description : null };
  repo.labels.set(key, label);
  bump(repo);
  return label;
}
function resolveLabels(repo, names) {
  if (names === undefined || names === null) return [];
  if (!Array.isArray(names)) throw fault(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'labels' }]);
  const out = [];
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw : raw && typeof raw.name === 'string' ? raw.name : null;
    const label = name === null ? null : repo.labels.get(name.toLowerCase());
    if (!label) throw fault(422, 'Validation Failed', [{ resource: 'Label', code: 'invalid', field: 'name', value: name, message: 'label ' + JSON.stringify(name) + ' does not exist' }]);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}
function spawnItem(repo, kind, title, body) {
  const id = freshThingId();
  const at = stamp();
  const item = { id, nodeId: globalNodeId(kind, id), number: repo.counter++, title, body: typeof body === 'string' ? body : '', state: 'open', stateReason: null, labels: [], comments: [], createdAt: at, updatedAt: at, closedAt: null, pull: null, cachedText: null, cachedBase: '', cachedBuf: null };
  repo.items.set(item.number, item);
  allNodes.set(item.nodeId, { kind, repo, item });
  return item;
}
export function openIssue(repo, input) {
  if (!input || typeof input.title !== 'string' || input.title.trim() === '') throw fault(422, 'Validation Failed', [{ resource: 'Issue', code: 'missing_field', field: 'title' }]);
  const labels = resolveLabels(repo, input.labels);
  const item = spawnItem(repo, 'Issue', input.title, input.body);
  item.labels = labels;
  repo.onlyIssues.push(item);
  bump(repo);
  return item;
}
export function retouch(item) { item.updatedAt = stamp(); item.cachedText = null; item.cachedBuf = null; }
export function changeState(item, state, reason) {
  if (state !== 'open' && state !== 'closed') throw fault(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'state' }]);
  if (item.pull && item.pull.merged && state === 'open') throw fault(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: 'a merged pull request cannot be reopened' }]);
  if (item.state !== state) {
    item.state = state;
    item.closedAt = state === 'closed' ? stamp() : null;
    item.stateReason = state === 'closed' ? reason || 'completed' : null;
    if (item.pull && state === 'closed') item.pull.frozen = true;
  }
  retouch(item);
}
export function patchItem(repo, item, input) {
  if (!input || typeof input !== 'object') throw fault(422, 'Invalid request.');
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || input.title.trim() === '') throw fault(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'title' }]);
    item.title = input.title;
  }
  if (input.body !== undefined) item.body = typeof input.body === 'string' ? input.body : '';
  if (input.labels !== undefined && !item.pull) item.labels = resolveLabels(repo, input.labels);
  if (input.state !== undefined) changeState(item, input.state, typeof input.state_reason === 'string' ? input.state_reason : null);
  retouch(item);
  return item;
}
export function postComment(repo, item, body) {
  if (typeof body !== 'string' || body === '') throw fault(422, 'Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
  const id = freshThingId();
  const at = stamp();
  const c = { id, nodeId: globalNodeId('IssueComment', id), body, createdAt: at, updatedAt: at, issue: item };
  item.comments.push(c);
  allNodes.set(c.nodeId, { kind: 'IssueComment', repo, item: c });
  retouch(item);
  return c;
}
function headOf(repo, head) {
  if (typeof head !== 'string') return '';
  const colon = head.indexOf(':');
  if (colon >= 0) {
    if (head.slice(0, colon).toLowerCase() !== repo.owner.toLowerCase()) return '';
    head = head.slice(colon + 1);
  }
  return shortBranch(head);
}
export function openPull(repo, input) {
  if (!input || typeof input !== 'object') throw fault(422, 'Invalid request.');
  if (typeof input.title !== 'string' || input.title.trim() === '') throw fault(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'missing_field', field: 'title' }]);
  const head = headOf(repo, input.head);
  const base = shortBranch(input.base);
  if (head === '' || !repo.refs.has('refs/heads/' + head)) throw fault(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'head' }]);
  if (base === '' || !repo.refs.has('refs/heads/' + base)) throw fault(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'base' }]);
  if (head === base) throw fault(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: 'head and base must be different branches' }]);
  for (const p of repo.onlyPulls) {
    if (p.state === 'open' && p.pull.head === head && p.pull.base === base) throw fault(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for ' + repo.owner + ':' + head + '.' }]);
  }
  const headSha = repo.refs.get('refs/heads/' + head);
  const baseSha = repo.refs.get('refs/heads/' + base);
  if (headSha === baseSha || reaches(repo.objects, headSha, baseSha)) throw fault(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: 'No commits between ' + base + ' and ' + head }]);
  const item = spawnItem(repo, 'PullRequest', input.title, input.body);
  item.pull = { head, base, headSha, baseSha, merged: false, mergedAt: null, mergeSha: null, draft: input.draft === true, frozen: false, mergeKey: '', mergeOk: null };
  repo.onlyPulls.push(item);
  bump(repo);
  return item;
}
export function liveTips(repo, item) {
  const p = item.pull;
  if (!p.frozen) {
    const h = repo.refs.get('refs/heads/' + p.head);
    const b = repo.refs.get('refs/heads/' + p.base);
    if (h) p.headSha = h;
    if (b) p.baseSha = b;
  }
  return p;
}
export function tryMergeTrees(repo, baseSha, headSha) {
  const objects = repo.objects;
  const fork = commonBase(objects, baseSha, headSha);
  const m = fork ? flattenTree(objects, readCommit(objects, fork).tree) : new Map();
  const b = flattenTree(objects, readCommit(objects, baseSha).tree);
  const h = flattenTree(objects, readCommit(objects, headSha).tree);
  const out = new Map();
  const conflicts = [];
  const paths = new Set([...b.keys(), ...h.keys(), ...m.keys()]);
  for (const path of paths) {
    const mo = m.get(path), bo = b.get(path), ho = h.get(path);
    const mk = mo ? mo.oid + mo.mode : '', bk = bo ? bo.oid + bo.mode : '', hk = ho ? ho.oid + ho.mode : '';
    let pick;
    if (bk === hk || mk === hk) pick = bo;
    else if (mk === bk) pick = ho;
    else { conflicts.push(path); continue; }
    if (pick) out.set(path, pick);
  }
  if (conflicts.length) return { conflicts, fork };
  return { tree: out.size ? treeFromFlat(objects, out) : storeObject(objects, 'tree', Buffer.alloc(0)), fork };
}
export function pullMergeable(repo, item) {
  if (item.pull.merged || item.state !== 'open') return null;
  const p = liveTips(repo, item);
  const key = p.headSha + '|' + p.baseSha;
  if (p.mergeKey !== key) { p.mergeKey = key; p.mergeOk = !tryMergeTrees(repo, p.baseSha, p.headSha).conflicts; }
  return p.mergeOk;
}
export function doMerge(repo, item, input) {
  const opts = input || {};
  const p = liveTips(repo, item);
  if (p.merged || item.state !== 'open') throw fault(405, 'Pull Request is not mergeable');
  const method = typeof opts.merge_method === 'string' ? opts.merge_method.toLowerCase() : 'merge';
  if (!['merge', 'squash', 'rebase'].includes(method)) throw fault(422, 'Invalid request.\n\nmerge_method is not a member of ["merge", "squash", "rebase"].');
  if (typeof opts.sha === 'string' && opts.sha !== '' && opts.sha !== p.headSha) throw fault(409, 'Head branch was modified. Review and try the merge again.');
  const baseRef = 'refs/heads/' + p.base;
  if (!repo.refs.has(baseRef) || !repo.refs.has('refs/heads/' + p.head)) throw fault(405, 'Pull Request is not mergeable');
  const res = tryMergeTrees(repo, p.baseSha, p.headSha);
  if (res.conflicts) throw fault(405, 'Pull Request is not mergeable');
  const title = typeof opts.commit_title === 'string' && opts.commit_title !== '' ? opts.commit_title : method === 'merge' ? 'Merge pull request #' + item.number + ' from ' + repo.owner + '/' + p.head : item.title + ' (#' + item.number + ')';
  const extra = typeof opts.commit_message === 'string' && opts.commit_message !== '' ? opts.commit_message : method === 'merge' ? item.title : '';
  const who = actorIdent();
  const sha = writeCommit(repo.objects, res.tree, method === 'merge' ? [p.baseSha, p.headSha] : [p.baseSha], who, who, extra ? title + '\n\n' + extra : title);
  p.merged = true; p.mergedAt = stamp(); p.mergeSha = sha; p.frozen = true;
  item.state = 'closed'; item.closedAt = p.mergedAt;
  moveRef(repo, baseRef, sha);
  retouch(item);
  return sha;
}
function bagCounts(objects, oldOid, newOid) {
  const lines = (oid) => {
    if (!oid) return [];
    const o = objects.get(oid);
    if (!o) return [];
    const text = o.data.toString('utf8');
    if (text === '') return [];
    const arr = text.split('\n');
    if (arr[arr.length - 1] === '') arr.pop();
    return arr;
  };
  const a = lines(oldOid), b = lines(newOid);
  const bag = new Map();
  for (const l of a) bag.set(l, (bag.get(l) || 0) + 1);
  let additions = 0;
  for (const l of b) { const n = bag.get(l) || 0; if (n > 0) bag.set(l, n - 1); else additions++; }
  let deletions = 0;
  for (const n of bag.values()) deletions += n;
  return { additions, deletions };
}
export function pullFileList(repo, item) {
  const objects = repo.objects;
  const p = liveTips(repo, item);
  let from, to = p.headSha;
  if (p.merged && p.mergeSha) { from = readCommit(objects, p.mergeSha).parents[0] || null; to = p.mergeSha; }
  else from = commonBase(objects, p.baseSha, p.headSha);
  const a = from ? flattenTree(objects, readCommit(objects, from).tree) : new Map();
  const b = flattenTree(objects, readCommit(objects, to).tree);
  const out = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(path), y = b.get(path);
    if (x && y && x.oid === y.oid && x.mode === y.mode) continue;
    const counts = bagCounts(objects, x ? x.oid : null, y ? y.oid : null);
    if (y && counts.additions === 0 && counts.deletions === 0) counts.additions = 1;
    out.push({ sha: y ? y.oid : x.oid, filename: path, status: !x ? 'added' : !y ? 'removed' : 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
  }
  return out;
}

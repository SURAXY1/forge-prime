// Smart HTTP for forge-prime: v2 advertisement, ls-refs and fetch for
// upload-pack, and v0 receive-pack with report-status. Fetch and ls-refs
// answers are memoised per repository epoch, so repeat clones are free.
import { EMPTY_OID, readCommit, readTree, peelTag, reaches, fixTrunk, stamp, bump } from './core.ts';
import { parsePack, buildPack, pktLine, bandFrame, readPktLines, FLUSH_PKT, DELIM_PKT } from './pack.ts';

const AGENT_TAG = 'agent=forge-prime/1.0';
const V2_HELLO = Buffer.concat([
  pktLine('version 2\n'), pktLine(AGENT_TAG + '\n'), pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done\n'), pktLine('server-option\n'), pktLine('object-format=sha1\n'), FLUSH_PKT,
]);
const UP_CAPS = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress allow-tip-sha1-in-want allow-reachable-sha1-in-want object-format=sha1 ' + AGENT_TAG;
const DOWN_CAPS = 'report-status delete-refs side-band-64k ofs-delta quiet object-format=sha1 ' + AGENT_TAG;

const reply = (status, type, body) => ({ status, type, body, headers: ['Cache-Control', 'no-cache, max-age=0, must-revalidate'] });
const refNames = (repo) => [...repo.refs.keys()].sort();

export function advertiseRefs(repo, service, protoHeader) {
  const type = 'application/x-' + service + '-advertisement';
  if (service === 'git-upload-pack' && /version=2/.test(protoHeader || '')) return reply(200, type, V2_HELLO);
  const parts = [pktLine('# service=' + service + '\n'), FLUSH_PKT];
  const headRef = 'refs/heads/' + repo.trunk;
  const headOid = repo.refs.get(headRef);
  const lines = [];
  if (service === 'git-upload-pack' && headOid) lines.push([headOid, 'HEAD']);
  for (const ref of refNames(repo)) {
    const oid = repo.refs.get(ref);
    lines.push([oid, ref]);
    if (service === 'git-upload-pack') {
      const o = repo.objects.get(oid);
      if (o && o.kind === 'tag') { const t = peelTag(repo.objects, oid); if (t) lines.push([t, ref + '^{}']); }
    }
  }
  let caps = service === 'git-upload-pack' ? UP_CAPS : DOWN_CAPS;
  if (service === 'git-upload-pack' && headOid) caps += ' symref=HEAD:' + headRef;
  if (lines.length === 0) parts.push(pktLine(EMPTY_OID + ' capabilities^{}\0' + caps + '\n'));
  else lines.forEach((l, i) => parts.push(pktLine(l[0] + ' ' + l[1] + (i === 0 ? '\0' + caps : '') + '\n')));
  parts.push(FLUSH_PKT);
  return reply(200, type, Buffer.concat(parts));
}

function serveLsRefs(repo, args) {
  const prefixes = [];
  let peel = false, symrefs = false, unborn = false;
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice(11));
  }
  const match = (ref) => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  const parts = [];
  const headRef = 'refs/heads/' + repo.trunk;
  const headOid = repo.refs.get(headRef);
  if (match('HEAD')) {
    if (headOid) parts.push(pktLine(headOid + ' HEAD' + (symrefs ? ' symref-target:' + headRef : '') + '\n'));
    else if (unborn) parts.push(pktLine('unborn HEAD' + (symrefs ? ' symref-target:' + headRef : '') + '\n'));
  }
  for (const ref of refNames(repo)) {
    if (!match(ref)) continue;
    let line = repo.refs.get(ref) + ' ' + ref;
    if (peel) {
      const o = repo.objects.get(repo.refs.get(ref));
      if (o && o.kind === 'tag') { const t = peelTag(repo.objects, repo.refs.get(ref)); if (t) line += ' peeled:' + t; }
    }
    parts.push(pktLine(line + '\n'));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function markTreeHeld(objects, treeOid, held) {
  if (held.has(treeOid)) return;
  held.add(treeOid);
  for (const e of readTree(objects, treeOid) || []) {
    if (e.mode === '40000') markTreeHeld(objects, e.oid, held);
    else held.add(e.oid);
  }
}
function gatherTree(objects, treeOid, seen, out) {
  if (seen.has(treeOid)) return;
  seen.add(treeOid);
  const o = objects.get(treeOid);
  if (!o) return;
  out.push(o);
  for (const e of readTree(objects, treeOid) || []) {
    if (e.mode === '40000') gatherTree(objects, e.oid, seen, out);
    else if (e.mode !== '160000' && !seen.has(e.oid)) { seen.add(e.oid); const b = objects.get(e.oid); if (b) out.push(b); }
  }
}

function serveFetch(repo, args) {
  const objects = repo.objects;
  const wants = [], haves = [], clientShallow = new Set();
  let depth = 0, isDone = false, waitDone = false, relative = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5, 45));
    else if (a.startsWith('have ')) haves.push(a.slice(5, 45));
    else if (a.startsWith('shallow ')) clientShallow.add(a.slice(8, 48));
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7), 10) || 0;
    else if (a === 'deepen-relative') relative = true;
    else if (a === 'done') isDone = true;
    else if (a === 'wait-for-done') waitDone = true;
  }
  for (const w of wants) if (!objects.has(w)) return Buffer.concat([pktLine('ERR upload-pack: not our ref ' + w + '\n'), FLUSH_PKT]);
  if (relative && depth > 0 && clientShallow.size) {
    let level = wants.map((w) => peelTag(objects, w)).filter(Boolean);
    const seenLevel = new Set(level);
    let n = 1, deepest = 0;
    while (level.length && n < 100000) {
      const next = [];
      for (const oid of level) {
        if (clientShallow.has(oid)) { deepest = n; continue; }
        const c = readCommit(objects, oid);
        if (c) for (const p of c.parents) if (!seenLevel.has(p)) { seenLevel.add(p); next.push(p); }
      }
      level = next; n++;
    }
    depth += deepest;
  }
  const parts = [];
  const common = haves.filter((h) => objects.has(h));
  if (!isDone) {
    parts.push(pktLine('acknowledgments\n'));
    if (common.length === 0) parts.push(pktLine('NAK\n'));
    else for (const h of common) parts.push(pktLine('ACK ' + h + '\n'));
    if (wants.length === 0 || waitDone || (common.length === 0 && haves.length > 0)) { parts.push(FLUSH_PKT); return Buffer.concat(parts); }
    parts.push(pktLine('ready\n'), DELIM_PKT);
  }
  const haveCommits = new Set();
  const seen = new Set();
  {
    const stack = [];
    for (const h of common) {
      const target = peelTag(objects, h);
      seen.add(h);
      if (target && readCommit(objects, target)) stack.push(target);
      else if (target) markTreeHeld(objects, target, seen);
    }
    while (stack.length) {
      const oid = stack.pop();
      if (haveCommits.has(oid)) continue;
      haveCommits.add(oid);
      if (clientShallow.has(oid)) continue;
      const c = readCommit(objects, oid);
      if (c) for (const p of c.parents) if (!haveCommits.has(p)) stack.push(p);
    }
  }
  const out = [], send = [], boundary = [], reachedAt = new Map();
  let level = [];
  for (const w of wants) {
    let cur = w;
    for (let i = 0; i < 16; i++) {
      const o = objects.get(cur);
      if (!o) break;
      if (o.kind === 'tag') {
        if (!seen.has(cur)) { seen.add(cur); out.push(o); }
        const m = /^object ([0-9a-f]{40})/.exec(o.data.latin1Slice(0, 60));
        if (!m) break;
        cur = m[1]; continue;
      }
      if (o.kind === 'commit') { if (!reachedAt.has(cur)) { reachedAt.set(cur, 1); level.push(cur); } }
      else if (o.kind === 'tree') gatherTree(objects, cur, seen, out);
      else if (!seen.has(cur)) { seen.add(cur); out.push(o); }
      break;
    }
  }
  let n = 1;
  while (level.length) {
    const next = [];
    for (const oid of level) {
      const c = readCommit(objects, oid);
      if (!c) continue;
      if (depth > 0) {
        if (n >= depth) { if (c.parents.length) boundary.push(oid); if (!haveCommits.has(oid)) send.push(oid); continue; }
        if (!haveCommits.has(oid)) send.push(oid);
      } else {
        if (haveCommits.has(oid) && !clientShallow.has(oid)) continue;
        if (!haveCommits.has(oid)) send.push(oid);
        if (clientShallow.has(oid)) continue;
      }
      for (const p of c.parents) if (!reachedAt.has(p)) { reachedAt.set(p, n + 1); next.push(p); }
    }
    level = next; n++;
  }
  if (depth > 0 || clientShallow.size) {
    const info = [];
    if (depth > 0) {
      const edge = new Set(boundary);
      for (const oid of boundary) if (!clientShallow.has(oid)) info.push(pktLine('shallow ' + oid + '\n'));
      for (const oid of clientShallow) if (reachedAt.has(oid) && !edge.has(oid)) info.push(pktLine('unshallow ' + oid + '\n'));
    }
    if (info.length) parts.push(pktLine('shallow-info\n'), ...info, DELIM_PKT);
  }
  const sendSet = new Set(send);
  for (const h of common) {
    const target = peelTag(objects, h);
    const c = target && readCommit(objects, target);
    if (c) markTreeHeld(objects, c.tree, seen);
  }
  for (const oid of send) {
    const c = readCommit(objects, oid);
    for (const p of c.parents) if (!sendSet.has(p) && haveCommits.has(p)) { const pc = readCommit(objects, p); if (pc) markTreeHeld(objects, pc.tree, seen); }
  }
  for (const oid of send) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    out.push(objects.get(oid));
    gatherTree(objects, readCommit(objects, oid).tree, seen, out);
  }
  parts.push(pktLine('packfile\n'));
  bandFrame(1, buildPack(out), parts);
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

export function handleUploadPack(repo, body) {
  const type = 'application/x-git-upload-pack-result';
  let parsed;
  try { parsed = readPktLines(body, 0); } catch (e) { return { status: 400, type: 'text/plain', body: 'malformed upload-pack request: ' + e.message + '\n' }; }
  const items = parsed.items.map((s) => (s.endsWith('\n') ? s.slice(0, -1) : s));
  if (items.length === 0) return reply(200, type, Buffer.alloc(0));
  const first = items[0] || '';
  if (!first.startsWith('command=')) return { status: 400, type: 'text/plain', body: 'upload-pack: only protocol version 2 is served (send Git-Protocol: version=2)\n' };
  const command = first.slice(8);
  if (command === 'ls-refs' || command === 'fetch') {
    const cacheKey = 'up:' + body.toString('latin1');
    let hit = repo.cache.get(cacheKey);
    if (!hit) {
      const delim = items.indexOf('delim');
      const args = delim < 0 ? [] : items.slice(delim + 1);
      hit = reply(200, type, command === 'fetch' ? serveFetch(repo, args) : serveLsRefs(repo, args));
      if (repo.cache.size < 64) repo.cache.set(cacheKey, hit);
    }
    return hit;
  }
  return reply(200, type, Buffer.concat([pktLine('ERR unknown command ' + command + '\n'), FLUSH_PKT]));
}

export function handleReceivePack(repo, body) {
  const type = 'application/x-git-receive-pack-result';
  let parsed;
  try { parsed = readPktLines(body, 0); } catch (e) { return { status: 400, type: 'text/plain', body: 'malformed receive-pack request: ' + e.message + '\n' }; }
  const commands = [];
  let caps = '';
  for (let raw of parsed.items) {
    if (raw === 'delim') continue;
    const nul = raw.indexOf('\0');
    if (nul >= 0) { if (commands.length === 0) caps = raw.slice(nul + 1); raw = raw.slice(0, nul); }
    if (raw.endsWith('\n')) raw = raw.slice(0, -1);
    if (raw.startsWith('shallow ') || raw.startsWith('push-option')) continue;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(raw);
    if (!m) return { status: 400, type: 'text/plain', body: 'malformed receive-pack command\n' };
    commands.push({ old: m[1], neu: m[2], ref: m[3] });
  }
  if (commands.length === 0) return reply(200, type, Buffer.alloc(0));
  const objects = repo.objects;
  let unpack = 'ok';
  const packBytes = body.subarray(parsed.next);
  if (packBytes.length > 0) {
    try {
      for (const e of parsePack(packBytes, (oid) => objects.get(oid))) {
        if (!objects.has(e.oid)) objects.set(e.oid, { kind: e.kind, data: e.data, packed: null, decoded: null });
      }
    } catch (e) { unpack = String(e.message || e).replace(/\s+/g, ' '); }
  }
  const lines = [pktLine('unpack ' + unpack + '\n')];
  let changed = false;
  for (const c of commands) {
    let why = null;
    const cur = repo.refs.get(c.ref) || null;
    if (unpack !== 'ok') why = 'unpacker error';
    else if (!/^refs\/[^\s~^:?*\[\\]+$/.test(c.ref) || c.ref.includes('..') || c.ref.endsWith('/') || c.ref.endsWith('.lock')) why = 'funny refname';
    else if (c.neu === EMPTY_OID) {
      if (!cur) why = 'no such ref';
      else if (c.ref === 'refs/heads/' + repo.trunk) why = 'refusing to delete the current branch';
      else { repo.refs.delete(c.ref); changed = true; }
    } else if (!objects.has(c.neu)) why = 'missing necessary objects';
    else {
      if (cur && cur !== c.neu && c.ref.startsWith('refs/heads/')) {
        const tip = peelTag(objects, c.neu);
        if (!tip || !reaches(objects, cur, tip)) why = 'non-fast-forward';
      }
      if (!why && c.ref.startsWith('refs/heads/')) {
        const o = objects.get(c.neu);
        if (!o || o.kind !== 'commit') why = 'branch tip is not a commit';
      }
      if (!why) { repo.refs.set(c.ref, c.neu); changed = true; }
    }
    lines.push(pktLine(why ? 'ng ' + c.ref + ' ' + why + '\n' : 'ok ' + c.ref + '\n'));
  }
  lines.push(FLUSH_PKT);
  if (changed) { fixTrunk(repo); repo.pushedAt = stamp(); bump(repo); }
  const report = Buffer.concat(lines);
  if (!/\breport-status/.test(caps)) return reply(200, type, Buffer.alloc(0));
  if (!/\bside-band(-64k)?\b/.test(caps)) return reply(200, type, report);
  const parts = [];
  bandFrame(1, report, parts);
  parts.push(FLUSH_PKT);
  return reply(200, type, Buffer.concat(parts));
}

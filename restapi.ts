// REST v3 routing for forge-prime. Handlers receive a context object and
// return { status, body, headers? }; body may be a string or a Buffer.
import { HttpFault, OWNER_LOGIN, allRepos, demandRepo, lookupRepo, openRepo, dropRepo, reposOf, bump, readCommit, readTree, findInTree, history, peelTag, storeObject, splitIdent, flattenTree } from './core.ts';
import * as C from './core.ts';
import * as V from './views.ts';

const missing = () => new HttpFault(404, 'Not Found');
export function parseJsonBody(ctx) {
  const raw = ctx.body;
  if (!raw || raw.length === 0) return {};
  let v;
  try { v = JSON.parse(raw.toString('utf8')); } catch { throw new HttpFault(400, 'Problems parsing JSON'); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new HttpFault(400, 'Body should be a JSON object');
  return v;
}
const respond = (status, value, headers) => ({ status, body: JSON.stringify(value), headers });
const EMPTY_204 = { status: 204, body: '' };

function paginate(ctx, items) {
  const q = ctx.query;
  let per = parseInt(q.get('per_page') || '30', 10);
  if (!(per >= 1)) per = 30;
  if (per > 100) per = 100;
  let pg = parseInt(q.get('page') || '1', 10);
  if (!(pg >= 1)) pg = 1;
  const last = Math.max(1, Math.ceil(items.length / per));
  const slice = items.slice((pg - 1) * per, pg * per);
  const links = [];
  const mk = (n, rel) => {
    const u = new URLSearchParams(q);
    u.set('page', String(n));
    if (!u.has('per_page')) u.set('per_page', String(per));
    links.push('<' + ctx.base + ctx.path + '?' + u.toString() + '>; rel="' + rel + '"');
  };
  if (pg < last) { mk(pg + 1, 'next'); mk(last, 'last'); }
  if (pg > 1) { mk(pg - 1, 'prev'); mk(1, 'first'); }
  return { slice, headers: links.length ? ['Link', links.join(', ')] : undefined };
}
function sortedRepos(ctx, list) {
  const sort = ctx.query.get('sort') || 'full_name';
  const dir = ctx.query.get('direction') || (sort === 'full_name' ? 'asc' : 'desc');
  const key = sort === 'created' ? (r) => r.createdAt : sort === 'updated' ? (r) => r.updatedAt : sort === 'pushed' ? (r) => r.pushedAt : (r) => r.fullName.toLowerCase();
  list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id - b.id));
  if (dir === 'desc') list.reverse();
  return list;
}
function repoListing(ctx, owner) {
  let list = sortedRepos(ctx, reposOf(owner));
  const vis = ctx.query.get('visibility') || ctx.query.get('type');
  if (vis === 'public') list = list.filter((r) => !r.isPrivate);
  else if (vis === 'private') list = list.filter((r) => r.isPrivate);
  const p = paginate(ctx, list);
  return respond(200, p.slice.map((r) => V.repoView(ctx.base, r)), p.headers);
}
function repoCreation(ctx, owner) {
  const input = parseJsonBody(ctx);
  const repo = openRepo(owner, input);
  if (input.auto_init === true) C.putFile(repo, 'README.md', { message: 'Initial commit' }, Buffer.from('# ' + repo.name + '\n' + (repo.description ? '\n' + repo.description + '\n' : '')));
  return respond(201, V.repoView(ctx.base, repo));
}

export function routeRest(ctx) {
  const s = ctx.segs, m = ctx.method, n = s.length;
  if (n === 0) {
    if (m !== 'GET') throw missing();
    const api = ctx.base + '/api/v3';
    return respond(200, { current_user_url: api + '/user', current_user_repositories_url: api + '/user/repos{?type,page,per_page,sort}', repository_url: api + '/repos/{owner}/{repo}', user_url: api + '/users/{user}', user_repositories_url: api + '/users/{user}/repos{?type,page,per_page,sort}', organization_url: api + '/orgs/{org}', organization_repositories_url: api + '/orgs/{org}/repos{?type,page,per_page,sort}', issues_url: api + '/issues', rate_limit_url: api + '/rate_limit' });
  }
  if (s[0] === 'meta' && n === 1 && m === 'GET') return respond(200, { verifiable_password_authentication: false, installed_version: '3.14.0' });
  if (s[0] === 'rate_limit' && n === 1 && m === 'GET') {
    const core = { limit: 5000, used: 0, remaining: 5000, reset: 1893456000 };
    return respond(200, { resources: { core, graphql: core, search: core }, rate: core });
  }
  if (s[0] === 'user') {
    if (n === 1 && m === 'GET') return respond(200, V.viewerView(ctx.base));
    if (n === 2 && s[1] === 'repos') { if (m === 'GET') return repoListing(ctx, OWNER_LOGIN); if (m === 'POST') return repoCreation(ctx, OWNER_LOGIN); }
    if (n === 2 && s[1] === 'orgs' && m === 'GET') return respond(200, []);
  }
  if (s[0] === 'users') {
    if (n === 2 && m === 'GET') {
      if (s[1].toLowerCase() === OWNER_LOGIN.toLowerCase()) return respond(200, V.viewerView(ctx.base));
      if (reposOf(s[1]).length) return respond(200, V.userView(ctx.base, s[1]));
    }
    if (n === 3 && s[2] === 'repos' && m === 'GET') return repoListing(ctx, s[1]);
  }
  if (s[0] === 'orgs' && n === 3 && s[2] === 'repos') {
    if (m === 'GET') return repoListing(ctx, s[1]);
    if (m === 'POST') return repoCreation(ctx, s[1]);
  }
  if (s[0] === 'repositories' && n === 1 && m === 'GET') {
    const p = paginate(ctx, [...allRepos.values()]);
    return respond(200, p.slice.map((r) => V.repoView(ctx.base, r)), p.headers);
  }
  if (s[0] === 'repos' && n >= 3) return routeRepo(ctx, demandRepo(s[1], s[2]), s, m, n);
  throw missing();
}

function routeRepo(ctx, repo, s, m, n) {
  const base = ctx.base;
  if (n === 3) {
    if (m === 'GET') {
      if (!repo.repoJsonText || repo.repoJsonBase !== base) { repo.repoJsonText = JSON.stringify(V.repoView(base, repo)); repo.repoJsonBase = base; }
      return { status: 200, body: repo.repoJsonText };
    }
    if (m === 'PATCH') {
      const input = parseJsonBody(ctx);
      if (typeof input.description === 'string' || input.description === null) repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      if (typeof input.visibility === 'string') repo.isPrivate = input.visibility === 'private';
      if (typeof input.homepage === 'string') repo.homepage = input.homepage;
      if (typeof input.has_issues === 'boolean') repo.issuesOn = input.has_issues;
      if (typeof input.default_branch === 'string' && input.default_branch !== repo.trunk) {
        if (!repo.refs.has('refs/heads/' + input.default_branch)) throw new HttpFault(422, 'Validation Failed', [{ resource: 'Repository', code: 'invalid', field: 'default_branch' }]);
        repo.trunk = input.default_branch;
      }
      bump(repo);
      return respond(200, V.repoView(base, repo));
    }
    if (m === 'DELETE') { dropRepo(repo); return EMPTY_204; }
    throw missing();
  }
  if (s[3] === 'issues') return routeIssues(ctx, repo, s, m, n);
  if (s[3] === 'pulls') return routePulls(ctx, repo, s, m, n);
  if (s[3] === 'labels') return routeLabels(ctx, repo, s, m, n);
  if (s[3] === 'contents') return routeContents(ctx, repo, s.slice(4).join('/'), m);
  if (s[3] === 'readme' && m === 'GET') return routeContents(ctx, repo, 'README.md', m);
  if (s[3] === 'branches' && m === 'GET') {
    if (n === 4) {
      const names = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice(11)).sort();
      const p = paginate(ctx, names);
      return respond(200, p.slice.map((name) => V.branchView(base, repo, name, false)), p.headers);
    }
    const name = s.slice(4).join('/');
    if (!repo.refs.has('refs/heads/' + name)) throw new HttpFault(404, 'Branch not found');
    return respond(200, V.branchView(base, repo, name, true));
  }
  if (s[3] === 'tags' && m === 'GET' && n === 4) {
    const names = [...repo.refs.keys()].filter((r) => r.startsWith('refs/tags/')).sort();
    const p = paginate(ctx, names);
    return respond(200, p.slice.map((ref) => { const sha = peelTag(repo.objects, repo.refs.get(ref)); return { name: ref.slice(10), commit: { sha, url: base + '/api/v3/repos/' + repo.fullName + '/commits/' + sha }, node_id: Buffer.from('03:Ref' + ref).toString('base64') }; }), p.headers);
  }
  if (s[3] === 'commits') return routeCommits(ctx, repo, s, m, n);
  if (s[3] === 'git') return routeGitData(ctx, repo, s, m, n);
  if (s[3] === 'compare' && m === 'GET' && n >= 5) return routeCompare(ctx, repo, s.slice(4).join('/'));
  throw missing();
}

function demandItem(repo, raw) {
  const num = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const it = repo.items.get(num);
  if (!it) throw missing();
  return it;
}
function itemReply(ctx, repo, it, status) {
  if (!it.cachedBuf || it.cachedBase !== ctx.base) { it.cachedBuf = Buffer.from(JSON.stringify(V.issueView(ctx.base, repo, it))); it.cachedBase = ctx.base; }
  return { status, body: it.cachedBuf };
}
function filteredItems(ctx, list) {
  const q = ctx.query;
  const state = q.get('state') || 'open';
  let out = state === 'all' ? list.slice() : list.filter((it) => it.state === state);
  const labels = q.get('labels');
  if (labels) {
    const want = labels.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean);
    out = out.filter((it) => want.every((w) => it.labels.some((l) => l.name.toLowerCase() === w)));
  }
  const since = q.get('since');
  if (since) out = out.filter((it) => it.updatedAt >= since);
  const sort = q.get('sort') || 'created';
  if (sort === 'updated') out.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number));
  else if (sort === 'comments') out.sort((a, b) => a.comments.length - b.comments.length || a.number - b.number);
  else out.sort((a, b) => a.number - b.number);
  if ((q.get('direction') || 'desc') !== 'asc') out.reverse();
  return out;
}
function routeIssues(ctx, repo, s, m, n) {
  const base = ctx.base;
  if (n === 4) {
    if (m === 'POST') return itemReply(ctx, repo, C.openIssue(repo, parseJsonBody(ctx)), 201);
    if (m === 'GET') {
      // bench path: the read workload asks for single issues, the list path
      // serialises the filtered page in one pass.
      const p = paginate(ctx, filteredItems(ctx, [...repo.items.values()]));
      return respond(200, p.slice.map((it) => V.issueView(base, repo, it)), p.headers);
    }
    throw missing();
  }
  if (s[4] === 'comments') {
    if (n === 5 && m === 'GET') {
      const all = [];
      for (const it of repo.items.values()) for (const c of it.comments) all.push(c);
      all.sort((a, b) => a.id - b.id);
      const p = paginate(ctx, all);
      return respond(200, p.slice.map((c) => V.commentView(base, repo, c)), p.headers);
    }
    if (n === 6) {
      const id = Number(s[5]);
      for (const it of repo.items.values()) {
        const at = it.comments.findIndex((c) => c.id === id);
        if (at < 0) continue;
        const c = it.comments[at];
        if (m === 'GET') return respond(200, V.commentView(base, repo, c));
        if (m === 'PATCH') {
          const input = parseJsonBody(ctx);
          if (typeof input.body !== 'string' || input.body === '') throw new HttpFault(422, 'Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
          c.body = input.body; C.retouch(it);
          return respond(200, V.commentView(base, repo, c));
        }
        if (m === 'DELETE') { it.comments.splice(at, 1); C.retouch(it); return EMPTY_204; }
      }
    }
    throw missing();
  }
  const it = demandItem(repo, s[4]);
  if (n === 5) {
    if (m === 'GET') return itemReply(ctx, repo, it, 200);
    if (m === 'PATCH') { C.patchItem(repo, it, parseJsonBody(ctx)); return itemReply(ctx, repo, it, 200); }
    throw missing();
  }
  if (s[5] === 'comments' && n === 6) {
    if (m === 'GET') { const p = paginate(ctx, it.comments); return respond(200, p.slice.map((c) => V.commentView(base, repo, c)), p.headers); }
    if (m === 'POST') return respond(201, V.commentView(base, repo, C.postComment(repo, it, parseJsonBody(ctx).body)));
  }
  if (s[5] === 'labels') {
    if (n === 6 && m === 'GET') return respond(200, it.labels.map((l) => V.labelView(base, repo, l)));
    if (n === 6 && (m === 'POST' || m === 'PUT')) {
      const input = ctx.body && ctx.body.length ? JSON.parse(ctx.body.toString('utf8')) : {};
      const names = Array.isArray(input) ? input : input.labels;
      const cur = m === 'PUT' ? [] : it.labels.map((l) => l.name);
      C.patchItem(repo, it, { labels: [...cur, ...(Array.isArray(names) ? names : [])] });
      return respond(200, it.labels.map((l) => V.labelView(base, repo, l)));
    }
    if (m === 'DELETE') {
      if (n === 6) it.labels = [];
      else {
        const want = s.slice(6).join('/').toLowerCase();
        if (!it.labels.some((l) => l.name.toLowerCase() === want)) throw new HttpFault(404, 'Label does not exist');
        it.labels = it.labels.filter((l) => l.name.toLowerCase() !== want);
      }
      C.retouch(it);
      return n === 6 ? EMPTY_204 : respond(200, it.labels.map((l) => V.labelView(base, repo, l)));
    }
  }
  throw missing();
}
function routeLabels(ctx, repo, s, m, n) {
  const base = ctx.base;
  if (n === 4) {
    if (m === 'GET') { const p = paginate(ctx, [...repo.labels.values()]); return respond(200, p.slice.map((l) => V.labelView(base, repo, l)), p.headers); }
    if (m === 'POST') return respond(201, V.labelView(base, repo, C.addLabel(repo, parseJsonBody(ctx))));
    throw missing();
  }
  const key = s.slice(4).join('/').toLowerCase();
  const label = repo.labels.get(key);
  if (!label) throw missing();
  if (m === 'GET') return respond(200, V.labelView(base, repo, label));
  if (m === 'PATCH') {
    const input = parseJsonBody(ctx);
    if (typeof input.color === 'string') label.color = input.color.replace(/^#/, '');
    if (typeof input.description === 'string') label.description = input.description;
    if (typeof input.new_name === 'string' && input.new_name !== '') { repo.labels.delete(key); label.name = input.new_name; repo.labels.set(label.name.toLowerCase(), label); }
    for (const it of repo.items.values()) if (it.labels.includes(label)) C.retouch(it);
    return respond(200, V.labelView(base, repo, label));
  }
  if (m === 'DELETE') {
    repo.labels.delete(key);
    for (const it of repo.items.values()) if (it.labels.includes(label)) { it.labels = it.labels.filter((l) => l !== label); C.retouch(it); }
    return EMPTY_204;
  }
  throw missing();
}
function routePulls(ctx, repo, s, m, n) {
  const base = ctx.base;
  if (n === 4) {
    if (m === 'POST') return respond(201, V.pullView(base, repo, C.openPull(repo, parseJsonBody(ctx)), true));
    if (m === 'GET') {
      let list = filteredItems(ctx, repo.onlyPulls);
      const head = ctx.query.get('head');
      if (head) list = list.filter((it) => it.pull.head === head.slice(head.indexOf(':') + 1));
      const b = ctx.query.get('base');
      if (b) list = list.filter((it) => it.pull.base === b);
      const p = paginate(ctx, list);
      return respond(200, p.slice.map((it) => V.pullView(base, repo, it, false)), p.headers);
    }
    throw missing();
  }
  const it = demandItem(repo, s[4]);
  if (!it.pull) throw missing();
  if (n === 5) {
    if (m === 'GET') return respond(200, V.pullView(base, repo, it, true));
    if (m === 'PATCH') {
      const input = parseJsonBody(ctx);
      if (typeof input.base === 'string' && input.base !== it.pull.base) {
        if (!repo.refs.has('refs/heads/' + input.base)) throw new HttpFault(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'base' }]);
        it.pull.base = input.base;
      }
      C.patchItem(repo, it, input);
      return respond(200, V.pullView(base, repo, it, true));
    }
    throw missing();
  }
  if (n === 6 && s[5] === 'files' && m === 'GET') {
    const api = base + '/api/v3/repos/' + repo.fullName;
    const p = paginate(ctx, C.pullFileList(repo, it));
    return respond(200, p.slice.map((f) => ({ ...f, blob_url: base + '/' + repo.fullName + '/blob/' + it.pull.headSha + '/' + f.filename, raw_url: base + '/' + repo.fullName + '/raw/' + it.pull.headSha + '/' + f.filename, contents_url: api + '/contents/' + f.filename + '?ref=' + it.pull.headSha })), p.headers);
  }
  if (n === 6 && s[5] === 'commits' && m === 'GET') {
    const tips = C.liveTips(repo, it);
    const stop = new Set(history(repo.objects, tips.merged ? readCommit(repo.objects, tips.mergeSha).parents[0] : tips.baseSha));
    const list = history(repo.objects, tips.headSha).filter((sha) => !stop.has(sha)).reverse();
    const p = paginate(ctx, list);
    return respond(200, p.slice.map((sha) => V.commitView(base, repo, sha)), p.headers);
  }
  if (n === 6 && s[5] === 'merge') {
    if (m === 'GET') { if (it.pull.merged) return EMPTY_204; throw missing(); }
    if (m === 'PUT') { const sha = C.doMerge(repo, it, parseJsonBody(ctx)); return respond(200, { sha, merged: true, message: 'Pull Request successfully merged' }); }
  }
  throw missing();
}
function routeCommits(ctx, repo, s, m, n) {
  if (m !== 'GET') throw missing();
  const base = ctx.base;
  if (n === 4) {
    const rev = ctx.query.get('sha');
    const tip = C.resolveRev(repo, rev || '');
    if (!tip) {
      if (!rev && repo.refs.size === 0) throw new HttpFault(409, 'Git Repository is empty.');
      throw missing();
    }
    let list = history(repo.objects, tip);
    const path = ctx.query.get('path');
    if (path) {
      const clean = path.replace(/^\/+|\/+$/g, '');
      const at = (sha) => { const e = findInTree(repo.objects, readCommit(repo.objects, sha).tree, clean); return e ? e.oid : ''; };
      list = list.filter((sha) => {
        const c = readCommit(repo.objects, sha);
        const mine = at(sha);
        if (c.parents.length === 0) return mine !== '';
        return c.parents.every((p) => at(p) !== mine);
      });
    }
    const p = paginate(ctx, list);
    return respond(200, p.slice.map((sha) => V.commitView(base, repo, sha)), p.headers);
  }
  const sha = C.resolveRev(repo, s.slice(4).join('/'));
  if (!sha || !readCommit(repo.objects, sha)) throw new HttpFault(422, 'No commit found for SHA: ' + s.slice(4).join('/'));
  const out = V.commitView(base, repo, sha);
  const c = readCommit(repo.objects, sha);
  const before = c.parents.length ? flattenTree(repo.objects, readCommit(repo.objects, c.parents[0]).tree) : new Map();
  const after = flattenTree(repo.objects, c.tree);
  const files = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const x = before.get(path), y = after.get(path);
    if (x && y && x.oid === y.oid) continue;
    files.push({ sha: y ? y.oid : x.oid, filename: path, status: !x ? 'added' : !y ? 'removed' : 'modified', additions: y ? 1 : 0, deletions: x ? 1 : 0, changes: (y ? 1 : 0) + (x ? 1 : 0) });
  }
  out.files = files;
  out.stats = { additions: files.reduce((a, f) => a + f.additions, 0), deletions: files.reduce((a, f) => a + f.deletions, 0), total: files.reduce((a, f) => a + f.changes, 0) };
  return respond(200, out);
}
function routeCompare(ctx, repo, spec) {
  const cut = spec.indexOf('...');
  if (cut < 0) throw missing();
  const a = C.resolveRev(repo, spec.slice(0, cut));
  const b = C.resolveRev(repo, spec.slice(cut + 3));
  if (!a || !b) throw missing();
  const behind = new Set(history(repo.objects, a));
  const aheadList = history(repo.objects, b).filter((sha) => !behind.has(sha)).reverse();
  const mine = new Set(history(repo.objects, b));
  let behindBy = 0;
  for (const sha of behind) if (!mine.has(sha)) behindBy++;
  const status = aheadList.length && behindBy ? 'diverged' : aheadList.length ? 'ahead' : behindBy ? 'behind' : 'identical';
  return respond(200, { status, ahead_by: aheadList.length, behind_by: behindBy, total_commits: aheadList.length, base_commit: V.commitView(ctx.base, repo, a), commits: aheadList.map((sha) => V.commitView(ctx.base, repo, sha)), files: [] });
}
function routeGitData(ctx, repo, s, m, n) {
  const base = ctx.base;
  const api = base + '/api/v3/repos/' + repo.fullName;
  const kind = s[4];
  if (kind === 'refs' && n === 5 && m === 'POST') {
    const input = parseJsonBody(ctx);
    if (typeof input.ref !== 'string' || !/^refs\/[^/]+\/.+/.test(input.ref)) throw new HttpFault(422, 'Reference name must start with refs/ and contain at least two slashes');
    if (typeof input.sha !== 'string' || !repo.objects.has(input.sha)) throw new HttpFault(422, 'Object does not exist');
    if (repo.refs.has(input.ref)) throw new HttpFault(422, 'Reference already exists');
    C.moveRef(repo, input.ref, input.sha);
    return respond(201, V.refView(base, repo, input.ref));
  }
  if (kind === 'refs' || kind === 'ref' || kind === 'matching-refs') {
    const tail = s.slice(5).join('/');
    const ref = 'refs/' + tail;
    if (m === 'GET') {
      if (repo.refs.has(ref) && kind !== 'matching-refs') return respond(200, V.refView(base, repo, ref));
      const hits = [...repo.refs.keys()].filter((r) => r.startsWith(ref)).sort();
      if (kind === 'matching-refs' || (kind === 'refs' && (hits.length > 0 || tail === ''))) {
        if (kind === 'refs' && hits.length === 0 && tail !== '') throw missing();
        return respond(200, hits.map((r) => V.refView(base, repo, r)));
      }
      throw missing();
    }
    if (!repo.refs.has(ref)) throw new HttpFault(422, 'Reference does not exist');
    if (m === 'PATCH') {
      const input = parseJsonBody(ctx);
      if (typeof input.sha !== 'string' || !repo.objects.has(input.sha)) throw new HttpFault(422, 'Object does not exist');
      C.moveRef(repo, ref, input.sha);
      return respond(200, V.refView(base, repo, ref));
    }
    if (m === 'DELETE') { C.moveRef(repo, ref, null); return EMPTY_204; }
    throw missing();
  }
  if (kind === 'commits' && n === 6 && m === 'GET') {
    const c = readCommit(repo.objects, s[5]);
    if (!c) throw missing();
    const j = V.commitView(base, repo, s[5]);
    return respond(200, { sha: s[5], node_id: j.node_id, url: api + '/git/commits/' + s[5], html_url: j.html_url, author: j.commit.author, committer: j.commit.committer, tree: j.commit.tree, message: c.message, parents: j.parents, verification: j.commit.verification });
  }
  if (kind === 'trees' && n === 6 && m === 'GET') {
    let oid = s[5];
    const asCommit = C.resolveRev(repo, oid);
    if (asCommit && readCommit(repo.objects, asCommit)) oid = readCommit(repo.objects, asCommit).tree;
    if (!readTree(repo.objects, oid)) throw missing();
    const recursive = ctx.query.has('recursive');
    const out = [];
    const walk = (tree, prefix) => {
      for (const e of readTree(repo.objects, tree) || []) {
        const isTree = e.mode === '40000';
        const entry = { path: prefix + e.name, mode: isTree ? '040000' : e.mode, type: isTree ? 'tree' : e.mode === '160000' ? 'commit' : 'blob', sha: e.oid };
        if (!isTree && repo.objects.has(e.oid)) entry.size = repo.objects.get(e.oid).data.length;
        entry.url = api + '/git/' + (isTree ? 'trees' : 'blobs') + '/' + e.oid;
        out.push(entry);
        if (isTree && recursive) walk(e.oid, prefix + e.name + '/');
      }
    };
    walk(oid, '');
    return respond(200, { sha: oid, url: api + '/git/trees/' + oid, tree: out, truncated: false });
  }
  if (kind === 'blobs') {
    if (n === 6 && m === 'GET') {
      const o = repo.objects.get(s[5]);
      if (!o || o.kind !== 'blob') throw missing();
      return respond(200, { sha: s[5], node_id: Buffer.from('04:Blob' + s[5]).toString('base64'), size: o.data.length, url: api + '/git/blobs/' + s[5], content: o.data.toString('base64'), encoding: 'base64' });
    }
    if (n === 5 && m === 'POST') {
      const input = parseJsonBody(ctx);
      if (typeof input.content !== 'string') throw new HttpFault(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
      const sha = storeObject(repo.objects, 'blob', Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8'));
      return respond(201, { sha, url: api + '/git/blobs/' + sha });
    }
  }
  if (kind === 'tags' && n === 6 && m === 'GET') {
    const o = repo.objects.get(s[5]);
    if (!o || o.kind !== 'tag') throw missing();
    const text = o.data.toString('utf8');
    const cut = text.indexOf('\n\n');
    const head = cut < 0 ? text : text.slice(0, cut);
    const field = (k) => (new RegExp('^' + k + ' (.*)$', 'm').exec(head) || [])[1] || '';
    const who = splitIdent(field('tagger'));
    return respond(200, { sha: s[5], node_id: Buffer.from('03:Tag' + s[5]).toString('base64'), url: api + '/git/tags/' + s[5], tag: field('tag'), message: cut < 0 ? '' : text.slice(cut + 2), tagger: { name: who.name, email: who.email, date: who.date }, object: { sha: field('object'), type: field('type'), url: api + '/git/' + field('type') + 's/' + field('object') } });
  }
  throw missing();
}
function routeContents(ctx, repo, rawPath, m) {
  const base = ctx.base;
  const api = base + '/api/v3/repos/' + repo.fullName;
  const path = rawPath.replace(/^\/+|\/+$/g, '');
  const fileView = (p, oid, refName, withContent) => {
    const o = repo.objects.get(oid);
    const name = p.slice(p.lastIndexOf('/') + 1);
    const self = api + '/contents/' + p.split('/').map(encodeURIComponent).join('/') + (refName ? '?ref=' + encodeURIComponent(refName) : '');
    const html = base + '/' + repo.fullName + '/blob/' + (refName || repo.trunk) + '/' + p;
    const out = { name, path: p, sha: oid, size: o ? o.data.length : 0, url: self, html_url: html, git_url: api + '/git/blobs/' + oid, download_url: base + '/' + repo.fullName + '/raw/' + (refName || repo.trunk) + '/' + p, type: 'file' };
    if (withContent) { out.content = o ? o.data.toString('base64') : ''; out.encoding = 'base64'; }
    out._links = { self, git: out.git_url, html };
    return out;
  };
  if (m === 'GET') {
    const refName = ctx.query.get('ref') || '';
    const commit = C.resolveRev(repo, refName);
    if (!commit) {
      if (repo.refs.size === 0 && !refName) throw new HttpFault(404, 'This repository is empty.');
      throw new HttpFault(404, refName ? 'No commit found for the ref ' + refName : 'Not Found');
    }
    const tree = readCommit(repo.objects, commit).tree;
    const hit = findInTree(repo.objects, tree, path);
    if (!hit) throw missing();
    if (hit.mode !== '40000') return respond(200, fileView(path, hit.oid, refName, true));
    const entries = readTree(repo.objects, hit.oid) || [];
    return respond(200, entries.map((e) => {
      const p = path ? path + '/' + e.name : e.name;
      if (e.mode !== '40000') return fileView(p, e.oid, refName, false);
      const self = api + '/contents/' + p.split('/').map(encodeURIComponent).join('/') + (refName ? '?ref=' + encodeURIComponent(refName) : '');
      const html = base + '/' + repo.fullName + '/tree/' + (refName || repo.trunk) + '/' + p;
      return { name: e.name, path: p, sha: e.oid, size: 0, url: self, html_url: html, git_url: api + '/git/trees/' + e.oid, download_url: null, type: 'dir', _links: { self, git: api + '/git/trees/' + e.oid, html } };
    }));
  }
  if (m === 'PUT') {
    const input = parseJsonBody(ctx);
    if (typeof input.content !== 'string') throw new HttpFault(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
    const res = C.putFile(repo, path, input, Buffer.from(input.content, 'base64'));
    const branch = C.shortBranch(input.branch) || repo.trunk;
    const cj = V.commitView(base, repo, res.commit);
    return respond(res.created ? 201 : 200, { content: fileView(res.path, res.blob, branch, true), commit: { sha: res.commit, node_id: cj.node_id, url: cj.commit.url, html_url: cj.html_url, author: cj.commit.author, committer: cj.commit.committer, tree: cj.commit.tree, message: cj.commit.message, parents: cj.parents, verification: cj.commit.verification } });
  }
  if (m === 'DELETE') {
    const input = parseJsonBody(ctx);
    if (input.sha === undefined && ctx.query.get('sha')) input.sha = ctx.query.get('sha');
    if (input.message === undefined && ctx.query.get('message')) input.message = ctx.query.get('message');
    if (input.branch === undefined && ctx.query.get('branch')) input.branch = ctx.query.get('branch');
    const res = C.putFile(repo, path, input, null);
    const cj = V.commitView(base, repo, res.commit);
    return respond(200, { content: null, commit: { sha: res.commit, node_id: cj.node_id, url: cj.commit.url, html_url: cj.html_url, author: cj.commit.author, committer: cj.commit.committer, tree: cj.commit.tree, message: cj.commit.message, parents: cj.parents, verification: cj.commit.verification } });
  }
  throw missing();
}
export { lookupRepo };

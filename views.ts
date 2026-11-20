// JSON shapes for the REST surface. Each builder returns a plain object;
// callers serialise once and cache the text per repository epoch.
import { OWNER_LOGIN, OWNER_ID, OWNER_NAME, OWNER_MAIL, readCommit, splitIdent, peelTag, liveTips, pullMergeable } from './core.ts';

const trim = (iso) => (iso ? iso.slice(0, 19) + 'Z' : null);
const userMemo = new Map();
export function userView(base, login) {
  const key = base + '|' + login;
  let u = userMemo.get(key);
  if (u) return u;
  const isViewer = login === OWNER_LOGIN;
  let id = OWNER_ID;
  if (!isViewer) {
    id = 2000;
    for (let i = 0; i < login.length; i++) id = (id * 31 + login.charCodeAt(i)) % 900000;
    id += 2000;
  }
  u = {
    login, id,
    node_id: Buffer.from('04:User' + id).toString('base64'),
    avatar_url: base + '/avatars/u/' + id,
    url: base + '/api/v3/users/' + login,
    html_url: base + '/' + login,
    type: /-org$/.test(login) ? 'Organization' : 'User',
    site_admin: false,
  };
  if (userMemo.size < 1000) userMemo.set(key, u);
  return u;
}
export function viewerView(base) {
  return { ...userView(base, OWNER_LOGIN), name: OWNER_NAME, company: null, blog: '', location: null, email: OWNER_MAIL, hireable: null, bio: null, public_repos: 0, public_gists: 0, followers: 0, following: 0, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' };
}
function openCount(r) { let n = 0; for (const it of r.items.values()) if (it.state === 'open') n++; return n; }
export function repoView(base, r) {
  const api = base + '/api/v3/repos/' + r.fullName;
  const html = base + '/' + r.fullName;
  return {
    id: r.id, node_id: r.nodeId, name: r.name, full_name: r.fullName, private: r.isPrivate,
    owner: userView(base, r.owner), html_url: html, description: r.description, fork: false, url: api,
    branches_url: api + '/branches{/branch}', commits_url: api + '/commits{/sha}', contents_url: api + '/contents/{+path}',
    git_refs_url: api + '/git/refs{/sha}', issues_url: api + '/issues{/number}', pulls_url: api + '/pulls{/number}', labels_url: api + '/labels{/name}',
    created_at: trim(r.createdAt), updated_at: trim(r.updatedAt), pushed_at: trim(r.pushedAt),
    git_url: 'git:' + html.replace(/^https?:/, '') + '.git',
    ssh_url: 'git@' + base.replace(/^https?:\/\//, '') + ':' + r.fullName + '.git',
    clone_url: html + '.git', homepage: r.homepage, size: r.objects.size,
    stargazers_count: 0, watchers_count: 0, language: null, has_issues: r.issuesOn, has_projects: false, has_downloads: true, has_wiki: false, has_pages: false, has_discussions: false,
    forks_count: 0, archived: false, disabled: false, open_issues_count: openCount(r), license: null, allow_forking: true, is_template: false, topics: [],
    visibility: r.isPrivate ? 'private' : 'public', forks: 0, open_issues: openCount(r), watchers: 0, default_branch: r.trunk,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true, delete_branch_on_merge: false, network_count: 0, subscribers_count: 0,
  };
}
export function labelView(base, r, l) {
  return { id: l.id, node_id: l.nodeId, url: base + '/api/v3/repos/' + r.fullName + '/labels/' + encodeURIComponent(l.name), name: l.name, color: l.color, default: false, description: l.description };
}
export function issueView(base, r, it) {
  const api = base + '/api/v3/repos/' + r.fullName;
  const out = {
    url: api + '/issues/' + it.number, repository_url: api, comments_url: api + '/issues/' + it.number + '/comments',
    html_url: base + '/' + r.fullName + '/' + (it.pull ? 'pull' : 'issues') + '/' + it.number,
    id: it.id, node_id: it.nodeId, number: it.number, title: it.title, user: userView(base, OWNER_LOGIN),
    labels: it.labels.map((l) => labelView(base, r, l)), state: it.state, locked: false, assignee: null, assignees: [], milestone: null,
    comments: it.comments.length, created_at: trim(it.createdAt), updated_at: trim(it.updatedAt), closed_at: trim(it.closedAt),
    author_association: 'OWNER', active_lock_reason: null, body: it.body, state_reason: it.pull ? null : it.stateReason,
  };
  if (it.pull) {
    out.draft = it.pull.draft;
    out.pull_request = { url: api + '/pulls/' + it.number, html_url: base + '/' + r.fullName + '/pull/' + it.number, diff_url: base + '/' + r.fullName + '/pull/' + it.number + '.diff', patch_url: base + '/' + r.fullName + '/pull/' + it.number + '.patch', merged_at: trim(it.pull.mergedAt) };
  }
  return out;
}
export function commentView(base, r, c) {
  const api = base + '/api/v3/repos/' + r.fullName;
  return { url: api + '/issues/comments/' + c.id, html_url: base + '/' + r.fullName + '/issues/' + c.issue.number + '#issuecomment-' + c.id, issue_url: api + '/issues/' + c.issue.number, id: c.id, node_id: c.nodeId, user: userView(base, OWNER_LOGIN), created_at: trim(c.createdAt), updated_at: trim(c.updatedAt), author_association: 'OWNER', body: c.body, reactions: { url: api + '/issues/comments/' + c.id + '/reactions', total_count: 0 }, performed_via_github_app: null };
}
export function pullView(base, r, it, full) {
  const api = base + '/api/v3/repos/' + r.fullName;
  const p = liveTips(r, it);
  const repo = repoView(base, r);
  const owner = userView(base, r.owner);
  const out = {
    url: api + '/pulls/' + it.number, id: it.id, node_id: it.nodeId, html_url: base + '/' + r.fullName + '/pull/' + it.number,
    diff_url: base + '/' + r.fullName + '/pull/' + it.number + '.diff', patch_url: base + '/' + r.fullName + '/pull/' + it.number + '.patch',
    issue_url: api + '/issues/' + it.number, number: it.number, state: it.state, locked: false, title: it.title,
    user: userView(base, OWNER_LOGIN), body: it.body, created_at: trim(it.createdAt), updated_at: trim(it.updatedAt), closed_at: trim(it.closedAt),
    merged_at: trim(p.mergedAt), merge_commit_sha: p.mergeSha, assignee: null, assignees: [], requested_reviewers: [], requested_teams: [],
    labels: it.labels.map((l) => labelView(base, r, l)), milestone: null, draft: p.draft,
    commits_url: api + '/pulls/' + it.number + '/commits', review_comments_url: api + '/pulls/' + it.number + '/comments', comments_url: api + '/issues/' + it.number + '/comments',
    statuses_url: api + '/statuses/' + p.headSha,
    head: { label: r.owner + ':' + p.head, ref: p.head, sha: p.headSha, user: owner, repo },
    base: { label: r.owner + ':' + p.base, ref: p.base, sha: p.baseSha, user: owner, repo },
    author_association: 'OWNER', auto_merge: null, active_lock_reason: null, merged: p.merged,
  };
  if (full) {
    const ok = pullMergeable(r, it);
    out.mergeable = ok; out.rebaseable = ok; out.mergeable_state = ok === null ? 'unknown' : ok ? 'clean' : 'dirty';
    out.merged_by = p.merged ? userView(base, OWNER_LOGIN) : null;
    out.comments = it.comments.length; out.review_comments = 0; out.maintainer_can_modify = false;
  }
  return out;
}
export function commitView(base, r, sha) {
  const c = readCommit(r.objects, sha);
  const api = base + '/api/v3/repos/' + r.fullName;
  const a = splitIdent(c.author), m = splitIdent(c.committer);
  const who = (x) => (x.email === OWNER_MAIL ? userView(base, OWNER_LOGIN) : null);
  return {
    sha, node_id: Buffer.from('06:Commit' + sha).toString('base64'),
    commit: { author: { name: a.name, email: a.email, date: a.date }, committer: { name: m.name, email: m.email, date: m.date }, message: c.message, tree: { sha: c.tree, url: api + '/git/trees/' + c.tree }, url: api + '/git/commits/' + sha, comment_count: 0, verification: { verified: false, reason: 'unsigned', signature: null, payload: null } },
    url: api + '/commits/' + sha, html_url: base + '/' + r.fullName + '/commit/' + sha, comments_url: api + '/commits/' + sha + '/comments',
    author: who(a), committer: who(m),
    parents: c.parents.map((p) => ({ sha: p, url: api + '/commits/' + p, html_url: base + '/' + r.fullName + '/commit/' + p })),
  };
}
export function refView(base, r, ref) {
  const oid = r.refs.get(ref);
  const o = r.objects.get(oid);
  const kind = o ? o.kind : 'commit';
  return { ref, node_id: Buffer.from('03:Ref' + r.id + ':' + ref).toString('base64'), url: base + '/api/v3/repos/' + r.fullName + '/git/' + ref, object: { sha: oid, type: kind, url: base + '/api/v3/repos/' + r.fullName + '/git/' + (kind === 'tag' ? 'tags' : 'commits') + '/' + oid } };
}
export function branchView(base, r, name, full) {
  const sha = peelTag(r.objects, r.refs.get('refs/heads/' + name));
  const api = base + '/api/v3/repos/' + r.fullName;
  if (!full) return { name, commit: { sha, url: api + '/commits/' + sha }, protected: false };
  return { name, commit: commitView(base, r, sha), _links: { self: api + '/branches/' + encodeURIComponent(name), html: base + '/' + r.fullName + '/tree/' + name }, protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } }, protection_url: api + '/branches/' + encodeURIComponent(name) + '/protection' };
}

// MCP endpoint for forge-prime: JSON-RPC 2.0 over streamable HTTP.
// Supports the 2026-07-28 discovery revision and the classic initialize
// handshake. tools/list is a pre-serialised constant: byte-identical on
// every call and free to answer.
import { HttpFault, OWNER_LOGIN, demandRepo, openRepo, reposOf, readCommit, findInTree, history } from './core.ts';
import * as C from './core.ts';
import * as V from './views.ts';

const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INFO = { name: 'forge-prime', title: 'forge-prime git forge', version: '1.0.0' };
const CAPS = { tools: { listChanged: false } };
const NOTES = 'Tools act on the repositories, issues and pull requests of this forge as the token owner. Results are JSON text shaped like the GitHub REST API.';

const sProp = (description) => ({ type: 'string', description });
const nProp = (description) => ({ type: 'integer', description });
const OWNER_P = sProp('Account that owns the repository');
const REPO_P = sProp('Repository name');

const registry = new Map();
const toolDefs = [];
function registerTool(name, title, description, properties, required, run) {
  toolDefs.push({ name, title, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { title } });
  registry.set(name, { required, properties, run });
}
const repoFrom = (a) => demandRepo(a.owner, a.repo);
function itemFrom(a, key, wantPull) {
  const repo = repoFrom(a);
  const it = repo.items.get(Number(a[key]));
  if (!it || (wantPull && !it.pull)) throw new HttpFault(404, 'Not Found');
  return { repo, it };
}
registerTool('create_repo', 'Create repository', 'Create a new repository owned by the authenticated user.', { name: sProp('Repository name'), description: sProp('Short description'), private: { type: 'boolean', description: 'Whether the repository is private' }, auto_init: { type: 'boolean', description: 'Create an initial commit with a README' } }, ['name'], (a, base) => {
  const repo = openRepo(OWNER_LOGIN, a);
  if (a.auto_init === true) C.putFile(repo, 'README.md', { message: 'Initial commit' }, Buffer.from('# ' + repo.name + '\n'));
  return V.repoView(base, repo);
});
registerTool('get_repo', 'Get repository', 'Read one repository by owner and name.', { owner: OWNER_P, repo: REPO_P }, ['owner', 'repo'], (a, base) => V.repoView(base, repoFrom(a)));
registerTool('list_repos', 'List repositories', 'List the repositories owned by the authenticated user.', {}, [], (a, base) => reposOf(OWNER_LOGIN).map((r) => V.repoView(base, r)));
registerTool('create_issue', 'Create issue', 'Open a new issue in a repository.', { owner: OWNER_P, repo: REPO_P, title: sProp('Issue title'), body: sProp('Issue body (markdown)'), labels: { type: 'array', items: { type: 'string' }, description: 'Names of existing labels to apply' } }, ['owner', 'repo', 'title'], (a, base) => V.issueView(base, repoFrom(a), C.openIssue(repoFrom(a), a)));
registerTool('get_issue', 'Get issue', 'Read one issue by number.', { owner: OWNER_P, repo: REPO_P, issue_number: nProp('Issue number') }, ['owner', 'repo', 'issue_number'], (a, base) => { const { repo, it } = itemFrom(a, 'issue_number', false); return V.issueView(base, repo, it); });
registerTool('list_issues', 'List issues', 'List the issues of a repository, newest first. Pull requests are not included.', { owner: OWNER_P, repo: REPO_P, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which issues to list (default open)' } }, ['owner', 'repo'], (a, base) => {
  const repo = repoFrom(a);
  const state = a.state === undefined || a.state === null ? 'open' : String(a.state).toLowerCase();
  if (!['open', 'closed', 'all'].includes(state)) throw new HttpFault(422, 'state must be open, closed or all');
  return repo.onlyIssues.filter((it) => state === 'all' || it.state === state).slice().reverse().map((it) => V.issueView(base, repo, it));
});
registerTool('update_issue', 'Update issue', 'Change the title, body or state of an issue.', { owner: OWNER_P, repo: REPO_P, issue_number: nProp('Issue number'), title: sProp('New title'), body: sProp('New body'), state: { type: 'string', enum: ['open', 'closed'], description: 'New state' } }, ['owner', 'repo', 'issue_number'], (a, base) => {
  const { repo, it } = itemFrom(a, 'issue_number', false);
  const patch = {};
  for (const k of ['title', 'body', 'state']) if (a[k] !== undefined) patch[k] = a[k];
  C.patchItem(repo, it, patch);
  return V.issueView(base, repo, it);
});
registerTool('add_issue_comment', 'Comment on issue', 'Add a comment to an issue or pull request.', { owner: OWNER_P, repo: REPO_P, issue_number: nProp('Issue or pull request number'), body: sProp('Comment body') }, ['owner', 'repo', 'issue_number', 'body'], (a, base) => { const { repo, it } = itemFrom(a, 'issue_number', false); return V.commentView(base, repo, C.postComment(repo, it, a.body)); });
registerTool('create_pull_request', 'Create pull request', 'Open a pull request asking to merge the head branch into the base branch.', { owner: OWNER_P, repo: REPO_P, title: sProp('Pull request title'), head: sProp('Branch that holds the changes'), base: sProp('Branch to merge into'), body: sProp('Pull request description') }, ['owner', 'repo', 'title', 'head', 'base'], (a, base) => { const repo = repoFrom(a); return V.pullView(base, repo, C.openPull(repo, a), true); });
registerTool('get_pull_request', 'Get pull request', 'Read one pull request by number.', { owner: OWNER_P, repo: REPO_P, pull_number: nProp('Pull request number') }, ['owner', 'repo', 'pull_number'], (a, base) => { const { repo, it } = itemFrom(a, 'pull_number', true); return V.pullView(base, repo, it, true); });
registerTool('list_pull_requests', 'List pull requests', 'List the pull requests of a repository, newest first.', { owner: OWNER_P, repo: REPO_P, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which pull requests to list (default open)' } }, ['owner', 'repo'], (a, base) => {
  const repo = repoFrom(a);
  const state = a.state === undefined || a.state === null ? 'open' : String(a.state).toLowerCase();
  return repo.onlyPulls.filter((it) => state === 'all' || it.state === state).slice().reverse().map((it) => V.pullView(base, repo, it, false));
});
registerTool('merge_pull_request', 'Merge pull request', 'Merge an open pull request into its base branch.', { owner: OWNER_P, repo: REPO_P, pull_number: nProp('Pull request number'), merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'How to merge (default merge)' }, commit_title: sProp('Title of the merge commit') }, ['owner', 'repo', 'pull_number'], (a, base) => {
  const { repo, it } = itemFrom(a, 'pull_number', true);
  const sha = C.doMerge(repo, it, a);
  return { merged: true, sha, message: 'Pull Request successfully merged', number: it.number, state: it.state, merged_at: V.pullView(base, repo, it, false).merged_at };
});
registerTool('list_branches', 'List branches', 'List the branches of a repository.', { owner: OWNER_P, repo: REPO_P }, ['owner', 'repo'], (a, base) => {
  const repo = repoFrom(a);
  return [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort().map((r) => V.branchView(base, repo, r.slice(11), false));
});
registerTool('create_branch', 'Create branch', 'Create a branch from another branch (the default branch unless from_branch is given).', { owner: OWNER_P, repo: REPO_P, branch: sProp('Name of the new branch'), from_branch: sProp('Branch to start from') }, ['owner', 'repo', 'branch'], (a, base) => {
  const repo = repoFrom(a);
  const from = C.resolveRev(repo, typeof a.from_branch === 'string' ? a.from_branch : '');
  if (!from) throw new HttpFault(404, 'The starting branch does not exist');
  const ref = 'refs/heads/' + a.branch;
  if (repo.refs.has(ref)) throw new HttpFault(422, 'Reference already exists');
  C.moveRef(repo, ref, from);
  return V.refView(base, repo, ref);
});
registerTool('list_commits', 'List commits', 'List the commits reachable from a branch, newest first.', { owner: OWNER_P, repo: REPO_P, sha: sProp('Branch name or commit id (default: the default branch)') }, ['owner', 'repo'], (a, base) => {
  const repo = repoFrom(a);
  const tip = C.resolveRev(repo, typeof a.sha === 'string' ? a.sha : '');
  if (!tip) throw new HttpFault(404, 'Not Found');
  return history(repo.objects, tip, 100).map((sha) => V.commitView(base, repo, sha));
});
registerTool('get_file_contents', 'Get file contents', 'Read a file from a repository as text.', { owner: OWNER_P, repo: REPO_P, path: sProp('Path of the file'), ref: sProp('Branch, tag or commit (default: the default branch)') }, ['owner', 'repo', 'path'], (a) => {
  const repo = repoFrom(a);
  const commit = C.resolveRev(repo, typeof a.ref === 'string' ? a.ref : '');
  if (!commit) throw new HttpFault(404, 'Not Found');
  const path = String(a.path).replace(/^\/+|\/+$/g, '');
  const hit = findInTree(repo.objects, readCommit(repo.objects, commit).tree, path);
  if (!hit || hit.mode === '40000') throw new HttpFault(404, 'Not Found');
  const data = repo.objects.get(hit.oid).data;
  return { type: 'file', path, sha: hit.oid, size: data.length, encoding: 'utf-8', content: data.toString('utf8') };
});
registerTool('create_or_update_file', 'Write file', 'Create or replace one file with a commit on a branch.', { owner: OWNER_P, repo: REPO_P, path: sProp('Path of the file'), content: sProp('New file content as plain text'), message: sProp('Commit message'), branch: sProp('Branch to commit to (default: the default branch)'), sha: sProp('Blob id of the file being replaced, required when it exists') }, ['owner', 'repo', 'path', 'content', 'message'], (a) => {
  const repo = repoFrom(a);
  const res = C.putFile(repo, a.path, a, Buffer.from(String(a.content), 'utf8'));
  return { content: { path: res.path, sha: res.blob, type: 'file' }, commit: { sha: res.commit, message: a.message } };
});

const TOOLS_LIST_TEXT = JSON.stringify({ tools: toolDefs });
const TOOLS_LIST_RESULT = JSON.parse(TOOLS_LIST_TEXT);

function valueMatches(schema, v) {
  if (schema.type === 'string') return typeof v === 'string';
  if (schema.type === 'integer') return (typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'string' && /^\d+$/.test(v));
  if (schema.type === 'boolean') return typeof v === 'boolean';
  if (schema.type === 'array') return Array.isArray(v);
  return true;
}
function invokeTool(params, base) {
  const name = params && params.name;
  if (typeof name !== 'string' || !registry.has(name)) return { error: { code: -32602, message: 'Unknown tool: ' + String(name) } };
  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  const failed = (text) => ({ result: { content: [{ type: 'text', text }], isError: true } });
  if (typeof args !== 'object' || Array.isArray(args)) return failed('arguments must be an object');
  const t = registry.get(name);
  const missing = t.required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  if (missing.length) return failed('Missing required argument' + (missing.length > 1 ? 's' : '') + ': ' + missing.join(', '));
  for (const k of Object.keys(t.properties)) {
    if (args[k] !== undefined && args[k] !== null && !valueMatches(t.properties[k], args[k])) return failed('Argument ' + k + ' must be of type ' + t.properties[k].type);
  }
  try {
    const value = t.run(args, base);
    const result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false };
    result.structuredContent = Array.isArray(value) ? { items: value } : value;
    return { result };
  } catch (e) {
    if (e instanceof HttpFault) {
      const detail = Array.isArray(e.errors) && e.errors[0] && e.errors[0].message ? ': ' + e.errors[0].message : '';
      return failed(e.message + detail + ' (HTTP ' + e.status + ')');
    }
    return failed('Tool failed: ' + String((e && e.message) || e));
  }
}
function handleMessage(msg, ctx) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  const hasId = msg.id !== undefined && msg.id !== null;
  const id = hasId ? msg.id : null;
  const done = (result) => (hasId ? { jsonrpc: '2.0', id, result } : null);
  const fail = (code, message, data) => (hasId ? { jsonrpc: '2.0', id, error: data ? { code, message, data } : { code, message } } : null);
  if (typeof msg.method !== 'string') {
    if (msg.result !== undefined || msg.error !== undefined) return null;
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      const version = typeof asked === 'string' && REVISIONS.includes(asked) ? asked : '2025-11-25';
      return done({ protocolVersion: version, capabilities: CAPS, serverInfo: INFO, instructions: NOTES });
    }
    case 'server/discover': return done({ supportedVersions: REVISIONS, capabilities: CAPS, serverInfo: INFO, instructions: NOTES });
    case 'ping': return done({});
    case 'tools/list': return done(TOOLS_LIST_RESULT);
    case 'tools/call': { const out = invokeTool(params, ctx.base); return out.error ? fail(out.error.code, out.error.message) : done(out.result); }
    case 'resources/list': return done({ resources: [] });
    case 'resources/templates/list': return done({ resourceTemplates: [] });
    case 'prompts/list': return done({ prompts: [] });
    case 'logging/setLevel': return done({});
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return fail(-32601, 'Method not found: ' + msg.method);
  }
}
export function handleMcpHttp(ctx) {
  if (ctx.method === 'DELETE') return { status: 200, body: '{}' };
  if (ctx.method !== 'POST') return { status: 405, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Use POST for JSON-RPC messages' } }), headers: ['Allow', 'POST, DELETE'] };
  let msg;
  try { msg = JSON.parse(ctx.body.toString('utf8')); }
  catch { return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the request body is not valid JSON' } }) }; }
  const want = ctx.headers['mcp-protocol-version'];
  if (typeof want === 'string' && want !== '' && !REVISIONS.includes(want)) {
    const id = msg && typeof msg === 'object' && !Array.isArray(msg) && msg.id !== undefined ? msg.id : null;
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32022, message: 'Unsupported protocol version: ' + want, data: { supported: REVISIONS, requested: want } } }) };
  }
  if (Array.isArray(msg)) {
    if (msg.length === 0) return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) };
    const out = msg.map((m) => handleMessage(m, ctx)).filter((r) => r !== null);
    return out.length ? { status: 200, body: JSON.stringify(out) } : { status: 202, body: '' };
  }
  const out = handleMessage(msg, ctx);
  if (out === null) return { status: 202, body: '' };
  return { status: 200, body: JSON.stringify(out) };
}

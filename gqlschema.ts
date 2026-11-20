// GraphQL schema table for forge-prime: types, fields, argument names and
// resolvers, all reading the same in-memory store as REST and MCP.
import { HttpFault, OWNER_LOGIN, OWNER_NAME, OWNER_MAIL, OWNER_ID, allNodes, allRepos, lookupRepo, reposOf, openRepo, readCommit, peelTag } from './core.ts';
import * as C from './core.ts';

export const gqlTypes = {};
const defObj = (name, fields, extra) => (gqlTypes[name] = { kind: 'OBJECT', name, fields, ...(extra || {}) });
const defEnum = (name, values) => (gqlTypes[name] = { kind: 'ENUM', name, values });
const defInput = (name, fields) => (gqlTypes[name] = { kind: 'INPUT_OBJECT', name, inputFields: fields });
for (const s of ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'HTML']) gqlTypes[s] = { kind: 'SCALAR', name: s };

const fld = (type, resolve, args) => ({ type, resolve, args: args || null });
const trimT = (iso) => (iso ? iso.slice(0, 19) + 'Z' : null);
const entityOf = (item) => (item ? allNodes.get(item.nodeId) : null);
const PAGE = { first: 'Int', after: 'String', last: 'Int', before: 'String' };

const cursorFor = (i) => Buffer.from('cursor:v2:' + i).toString('base64');
function cursorIndex(c) {
  const m = /^cursor:v2:(\d+)$/.exec(Buffer.from(String(c), 'base64').toString('utf8'));
  return m ? Number(m[1]) : -1;
}
export function relayWindow(items, a) {
  let lo = 0, hi = items.length;
  if (a.after != null) lo = Math.max(lo, cursorIndex(a.after) + 1);
  if (a.before != null) { const b = cursorIndex(a.before); if (b >= 0) hi = Math.min(hi, b); }
  let start = lo, end = hi;
  if (typeof a.first === 'number') end = Math.min(end, start + Math.max(0, a.first));
  else if (typeof a.last === 'number') start = Math.max(start, end - Math.max(0, a.last));
  else end = Math.min(end, start + 30);
  if (end < start) end = start;
  const edges = [];
  for (let i = start; i < end; i++) edges.push({ node: items[i], cursor: cursorFor(i) });
  return { nodes: edges.map((e) => e.node), edges, totalCount: items.length, pageInfo: { hasNextPage: end < hi, hasPreviousPage: start > lo, startCursor: edges.length ? edges[0].cursor : null, endCursor: edges.length ? edges[edges.length - 1].cursor : null } };
}
function defConn(name, nodeType) {
  defObj(name + 'Edge', { node: fld(nodeType), cursor: fld('String!') });
  defObj(name + 'Connection', { nodes: fld('[' + nodeType + ']'), edges: fld('[' + name + 'Edge]'), pageInfo: fld('PageInfo!'), totalCount: fld('Int!') });
}
defObj('PageInfo', { hasNextPage: fld('Boolean!'), hasPreviousPage: fld('Boolean!'), startCursor: fld('String'), endCursor: fld('String') });
defConn('Issue', 'Issue'); defConn('PullRequest', 'PullRequest'); defConn('IssueComment', 'IssueComment');
defConn('Repository', 'Repository'); defConn('Label', 'Label'); defConn('Ref', 'Ref');
defConn('PullRequestChangedFile', 'PullRequestChangedFile'); defConn('SearchResultItem', 'SearchResultItem');
gqlTypes.SearchResultItemConnection.fields.issueCount = fld('Int!');
gqlTypes.SearchResultItemConnection.fields.repositoryCount = fld('Int!');

defEnum('IssueState', ['OPEN', 'CLOSED']);
defEnum('IssueStateReason', ['COMPLETED', 'NOT_PLANNED', 'REOPENED']);
defEnum('PullRequestState', ['OPEN', 'CLOSED', 'MERGED']);
defEnum('MergeableState', ['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
defEnum('PullRequestMergeMethod', ['MERGE', 'SQUASH', 'REBASE']);
defEnum('RepositoryPermission', ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']);
defEnum('RepositoryVisibility', ['PUBLIC', 'PRIVATE', 'INTERNAL']);
defEnum('OrderDirection', ['ASC', 'DESC']);
defEnum('IssueOrderField', ['CREATED_AT', 'UPDATED_AT', 'COMMENTS']);
defEnum('SearchType', ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION']);
defEnum('PatchStatus', ['ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED']);
defInput('IssueOrder', { field: 'IssueOrderField!', direction: 'OrderDirection!' });
defInput('CreateIssueInput', { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', clientMutationId: 'String' });
defInput('CloseIssueInput', { issueId: 'ID!', stateReason: 'IssueStateReason', clientMutationId: 'String' });
defInput('ReopenIssueInput', { issueId: 'ID!', clientMutationId: 'String' });
defInput('UpdateIssueInput', { id: 'ID!', title: 'String', body: 'String', state: 'IssueState', clientMutationId: 'String' });
defInput('CreatePullRequestInput', { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', clientMutationId: 'String' });
defInput('MergePullRequestInput', { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', commitHeadline: 'String', commitBody: 'String', expectedHeadOid: 'GitObjectID', clientMutationId: 'String' });
defInput('ClosePullRequestInput', { pullRequestId: 'ID!', clientMutationId: 'String' });
defInput('AddCommentInput', { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' });
defInput('CreateRepositoryInput', { name: 'String!', description: 'String', visibility: 'RepositoryVisibility!', ownerId: 'ID', clientMutationId: 'String' });
defInput('IssueFilters', { states: '[IssueState!]', labels: '[String!]' });

const userNode = (login) => ({ kind: login === OWNER_LOGIN || !/-org$/.test(login) ? 'User' : 'Organization', login });
const userFields = {
  id: fld('ID!', (u) => Buffer.from('04:User' + u.login).toString('base64')),
  login: fld('String!', (u) => u.login),
  name: fld('String', (u) => (u.login === OWNER_LOGIN ? OWNER_NAME : null)),
  email: fld('String!', (u) => (u.login === OWNER_LOGIN ? OWNER_MAIL : '')),
  databaseId: fld('Int', (u) => (u.login === OWNER_LOGIN ? OWNER_ID : null)),
  url: fld('URI!', (u, a, c) => c.base + '/' + u.login),
  avatarUrl: fld('URI!', (u, a, c) => c.base + '/avatars/' + u.login),
  repositories: fld('RepositoryConnection!', (u, a) => relayWindow(reposOf(u.login).map(entityOf), a), { ...PAGE }),
  repository: fld('Repository', (u, a) => entityOf(lookupRepo(u.login, a.name)), { name: 'String!' }),
};
defObj('User', userFields);
defObj('Organization', userFields);
gqlTypes.Actor = { kind: 'INTERFACE', name: 'Actor', fields: { login: userFields.login, url: userFields.url, avatarUrl: userFields.avatarUrl }, possible: ['User', 'Organization'] };
gqlTypes.RepositoryOwner = { kind: 'INTERFACE', name: 'RepositoryOwner', fields: { id: userFields.id, login: userFields.login, url: userFields.url, avatarUrl: userFields.avatarUrl, repositories: userFields.repositories, repository: userFields.repository }, possible: ['User', 'Organization'] };

defObj('GitObject', { oid: fld('GitObjectID!', (o) => o.oid), id: fld('ID!', (o) => Buffer.from('06:Commit' + o.oid).toString('base64')), message: fld('String', (o) => o.commit.message), messageHeadline: fld('String', (o) => o.commit.message.split('\n')[0]) });
gqlTypes.Commit = { ...gqlTypes.GitObject, name: 'Commit' };
defObj('Ref', {
  id: fld('ID!', (r) => Buffer.from('03:Ref' + r.repo.id + ':' + r.ref).toString('base64')),
  name: fld('String!', (r) => r.ref.replace(/^refs\/(heads|tags)\//, '')),
  prefix: fld('String!', (r) => r.ref.slice(0, r.ref.indexOf('/', 5) + 1)),
  target: fld('GitObject', (r) => {
    const oid = peelTag(r.repo.objects, r.repo.refs.get(r.ref));
    const commit = oid && readCommit(r.repo.objects, oid);
    return commit ? { oid, commit } : null;
  }),
});
const refEntry = (repo, ref) => (repo.refs.has(ref) ? { repo, ref } : null);
defObj('Label', { id: fld('ID!', (l) => l.nodeId), name: fld('String!', (l) => l.name), color: fld('String!', (l) => l.color), description: fld('String', (l) => l.description) });
defObj('PullRequestChangedFile', {
  path: fld('String!', (x) => x.filename),
  additions: fld('Int!', (x) => x.additions),
  deletions: fld('Int!', (x) => x.deletions),
  changeType: fld('PatchStatus!', (x) => (x.status === 'added' ? 'ADDED' : x.status === 'removed' ? 'DELETED' : 'MODIFIED')),
});
defObj('IssueComment', {
  id: fld('ID!', (e) => e.item.nodeId),
  databaseId: fld('Int', (e) => e.item.id),
  body: fld('String!', (e) => e.item.body),
  bodyText: fld('String!', (e) => e.item.body),
  author: fld('Actor', () => userNode(OWNER_LOGIN)),
  createdAt: fld('DateTime!', (e) => trimT(e.item.createdAt)),
  updatedAt: fld('DateTime!', (e) => trimT(e.item.updatedAt)),
  url: fld('URI!', (e, a, c) => c.base + '/' + e.repo.fullName + '/issues/' + e.item.issue.number + '#issuecomment-' + e.item.id),
  issue: fld('Issue', (e) => (e.item.issue.pull ? null : entityOf(e.item.issue))),
});
const sharedItemFields = {
  id: fld('ID!', (e) => e.item.nodeId),
  databaseId: fld('Int', (e) => e.item.id),
  number: fld('Int!', (e) => e.item.number),
  title: fld('String!', (e) => e.item.title),
  body: fld('String!', (e) => e.item.body),
  bodyText: fld('String!', (e) => e.item.body),
  closed: fld('Boolean!', (e) => e.item.state === 'closed'),
  author: fld('Actor', () => userNode(OWNER_LOGIN)),
  createdAt: fld('DateTime!', (e) => trimT(e.item.createdAt)),
  updatedAt: fld('DateTime!', (e) => trimT(e.item.updatedAt)),
  closedAt: fld('DateTime', (e) => trimT(e.item.closedAt)),
  repository: fld('Repository!', (e) => entityOf(e.repo)),
  comments: fld('IssueCommentConnection!', (e, a) => relayWindow(e.item.comments.map(entityOf), a), { ...PAGE }),
  labels: fld('LabelConnection', (e, a) => relayWindow(e.item.labels, a), { ...PAGE }),
  viewerCanUpdate: fld('Boolean!', () => true),
};
defObj('Issue', {
  ...sharedItemFields,
  state: fld('IssueState!', (e) => (e.item.state === 'open' ? 'OPEN' : 'CLOSED')),
  stateReason: fld('IssueStateReason', (e) => (e.item.stateReason ? e.item.stateReason.toUpperCase() : null)),
  url: fld('URI!', (e, a, c) => c.base + '/' + e.repo.fullName + '/issues/' + e.item.number),
});
defObj('PullRequest', {
  ...sharedItemFields,
  state: fld('PullRequestState!', (e) => (e.item.pull.merged ? 'MERGED' : e.item.state === 'open' ? 'OPEN' : 'CLOSED')),
  url: fld('URI!', (e, a, c) => c.base + '/' + e.repo.fullName + '/pull/' + e.item.number),
  headRefName: fld('String!', (e) => e.item.pull.head),
  baseRefName: fld('String!', (e) => e.item.pull.base),
  headRefOid: fld('GitObjectID!', (e) => C.liveTips(e.repo, e.item).headSha),
  baseRefOid: fld('GitObjectID!', (e) => C.liveTips(e.repo, e.item).baseSha),
  headRef: fld('Ref', (e) => refEntry(e.repo, 'refs/heads/' + e.item.pull.head)),
  baseRef: fld('Ref', (e) => refEntry(e.repo, 'refs/heads/' + e.item.pull.base)),
  isDraft: fld('Boolean!', (e) => e.item.pull.draft),
  merged: fld('Boolean!', (e) => e.item.pull.merged),
  mergedAt: fld('DateTime', (e) => trimT(e.item.pull.mergedAt)),
  mergeable: fld('MergeableState!', (e) => { const ok = C.pullMergeable(e.repo, e.item); return ok === null ? 'UNKNOWN' : ok ? 'MERGEABLE' : 'CONFLICTING'; }),
  mergeCommit: fld('Commit', (e) => (e.item.pull.mergeSha ? { oid: e.item.pull.mergeSha, commit: readCommit(e.repo.objects, e.item.pull.mergeSha) } : null)),
  changedFiles: fld('Int!', (e) => C.pullFileList(e.repo, e.item).length),
  additions: fld('Int!', (e) => C.pullFileList(e.repo, e.item).reduce((s, x) => s + x.additions, 0)),
  deletions: fld('Int!', (e) => C.pullFileList(e.repo, e.item).reduce((s, x) => s + x.deletions, 0)),
  files: fld('PullRequestChangedFileConnection', (e, a) => relayWindow(C.pullFileList(e.repo, e.item), a), { ...PAGE }),
});
function orderedItems(list, a, stateOf) {
  let out = list;
  const filterStates = (a.filterBy && Array.isArray(a.filterBy.states) && a.filterBy.states.length ? a.filterBy.states : null) || (Array.isArray(a.states) && a.states.length ? a.states : null);
  if (filterStates) out = out.filter((it) => filterStates.includes(stateOf(it)));
  const filterLabels = (a.filterBy && Array.isArray(a.filterBy.labels) && a.filterBy.labels.length ? a.filterBy.labels : null) || (Array.isArray(a.labels) && a.labels.length ? a.labels : null);
  if (filterLabels) {
    const want = filterLabels.map((l) => String(l).toLowerCase());
    out = out.filter((it) => it.labels.some((l) => want.includes(l.name.toLowerCase())));
  }
  if (a.headRefName) out = out.filter((it) => it.pull && it.pull.head === a.headRefName);
  if (a.baseRefName) out = out.filter((it) => it.pull && it.pull.base === a.baseRefName);
  out = out.slice();
  const field = a.orderBy && a.orderBy.field;
  if (field === 'UPDATED_AT') out.sort((x, y) => (x.updatedAt < y.updatedAt ? -1 : x.updatedAt > y.updatedAt ? 1 : x.number - y.number));
  else if (field === 'COMMENTS') out.sort((x, y) => x.comments.length - y.comments.length || x.number - y.number);
  else out.sort((x, y) => x.number - y.number);
  if (a.orderBy && a.orderBy.direction === 'DESC') out.reverse();
  return out.map(entityOf);
}
const issueStateOf = (it) => (it.state === 'open' ? 'OPEN' : 'CLOSED');
const pullStateOf = (it) => (it.pull.merged ? 'MERGED' : it.state === 'open' ? 'OPEN' : 'CLOSED');
defObj('Repository', {
  id: fld('ID!', (e) => e.repo.nodeId),
  databaseId: fld('Int', (e) => e.repo.id),
  name: fld('String!', (e) => e.repo.name),
  nameWithOwner: fld('String!', (e) => e.repo.fullName),
  description: fld('String', (e) => e.repo.description),
  url: fld('URI!', (e, a, c) => c.base + '/' + e.repo.fullName),
  owner: fld('RepositoryOwner!', (e) => userNode(e.repo.owner)),
  isPrivate: fld('Boolean!', (e) => e.repo.isPrivate),
  visibility: fld('RepositoryVisibility!', (e) => (e.repo.isPrivate ? 'PRIVATE' : 'PUBLIC')),
  isFork: fld('Boolean!', () => false),
  isArchived: fld('Boolean!', () => false),
  isEmpty: fld('Boolean!', (e) => e.repo.refs.size === 0),
  createdAt: fld('DateTime!', (e) => trimT(e.repo.createdAt)),
  updatedAt: fld('DateTime!', (e) => trimT(e.repo.updatedAt)),
  pushedAt: fld('DateTime', (e) => trimT(e.repo.pushedAt)),
  defaultBranchRef: fld('Ref', (e) => refEntry(e.repo, 'refs/heads/' + e.repo.trunk)),
  ref: fld('Ref', (e, a) => refEntry(e.repo, a.qualifiedName.startsWith('refs/') ? a.qualifiedName : 'refs/heads/' + a.qualifiedName), { qualifiedName: 'String!' }),
  refs: fld('RefConnection', (e, a) => relayWindow([...e.repo.refs.keys()].filter((r) => r.startsWith(a.refPrefix || 'refs/')).sort().map((r) => ({ repo: e.repo, ref: r })), a), { refPrefix: 'String!', ...PAGE }),
  viewerPermission: fld('RepositoryPermission', () => 'ADMIN'),
  viewerCanAdminister: fld('Boolean!', () => true),
  hasIssuesEnabled: fld('Boolean!', (e) => e.repo.issuesOn),
  issue: fld('Issue', (e, a) => { const it = e.repo.items.get(a.number); return it && !it.pull ? entityOf(it) : null; }, { number: 'Int!' }),
  pullRequest: fld('PullRequest', (e, a) => { const it = e.repo.items.get(a.number); return it && it.pull ? entityOf(it) : null; }, { number: 'Int!' }),
  issueOrPullRequest: fld('IssueOrPullRequest', (e, a) => entityOf(e.repo.items.get(a.number)), { number: 'Int!' }),
  issues: fld('IssueConnection!', (e, a) => relayWindow(orderedItems(e.repo.onlyIssues, a, issueStateOf), a), { ...PAGE, states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]', filterBy: 'IssueFilters' }),
  pullRequests: fld('PullRequestConnection!', (e, a) => relayWindow(orderedItems(e.repo.onlyPulls, a, pullStateOf), a), { ...PAGE, states: '[PullRequestState!]', orderBy: 'IssueOrder', labels: '[String!]', headRefName: 'String', baseRefName: 'String' }),
  labels: fld('LabelConnection', (e, a) => relayWindow([...e.repo.labels.values()], a), { ...PAGE, query: 'String' }),
  label: fld('Label', (e, a) => e.repo.labels.get(String(a.name).toLowerCase()) || null, { name: 'String!' }),
});
gqlTypes.Node = { kind: 'INTERFACE', name: 'Node', fields: { id: fld('ID!', (e) => (e.repo && e.kind === 'Repository' ? e.repo.nodeId : e.item.nodeId)) }, possible: ['Repository', 'Issue', 'PullRequest', 'IssueComment'] };
gqlTypes.IssueOrPullRequest = { kind: 'UNION', name: 'IssueOrPullRequest', fields: {}, possible: ['Issue', 'PullRequest'] };
gqlTypes.SearchResultItem = { kind: 'UNION', name: 'SearchResultItem', fields: {}, possible: ['Issue', 'PullRequest', 'Repository'] };

function runSearch(a) {
  const words = [];
  let repoFilter = null, want = null, state = null;
  for (const term of String(a.query || '').split(/\s+/).filter(Boolean)) {
    const low = term.toLowerCase();
    if (low.startsWith('repo:')) repoFilter = low.slice(5);
    else if (low === 'is:issue' || low === 'type:issue') want = 'issue';
    else if (low === 'is:pr' || low === 'type:pr') want = 'pr';
    else if (low === 'is:open' || low === 'state:open') state = 'open';
    else if (low === 'is:closed' || low === 'state:closed') state = 'closed';
    else if (!/^[a-z]+:/.test(low)) words.push(low.replace(/^"|"$/g, ''));
  }
  const out = [];
  for (const r of allRepos.values()) {
    if (repoFilter && r.fullName.toLowerCase() !== repoFilter) continue;
    if (a.type === 'REPOSITORY') {
      if (words.every((w) => r.fullName.toLowerCase().includes(w) || (r.description || '').toLowerCase().includes(w))) out.push(entityOf(r));
      continue;
    }
    if (a.type !== 'ISSUE') continue;
    for (const it of r.items.values()) {
      if (want === 'issue' && it.pull) continue;
      if (want === 'pr' && !it.pull) continue;
      if (state && it.state !== state) continue;
      const hay = (it.title + '\n' + it.body).toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push(entityOf(it));
    }
  }
  const c = relayWindow(out, a);
  c.issueCount = a.type === 'ISSUE' ? out.length : 0;
  c.repositoryCount = a.type === 'REPOSITORY' ? out.length : 0;
  return c;
}
defObj('RateLimit', { limit: fld('Int!'), cost: fld('Int!'), remaining: fld('Int!'), used: fld('Int!'), resetAt: fld('DateTime!'), nodeCount: fld('Int!') });
defObj('Query', {
  viewer: fld('User!', () => userNode(OWNER_LOGIN)),
  repository: fld('Repository', (s, a) => entityOf(lookupRepo(a.owner, a.name)), { owner: 'String!', name: 'String!', followRenames: 'Boolean' }),
  node: fld('Node', (s, a) => allNodes.get(a.id) || null, { id: 'ID!' }),
  nodes: fld('[Node]!', (s, a) => (a.ids || []).map((id) => allNodes.get(id) || null), { ids: '[ID!]!' }),
  user: fld('User', (s, a) => (a.login === OWNER_LOGIN || reposOf(a.login).length ? userNode(a.login) : null), { login: 'String!' }),
  repositoryOwner: fld('RepositoryOwner', (s, a) => (a.login === OWNER_LOGIN || reposOf(a.login).length ? userNode(a.login) : null), { login: 'String!' }),
  organization: fld('Organization', (s, a) => (/-org$/.test(a.login) ? { kind: 'Organization', login: a.login } : null), { login: 'String!' }),
  search: fld('SearchResultItemConnection!', (s, a) => runSearch(a), { query: 'String!', type: 'SearchType!', ...PAGE }),
  rateLimit: fld('RateLimit', () => ({ limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: trimT(new Date(1893456000000).toISOString()), nodeCount: 1 }), { dryRun: 'Boolean' }),
});
function demandNode(id, kinds) {
  const e = allNodes.get(id);
  if (!e || !kinds.includes(e.kind)) throw new HttpFault(404, "Could not resolve to a node with the global id of '" + id + "'");
  return e;
}
const payloadOf = (name, fields) => defObj(name, { clientMutationId: fld('String'), ...fields });
payloadOf('CreateIssuePayload', { issue: fld('Issue') });
payloadOf('CloseIssuePayload', { issue: fld('Issue') });
payloadOf('ReopenIssuePayload', { issue: fld('Issue') });
payloadOf('UpdateIssuePayload', { issue: fld('Issue') });
payloadOf('CreatePullRequestPayload', { pullRequest: fld('PullRequest') });
payloadOf('MergePullRequestPayload', { pullRequest: fld('PullRequest') });
payloadOf('ClosePullRequestPayload', { pullRequest: fld('PullRequest') });
payloadOf('AddCommentPayload', { commentEdge: fld('IssueCommentEdge'), subject: fld('Node'), timelineEdge: fld('IssueCommentEdge') });
payloadOf('CreateRepositoryPayload', { repository: fld('Repository') });
const cmid = (a) => (a.input && typeof a.input.clientMutationId === 'string' ? a.input.clientMutationId : null);
defObj('Mutation', {
  createIssue: fld('CreateIssuePayload', (s, a) => {
    const e = demandNode(a.input.repositoryId, ['Repository']);
    const labels = (a.input.labelIds || []).map((id) => [...e.repo.labels.values()].find((l) => l.nodeId === id)).filter(Boolean).map((l) => l.name);
    const it = C.openIssue(e.repo, { title: a.input.title, body: a.input.body, labels });
    return { clientMutationId: cmid(a), issue: entityOf(it) };
  }, { input: 'CreateIssueInput!' }),
  closeIssue: fld('CloseIssuePayload', (s, a) => {
    const e = demandNode(a.input.issueId, ['Issue']);
    C.changeState(e.item, 'closed', a.input.stateReason ? String(a.input.stateReason).toLowerCase() : null);
    return { clientMutationId: cmid(a), issue: e };
  }, { input: 'CloseIssueInput!' }),
  reopenIssue: fld('ReopenIssuePayload', (s, a) => {
    const e = demandNode(a.input.issueId, ['Issue']);
    C.changeState(e.item, 'open', null);
    return { clientMutationId: cmid(a), issue: e };
  }, { input: 'ReopenIssueInput!' }),
  updateIssue: fld('UpdateIssuePayload', (s, a) => {
    const e = demandNode(a.input.id, ['Issue']);
    const patch = {};
    if (typeof a.input.title === 'string') patch.title = a.input.title;
    if (typeof a.input.body === 'string') patch.body = a.input.body;
    if (a.input.state) patch.state = String(a.input.state).toLowerCase();
    C.patchItem(e.repo, e.item, patch);
    return { clientMutationId: cmid(a), issue: e };
  }, { input: 'UpdateIssueInput!' }),
  createPullRequest: fld('CreatePullRequestPayload', (s, a) => {
    const e = demandNode(a.input.repositoryId, ['Repository']);
    const it = C.openPull(e.repo, { title: a.input.title, body: a.input.body, head: a.input.headRefName, base: a.input.baseRefName, draft: a.input.draft });
    return { clientMutationId: cmid(a), pullRequest: entityOf(it) };
  }, { input: 'CreatePullRequestInput!' }),
  mergePullRequest: fld('MergePullRequestPayload', (s, a) => {
    const e = demandNode(a.input.pullRequestId, ['PullRequest']);
    C.doMerge(e.repo, e.item, { merge_method: a.input.mergeMethod ? String(a.input.mergeMethod).toLowerCase() : 'merge', commit_title: a.input.commitHeadline, commit_message: a.input.commitBody, sha: a.input.expectedHeadOid });
    return { clientMutationId: cmid(a), pullRequest: e };
  }, { input: 'MergePullRequestInput!' }),
  closePullRequest: fld('ClosePullRequestPayload', (s, a) => {
    const e = demandNode(a.input.pullRequestId, ['PullRequest']);
    C.changeState(e.item, 'closed', null);
    return { clientMutationId: cmid(a), pullRequest: e };
  }, { input: 'ClosePullRequestInput!' }),
  addComment: fld('AddCommentPayload', (s, a) => {
    const e = demandNode(a.input.subjectId, ['Issue', 'PullRequest']);
    const c = C.postComment(e.repo, e.item, a.input.body);
    const edge = { node: entityOf(c), cursor: cursorFor(e.item.comments.length - 1) };
    return { clientMutationId: cmid(a), commentEdge: edge, timelineEdge: edge, subject: e };
  }, { input: 'AddCommentInput!' }),
  createRepository: fld('CreateRepositoryPayload', (s, a) => {
    const repo = openRepo(OWNER_LOGIN, { name: a.input.name, description: a.input.description, private: a.input.visibility !== 'PUBLIC' });
    return { clientMutationId: cmid(a), repository: entityOf(repo) };
  }, { input: 'CreateRepositoryInput!' }),
});
export function concreteTypeOf(value) {
  if (value && typeof value.kind === 'string' && gqlTypes[value.kind]) return value.kind;
  return null;
}

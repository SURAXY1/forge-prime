// GraphQL endpoint for forge-prime: validate a parsed document against the
// schema table, then execute it. Introspection is served from the same
// table, so what __type reports is exactly what execution accepts.
import { HttpFault } from './core.ts';
import { parseGqlDocument } from './gqlparse.ts';
import { gqlTypes, concreteTypeOf } from './gqlschema.ts';

const refOf = (text) => {
  if (text.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: refOf(text.slice(0, -1)) };
  if (text.startsWith('[')) return { kind: 'LIST', name: null, ofType: refOf(text.slice(1, -1)) };
  return gqlTypes[text] || { kind: 'SCALAR', name: text };
};
const bareName = (text) => text.replace(/[\[\]!]/g, '');
const inputsOf = (table) => Object.keys(table || {}).map((name) => ({ name, description: null, type: refOf(table[name]), defaultValue: null }));
const mk = (type, resolve, args) => ({ type, resolve, args: args || null });
const WITH_DEP = { includeDeprecated: 'Boolean' };

gqlTypes.__Type = {
  kind: 'OBJECT', name: '__Type',
  fields: {
    kind: mk('String!'), name: mk('String'),
    description: mk('String', () => null), specifiedByURL: mk('String', () => null),
    fields: mk('[__Field!]', (t) => (t.kind === 'OBJECT' || t.kind === 'INTERFACE' ? Object.keys(t.fields).filter((n) => !n.startsWith('__')).map((name) => ({ name, def: t.fields[name] })) : null), WITH_DEP),
    interfaces: mk('[__Type!]', (t) => (t.kind === 'OBJECT' ? Object.values(gqlTypes).filter((i) => i.kind === 'INTERFACE' && i.possible.includes(t.name)) : null)),
    possibleTypes: mk('[__Type!]', (t) => (t.possible ? t.possible.map((n) => gqlTypes[n]) : null)),
    enumValues: mk('[__EnumValue!]', (t) => (t.kind === 'ENUM' ? t.values.map((name) => ({ name })) : null), WITH_DEP),
    inputFields: mk('[__InputValue!]', (t) => (t.kind === 'INPUT_OBJECT' ? inputsOf(t.inputFields) : null), WITH_DEP),
    ofType: mk('__Type', (t) => t.ofType || null),
  },
};
gqlTypes.__Field = {
  kind: 'OBJECT', name: '__Field',
  fields: {
    name: mk('String!'), description: mk('String', () => null),
    args: mk('[__InputValue!]!', (x) => inputsOf(x.def.args), WITH_DEP),
    type: mk('__Type!', (x) => refOf(x.def.type)),
    isDeprecated: mk('Boolean!', () => false), deprecationReason: mk('String', () => null),
  },
};
gqlTypes.__InputValue = { kind: 'OBJECT', name: '__InputValue', fields: { name: mk('String!'), description: mk('String'), type: mk('__Type!'), defaultValue: mk('String'), isDeprecated: mk('Boolean!', () => false), deprecationReason: mk('String', () => null) } };
gqlTypes.__EnumValue = { kind: 'OBJECT', name: '__EnumValue', fields: { name: mk('String!'), description: mk('String', () => null), isDeprecated: mk('Boolean!', () => false), deprecationReason: mk('String', () => null) } };
gqlTypes.__Directive = { kind: 'OBJECT', name: '__Directive', fields: { name: mk('String!'), description: mk('String', () => null), locations: mk('[String!]!'), args: mk('[__InputValue!]!', (d) => inputsOf(d.args), WITH_DEP), isRepeatable: mk('Boolean!', () => false) } };
gqlTypes.__Schema = {
  kind: 'OBJECT', name: '__Schema',
  fields: {
    description: mk('String', () => null),
    queryType: mk('__Type!', () => gqlTypes.Query),
    mutationType: mk('__Type', () => gqlTypes.Mutation),
    subscriptionType: mk('__Type', () => null),
    types: mk('[__Type!]!', () => Object.values(gqlTypes)),
    directives: mk('[__Directive!]!', () => [
      { name: 'include', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: { if: 'Boolean!' } },
      { name: 'skip', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: { if: 'Boolean!' } },
    ]),
  },
};
gqlTypes.Query.fields.__type = mk('__Type', (s, a) => gqlTypes[a.name] || null, { name: 'String!' });
gqlTypes.Query.fields.__schema = mk('__Schema!', () => ({}));

function validateDocument(doc, op) {
  const errors = [];
  const visited = new Set();
  const walk = (selections, typeName, path) => {
    const type = gqlTypes[typeName];
    for (const sel of selections) {
      if (sel.kind === 'field') {
        if (sel.name === '__typename') continue;
        const def = type && type.fields ? type.fields[sel.name] : null;
        if (!def) {
          errors.push({ path: [...path, sel.alias], extensions: { code: 'undefinedField', typeName, fieldName: sel.name }, message: "Field '" + sel.name + "' doesn't exist on type '" + typeName + "'" });
          continue;
        }
        for (const [argName] of sel.args) {
          if (!def.args || !(argName in def.args)) errors.push({ path: [...path, sel.alias, argName], extensions: { code: 'argumentNotAccepted', name: sel.name, typeName: 'Field', argumentName: argName }, message: "Field '" + sel.name + "' doesn't accept argument '" + argName + "'" });
        }
        if (def.args) {
          for (const argName of Object.keys(def.args)) {
            if (def.args[argName].endsWith('!') && !sel.args.some((a) => a[0] === argName)) errors.push({ path: [...path, sel.alias], extensions: { code: 'missingRequiredArguments', className: 'Field', name: sel.name, arguments: argName }, message: "Field '" + sel.name + "' is missing required arguments: " + argName });
          }
        }
        const inner = gqlTypes[bareName(def.type)];
        const composite = inner && (inner.kind === 'OBJECT' || inner.kind === 'INTERFACE' || inner.kind === 'UNION');
        if (composite && !sel.selections) errors.push({ path: [...path, sel.alias], extensions: { code: 'selectionMismatch', nodeName: "field '" + sel.name + "'", typeName: inner.name }, message: "Field must have selections (field '" + sel.name + "' returns " + inner.name + " but has no selections. Did you mean '" + sel.name + " { ... }'?)" });
        else if (!composite && sel.selections) errors.push({ path: [...path, sel.alias], extensions: { code: 'selectionMismatch', nodeName: "field '" + sel.name + "'", typeName: bareName(def.type) }, message: "Selections can't be made on scalars (field '" + sel.name + "' returns " + bareName(def.type) + ' but has selections)' });
        else if (composite) walk(sel.selections, inner.name, [...path, sel.alias]);
      } else if (sel.kind === 'inline') {
        const on = sel.on || typeName;
        if (!gqlTypes[on] || !gqlTypes[on].fields) errors.push({ path, extensions: { code: 'undefinedType', typeName: on }, message: 'No such type ' + on + ", so it can't be a fragment condition" });
        else walk(sel.selections, on, [...path, '... on ' + on]);
      } else {
        const frag = doc.fragments.get(sel.name);
        if (!frag) errors.push({ path, extensions: { code: 'undefinedFragment', fragmentName: sel.name }, message: 'Fragment ' + sel.name + ' was used, but not defined' });
        else if (!visited.has(sel.name)) {
          visited.add(sel.name);
          if (!gqlTypes[frag.on] || !gqlTypes[frag.on].fields) errors.push({ path, extensions: { code: 'undefinedType', typeName: frag.on }, message: 'No such type ' + frag.on + ", so it can't be a fragment condition" });
          else walk(frag.selections, frag.on, ['fragment ' + sel.name]);
        }
      }
    }
  };
  walk(op.selections, op.type === 'mutation' ? 'Mutation' : 'Query', [op.type + (op.name ? ' ' + op.name : '')]);
  return errors;
}

function literalValue(node, vars) {
  if (node.kind === 'var') return vars[node.v];
  if (node.kind === 'list') return node.v.map((x) => literalValue(x, vars));
  if (node.kind === 'obj') { const out = {}; for (const [k, v] of node.v) out[k] = literalValue(v, vars); return out; }
  return node.v;
}
function executeOperation(doc, op, variables, ctx) {
  const vars = {};
  for (const v of op.variables) {
    if (variables && variables[v.name] !== undefined) vars[v.name] = variables[v.name];
    else if (v.def !== undefined) vars[v.name] = literalValue(v.def, {});
  }
  const passes = (dirs) => {
    for (const d of dirs) {
      const cond = d.args.find((a) => a[0] === 'if');
      const val = cond ? literalValue(cond[1], vars) : true;
      if (d.name === 'skip' && val === true) return false;
      if (d.name === 'include' && val === false) return false;
    }
    return true;
  };
  const appliesTo = (on, typeName) => !on || on === typeName || (gqlTypes[on] && gqlTypes[on].possible && gqlTypes[on].possible.includes(typeName));
  const gather = (selections, typeName, out) => {
    for (const sel of selections) {
      if (!passes(sel.directives)) continue;
      if (sel.kind === 'field') {
        const prior = out.get(sel.alias);
        if (prior) { if (sel.selections) prior.selections = (prior.selections || []).concat(sel.selections); }
        else out.set(sel.alias, { name: sel.name, args: sel.args, selections: sel.selections });
      } else if (sel.kind === 'inline') { if (appliesTo(sel.on, typeName)) gather(sel.selections, typeName, out); }
      else { const frag = doc.fragments.get(sel.name); if (frag && appliesTo(frag.on, typeName)) gather(frag.selections, typeName, out); }
    }
    return out;
  };
  const completeValue = (value, typeText, selections) => {
    if (value === null || value === undefined) return null;
    let t = typeText;
    if (t.endsWith('!')) t = t.slice(0, -1);
    if (t.startsWith('[')) { const inner = t.slice(1, -1); return Array.isArray(value) ? value.map((v) => completeValue(v, inner, selections)) : null; }
    const type = gqlTypes[t];
    if (!type || !type.fields || !selections) return value;
    const concrete = type.kind === 'OBJECT' ? t : concreteTypeOf(value) || t;
    return runFields(value, concrete, selections);
  };
  const resolveOne = (src, typeName, fld) => {
    if (fld.name === '__typename') return typeName;
    const def = (gqlTypes[typeName].fields || {})[fld.name];
    if (!def) return null;
    const args = {};
    for (const [k, v] of fld.args) args[k] = literalValue(v, vars);
    const raw = def.resolve ? def.resolve(src, args, ctx) : src[fld.name];
    return completeValue(raw, def.type, fld.selections);
  };
  const runFields = (src, typeName, selections) => {
    const out = {};
    for (const [alias, fld] of gather(selections, typeName, new Map())) out[alias] = resolveOne(src, typeName, fld);
    return out;
  };
  const rootName = op.type === 'mutation' ? 'Mutation' : 'Query';
  const data = {}, errors = [];
  for (const [alias, fld] of gather(op.selections, rootName, new Map())) {
    try { data[alias] = resolveOne({}, rootName, fld); }
    catch (e) {
      data[alias] = null;
      const status = e instanceof HttpFault ? e.status : 500;
      let message = String((e && e.message) || e);
      if (e instanceof HttpFault && Array.isArray(e.errors) && e.errors[0] && e.errors[0].message) message = e.errors[0].message;
      errors.push({ type: status === 404 ? 'NOT_FOUND' : status === 500 ? 'INTERNAL' : 'UNPROCESSABLE', path: [alias], locations: [{ line: 1, column: 1 }], message });
    }
  }
  return errors.length ? { data, errors } : { data };
}
function runRequest(req, ctx) {
  if (req === null || typeof req !== 'object' || Array.isArray(req) || typeof req.query !== 'string' || req.query.trim() === '') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  let doc;
  try { doc = parseGqlDocument(req.query); } catch (e) { return { errors: [{ message: String(e.message || e), locations: [{ line: 1, column: 1 }] }] }; }
  let op = doc.operations[0];
  if (typeof req.operationName === 'string' && req.operationName !== '') {
    op = doc.operations.find((o) => o.name === req.operationName);
    if (!op) return { errors: [{ message: 'No operation named "' + req.operationName + '"' }] };
  } else if (doc.operations.length > 1) return { errors: [{ message: 'An operation name is required' }] };
  if (op.type === 'subscription') return { errors: [{ message: 'Subscriptions are not served' }] };
  const problems = validateDocument(doc, op);
  if (problems.length) return { errors: problems.map((p) => ({ ...p, locations: [{ line: 1, column: 1 }] })) };
  const variables = req.variables && typeof req.variables === 'object' ? req.variables : {};
  return executeOperation(doc, op, variables, ctx);
}
export function handleGraphqlHttp(ctx) {
  let parsed;
  try { parsed = JSON.parse(ctx.body.toString('utf8')); }
  catch { return { status: 400, body: JSON.stringify({ message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/graphql' }) }; }
  const out = Array.isArray(parsed) ? parsed.map((r) => runRequest(r, ctx)) : runRequest(parsed, ctx);
  return { status: 200, body: JSON.stringify(out) };
}

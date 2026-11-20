// A compact GraphQL document parser for forge-prime: operations, named
// fragments, variable definitions with defaults, directives, and every
// literal value kind the GitHub clients send.

const PUNCT_CHARS = '!$&()...:=@[]{|}';

function tokenise(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ',' || c === '﻿') { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.startsWith('...', i)) { toks.push({ k: 'p', v: '...', at: i }); i += 3; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new Error('Unterminated block string');
        toks.push({ k: 's', v: src.slice(i + 3, end).replace(/\\"""/g, '"""').trim(), at: i });
        i = end + 3; continue;
      }
      let j = i + 1, out = '';
      for (;;) {
        if (j >= n || src[j] === '\n') throw new Error('Unterminated string');
        const d = src[j];
        if (d === '"') break;
        if (d === '\\') {
          const e = src[j + 1];
          if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; }
          else { out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[e] ?? e; j += 2; }
        } else { out += d; j++; }
      }
      toks.push({ k: 's', v: out, at: i });
      i = j + 1; continue;
    }
    if ((c >= '0' && c <= '9') || c === '-') {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 40));
      if (!m) throw new Error('Unexpected character "' + c + '"');
      toks.push({ k: 'n', v: Number(m[0]), at: i });
      i += m[0].length; continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ k: 'w', v: src.slice(i, j), at: i });
      i = j; continue;
    }
    if (PUNCT_CHARS.includes(c)) { toks.push({ k: 'p', v: c, at: i }); i++; continue; }
    throw new Error('Unexpected character "' + c + '"');
  }
  toks.push({ k: 'eof', v: '<EOF>', at: n });
  return toks;
}

export function parseGqlDocument(src) {
  const toks = tokenise(src);
  let pos = 0;
  const peek = () => toks[pos];
  const isP = (v) => toks[pos].k === 'p' && toks[pos].v === v;
  const fail = (what) => { throw new Error('Parse error on "' + toks[pos].v + '" (' + what + ') at offset ' + toks[pos].at); };
  const eat = (v) => { if (!isP(v)) fail('expected ' + v); pos++; };
  const word = () => { if (toks[pos].k !== 'w') fail('expected a name'); return toks[pos++].v; };

  function readValue(constOnly) {
    const t = peek();
    if (t.k === 's' || t.k === 'n') { pos++; return { kind: t.k === 's' ? 'str' : 'num', v: t.v }; }
    if (t.k === 'w') {
      pos++;
      if (t.v === 'true' || t.v === 'false') return { kind: 'bool', v: t.v === 'true' };
      if (t.v === 'null') return { kind: 'null', v: null };
      return { kind: 'enum', v: t.v };
    }
    if (isP('$')) { if (constOnly) fail('variable in constant'); pos++; return { kind: 'var', v: word() }; }
    if (isP('[')) { pos++; const items = []; while (!isP(']')) items.push(readValue(constOnly)); pos++; return { kind: 'list', v: items }; }
    if (isP('{')) {
      pos++; const fields = [];
      while (!isP('}')) { const name = word(); eat(':'); fields.push([name, readValue(constOnly)]); }
      pos++; return { kind: 'obj', v: fields };
    }
    return fail('expected a value');
  }
  function readArgs() {
    const out = [];
    if (!isP('(')) return out;
    pos++;
    while (!isP(')')) { const name = word(); eat(':'); out.push([name, readValue(false)]); }
    pos++;
    return out;
  }
  function readDirectives() {
    const out = [];
    while (isP('@')) { pos++; out.push({ name: word(), args: readArgs() }); }
    return out;
  }
  function readTypeRef() {
    let text;
    if (isP('[')) { pos++; text = '[' + readTypeRef() + ']'; eat(']'); } else text = word();
    if (isP('!')) { pos++; text += '!'; }
    return text;
  }
  function readSelections() {
    eat('{');
    const out = [];
    while (!isP('}')) {
      if (isP('...')) {
        pos++;
        if (peek().k === 'w' && peek().v !== 'on') { out.push({ kind: 'spread', name: word(), directives: readDirectives() }); continue; }
        let on = null;
        if (peek().k === 'w') { pos++; on = word(); }
        const dirs = readDirectives();
        out.push({ kind: 'inline', on, directives: dirs, selections: readSelections() });
        continue;
      }
      let name = word(), alias = name;
      if (isP(':')) { pos++; name = word(); }
      const a = readArgs();
      const dirs = readDirectives();
      const selections = isP('{') ? readSelections() : null;
      out.push({ kind: 'field', name, alias, args: a, directives: dirs, selections });
    }
    pos++;
    if (out.length === 0) fail('empty selection set');
    return out;
  }

  const doc = { operations: [], fragments: new Map() };
  while (peek().k !== 'eof') {
    if (isP('{')) { doc.operations.push({ type: 'query', name: null, variables: [], selections: readSelections() }); continue; }
    const kw = word();
    if (kw === 'fragment') {
      const name = word();
      if (word() !== 'on') fail('expected "on"');
      const on = word();
      readDirectives();
      doc.fragments.set(name, { name, on, selections: readSelections() });
      continue;
    }
    if (kw !== 'query' && kw !== 'mutation' && kw !== 'subscription') fail('expected query, mutation or fragment');
    const op = { type: kw, name: null, variables: [], selections: null };
    if (peek().k === 'w') op.name = word();
    if (isP('(')) {
      pos++;
      while (!isP(')')) {
        eat('$');
        const name = word(); eat(':');
        const type = readTypeRef();
        let def;
        if (isP('=')) { pos++; def = readValue(true); }
        readDirectives();
        op.variables.push({ name, type, def });
      }
      pos++;
    }
    readDirectives();
    op.selections = readSelections();
    doc.operations.push(op);
  }
  if (doc.operations.length === 0) throw new Error('Parse error: the document defines no operation');
  return doc;
}

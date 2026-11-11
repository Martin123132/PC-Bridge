import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createSiriShortcutsApp, parseSiriAction, parseSiriIntent, SIRI_ACTIONS } from '../src/siri-shortcuts.mjs';

const key = 'e'.repeat(64);
const headers = { 'x-siri-key': key };
async function withApp(t, opts = {}) {
  const server = createSiriShortcutsApp({ token: key, ...opts });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}
function post(url, input, options = {}) {
  return fetch(url + '/v1/action', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', ...options.headers },
    body: typeof input === 'string' ? input : JSON.stringify(input),
  });
}

test('intent parser accepts only a small explicit command set', () => {
  assert.deepEqual(SIRI_ACTIONS, ['status', 'check_codex', 'open_notepad', 'open_calculator', 'open_explorer','codex_tasks','accessibility_build','review_accessibility_build','open_apple_music','open_google','search_google']);
  assert.equal(parseSiriAction({ request: 'open notepad' }), 'open_notepad');
  assert.equal(parseSiriAction({ request: 'Please open the calculator on my PC.' }), 'open_calculator');
  assert.equal(parseSiriAction({ request: 'launch file explorer' }), 'open_explorer');
  assert.equal(parseSiriAction({ request: 'check my PC' }), 'status');
  assert.equal(parseSiriAction({ request: 'open Apple Music' }), 'open_apple_music');
  assert.equal(parseSiriAction({ request: 'open Google' }), 'open_google');
  assert.equal(parseSiriAction({ request: 'Search Google for orbital mechanics' }), 'search_google');
  assert.deepEqual(parseSiriIntent({request:'Search Google for orbital mechanics'}),{action:'search_google',query:'orbital mechanics'});
  assert.deepEqual(parseSiriIntent({action:'search_google',query:'NGC 3198'}),{action:'search_google',query:'NGC 3198'});
  assert.equal(parseSiriAction({request:'Search Google for'}),null);
  assert.equal(parseSiriAction({action:'search_google'}),null);
  assert.equal(parseSiriAction({action:'search_google',query:'\u0000inject'}),null);
  assert.equal(parseSiriAction({ request: 'check codex is running' }), 'check_codex');
  assert.equal(parseSiriAction({ request: "What's Codex working on?" }), 'codex_tasks');
  assert.equal(parseSiriAction({ request: 'check Codex tasks' }), 'codex_tasks');
  assert.equal(parseSiriAction({ request: 'Check accessibility build' }), 'accessibility_build');
  assert.equal(parseSiriAction({ request: 'Check accessibility build and open results' }), 'review_accessibility_build');
  assert.equal(parseSiriAction({ request: 'check accessibility build and open command prompt' }), null);
  assert.equal(parseSiriAction({ action: 'open_notepad' }), 'open_notepad');
  assert.equal(parseSiriAction({ request: 'open notepad and close all files' }), null);
  assert.equal(parseSiriAction({ request: 'run powershell' }), null);
  assert.equal(parseSiriAction({ action: 'open_notepad', command: 'anything' }), null);
  assert.equal(parseSiriAction({ request: 'open chrome' }), null);
  assert.equal(parseSiriAction({ request: 'a'.repeat(500) }), null);
});

test('authenticated status returns a live handler result with no predefined text', async t => {
  let calls = 0;
  const events = [];
  const url = await withApp(t, {
    handlers: { status: async () => { calls++; return 'Windows reports 31.8 GB RAM.'; } },
    authorise: async action => action === 'status',
    record: async event => events.push(event),
  });
  const result = await post(url, { request: 'check my PC' });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), 'Windows reports 31.8 GB RAM.');
  assert.equal(calls, 1);
  assert.deepEqual(events, [{ action: 'status', outcome: 'requested' }, { action: 'status', outcome: 'ok' }]);
});

test('credential, origin, content-type, and HTTP method gates', async t => {
  const url = await withApp(t, {
    handlers: { status: async () => 'Okay.' },
    authorise: async () => true,
  });
  assert.equal((await fetch(url + '/v1/capabilities')).status, 401);
  assert.equal((await fetch(url + '/v1/capabilities', { headers })).status, 200);
  assert.equal((await fetch(url + '/v1/action', { headers })).status, 404);
  assert.equal((await post(url, { action: 'status' }, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await post(url, { action: 'status' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post(url, { action: 'status' }, { headers: { 'x-siri-key': 'f'.repeat(64) } })).status, 401);
});

test('locally disabled launch remains denied; enabling invokes exactly the selected handler', async t => {
  const invoked = [];
  const receipts = [];
  const handlers = {
    status: async () => 'Status',
    open_notepad: async () => { invoked.push('notepad'); return 'Notepad opened.'; },
    open_explorer: async () => { invoked.push('explorer'); return 'Explorer opened.'; },
  };
  let allowed = false;
  const url = await withApp(t, {
    handlers,
    authorise: async action => action === 'status' || allowed,
    record: async receipt => receipts.push(receipt),
    minIntervalMs: 0,
  });
  assert.equal((await post(url, { action: 'open_notepad' })).status, 403);
  assert.deepEqual(invoked, []);
  allowed = true;
  const result = await post(url, { request: 'open notepad' });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), 'Notepad opened.');
  assert.deepEqual(invoked, ['notepad']);
  assert.deepEqual(receipts, [{ action: 'open_notepad', outcome: 'denied' }, { action: 'open_notepad', outcome: 'requested' }, { action: 'open_notepad', outcome: 'ok' }]);
});

test('unknown and oversize commands never invoke handlers', async t => {
  let calls = 0;
  const url = await withApp(t, {
    handlers: { open_notepad: async () => { calls++; return 'Launched.'; } },
    authorise: async () => true,
    minIntervalMs: 0,
  });
  assert.equal((await post(url, { request: 'open notepad then run arbitrary code' })).status, 400);
  assert.equal((await post(url, '{')).status, 400);
  assert.equal((await post(url, { request: 'x'.repeat(800) })).status, 413);
  assert.equal(calls, 0);
});

test('a short cooldown applies to consecutive accepted requests', async t => {
  let time = 1000;
  const url = await withApp(t, {
    handlers: { status: async () => 'Okay.' },
    authorise: async () => true,
    now: () => time,
    minIntervalMs: 500,
  });
  assert.equal((await post(url, { action: 'status' })).status, 200);
  assert.equal((await post(url, { action: 'status' })).status, 429);
  time += 500;
  assert.equal((await post(url, { action: 'status' })).status, 200);
});

// PC Bridge Siri Shortcuts pilot transport.
//
// No server starts on import. Callers must explicitly bind a network interface,
// supply a private credential, and authorise every individual action.
// A future desktop integration must gate actions through BridgeCore and its
// locally configured client ceiling before providing any Windows capability.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export const SIRI_ACTIONS = Object.freeze([
  'status', 'check_codex', 'open_notepad', 'open_calculator', 'open_explorer',
  'codex_tasks', 'accessibility_build', 'review_accessibility_build',
  'open_apple_music', 'open_google', 'search_google',
]);

const ACTIONS = new Set(SIRI_ACTIONS);
const MAX_BODY_BYTES = 512;
const OPEN = {
  'apple music': 'open_apple_music',
  google: 'open_google',
  notepad: 'open_notepad',
  calculator: 'open_calculator',
  'file explorer': 'open_explorer',
};
const OPEN_PATTERN = /^(?:please\s+)?(?:open|launch|start|show)\s+(?:the\s+)?(apple music|google|notepad|calculator|file explorer)(?:\s+(?:on|in)\s+(?:my\s+)?(?:pc|computer|windows))?[.!?]?$/i;
const STATUS_PATTERN = /^(?:please\s+)?(?:check\s+(?:my\s+)?pc|(?:what(?:'s| is)\s+)?(?:my\s+)?pc\s+(?:status|doing)|(?:check|show)\s+(?:the\s+)?(?:status|ram|memory))(?:\s+(?:on|of)\s+(?:my\s+)?(?:pc|computer))?[.!?]?$/i;
const CODEX_PATTERN = /^(?:please\s+)?(?:check|show)\s+(?:whether\s+)?codex\s+(?:is\s+)?(?:running|working|status)(?:\s+(?:on|in)\s+(?:my\s+)?(?:pc|computer))?[.!?]?$/i;
const CODEX_TASK_PATTERN = /^(?:please\s+)?(?:what(?:'s| is)\s+codex\s+working\s+on|what\s+is\s+codex\s+doing|check\s+(?:the\s+)?codex\s+(?:tasks?|jobs?|activity)|what\s+are\s+codex(?:'s)?\s+tasks)[.!?]?$/i;
const BUILD_PATTERN = /^(?:please\s+)?(?:check|review)\s+(?:the\s+)?accessibility(?:\s+ffmpeg)?\s+(?:build|tests?)(?:\s+(?:status|results?))?[.!?]?$/i;
const BUILD_OPEN_PATTERN = /^(?:please\s+)?(?:check|review)\s+(?:the\s+)?accessibility(?:\s+ffmpeg)?\s+build\s+and\s+(?:open|show)\s+(?:the\s+)?results?[.!?]?$/i;

const SEARCH_GOOGLE_PATTERN = /^(?:please\s+)?(?:search\s+(?:(?:on|with)\s+)?google\s+(?:for\s+)?|google\s+(?:search\s+)?(?:for\s+)?)(.+)$/i;
export function validateGoogleQuery(query) {
  if(typeof query!=='string')return null;
  const text=query.trim().replace(/[.!?]$/,'').trim();
  return text.length>=2 && text.length<=120 && !/[\x00-\x1f\x7f]/.test(text)?text:null;
}
export function parseSiriIntent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some(key => !['request','action','query'].includes(key))) return null;
  if(typeof body.action==='string') {
    if(body.action==='search_google' && Object.keys(body).length===2 && Object.hasOwn(body,'query')) {
      const query=validateGoogleQuery(body.query);
      return query?{action:'search_google',query}:null;
    }
    return Object.keys(body).length===1 && ACTIONS.has(body.action) && body.action!=='search_google'?{action:body.action}:null;
  }
  if (typeof body.request !== 'string' || Object.keys(body).length !== 1) return null;
  const q = body.request.trim();
  if (!q || q.length > 180 || /[\x00-\x1f]/.test(q)) return null;
  if(/^(?:please\s+)?search\s+google\s+for\s*$/i.test(q))return null;
  const searching=SEARCH_GOOGLE_PATTERN.exec(q);
  if(searching){const query=validateGoogleQuery(searching[1]);return query?{action:'search_google',query}:null;}
  if (BUILD_OPEN_PATTERN.test(q)) return {action:'review_accessibility_build'};
  if (BUILD_PATTERN.test(q)) return {action:'accessibility_build'};
  if (CODEX_TASK_PATTERN.test(q)) return {action:'codex_tasks'};
  const open = OPEN_PATTERN.exec(q);
  if (open) return OPEN[open[1].toLowerCase()]?{action:OPEN[open[1].toLowerCase()]}:null;
  if (STATUS_PATTERN.test(q)) return {action:'status'};
  if (CODEX_PATTERN.test(q)) return {action:'check_codex'};
  return null;
}
export function parseSiriAction(body){return parseSiriIntent(body)?.action??null;}

const textHeaders = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const send = (res, status, message) => {
  res.writeHead(status, textHeaders);
  res.end(message);
};
function validCredential(received, token) {
  if (typeof received !== 'string' || received.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(token, 'utf8'));
}

export function createSiriShortcutsApp({
  token,
  handlers = {},
  authorise = async () => false,
  record = async () => {},
  now = () => Date.now(),
  minIntervalMs = 300,
} = {}) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('Siri Shortcuts requires a separately generated 32-byte hexadecimal secret.');
  }
  if (typeof authorise !== 'function' || typeof record !== 'function') {
    throw new Error('An explicit local authorisation and receipt provider are required.');
  }
  let lastActionAt = -Infinity;
  const server = http.createServer(async (req, res) => {
    try {
      // Block browser-based requests. Apple Shortcuts sends no Origin header.
      if (req.headers.origin || req.headers['sec-fetch-site']) return send(res, 403, 'Browser requests are not permitted.');
      if (!validCredential(req.headers['x-siri-key'], token)) return send(res, 401, 'Not authorised.');
      if (req.method === 'GET' && req.url === '/v1/capabilities') {
        send(res, 200, SIRI_ACTIONS.join(', '));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/action') return send(res, 404, 'No such operation.');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, 'JSON required.');
      if (now() - lastActionAt < minIntervalMs) return send(res, 429, 'Try again shortly.');
      let size = 0, payload = '';
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return send(res, 413, 'Request is too large.');
        payload += chunk.toString('utf8');
      }
      let input;
      try { input = JSON.parse(payload); }
      catch { return send(res, 400, 'Invalid JSON.'); }
      const intent = parseSiriIntent(input),action=intent?.action;
      if (!action) return send(res, 400, 'Action not recognised. Supported actions: PC status, Codex, build results, Apple Music, Google search and approved Windows apps.');
      const handler = handlers[action];
      if (typeof handler !== 'function' || !await authorise(action)) {
        await record({ action, outcome: 'denied' });
        return send(res, 403, 'This action is not enabled on your PC.');
      }
      // Commit an intent receipt before any Windows action. If the receipt
      // cannot be saved, refuse to execute rather than create unaudited work.
      try { await record({action, outcome:'requested'}); }
      catch { return send(res, 500, 'PC Bridge could not record the request. No action was executed.'); }
      lastActionAt = now();
      let message;
      try {
        message = await handler(intent.query);
        if (typeof message !== 'string' || !message || message.length > 500) throw Error('Invalid action result.');
        await record({ action, outcome: 'ok' });
      } catch {
        await record({ action, outcome: 'failed' });
        return send(res, 500, 'Windows could not complete that action.');
      }
      return send(res, 200, message);
    } catch {
      if (!res.headersSent) send(res, 500, 'Local service error.');
      else res.end();
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  return server;
}

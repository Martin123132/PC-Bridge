import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const idPattern = /^[0-9a-f]{32}$/;
const turnPattern = /^[A-Za-z0-9_-]{8,96}$/;
const managers = new WeakMap();
const executionTools = new Set(['bridge_run_command', 'bridge_launch_process', 'bridge_request_test', 'bridge_run_project_task', 'bridge_protected_shell']);
const writeTools = new Set(['bridge_write_file', 'bridge_propose_write']);
const secret = /sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]{12,}|-----BEGIN [^-]*PRIVATE KEY-----/gi;
const safeText = (value, max) => String(value ?? '').replace(secret, '[REDACTED]').slice(0, max);
export const WORK_SESSION_GUIDE = 'The timeout cushion is PER USER MESSAGE, not a lifetime chat budget. At the start of EVERY reply to a NEW user message (including another go/continue), generate one fresh opaque work_turn_id (8-96 letters/digits/dashes/underscores) and call bridge_work_session action=begin (or bridge_status action=begin). This explicit begin starts 25 minutes even if the previous reply had time left. Carry the returned work_session_id and SAME work_turn_id on EVERY subsequent tool call, retry, reconnect and poll in that reply. Ordinary status/read/command calls NEVER replace an existing message timer. On WORK_TURN_MISMATCH or STALE_WORK_TURN, inspect the returned work_session: for the SAME reply carry its current work_turn_id without resetting anything; only a NEW user message permits an explicit begin with a fresh id. Never mint an id merely to extend a reply. The very first marked contact may initialize an empty clock for compatibility. At 20 minutes wrap up, at 23 save a checkpoint, at 25 report progress and END THE TURN. Before your final reply, even if early, call bridge_work_session action=finish with the CURRENT work_turn_id or period. If that tool is not exposed, bridge_status supports the SAME session actions and fields. Confirm work_session.action_result.action=finish, applied=true and phase=yielded; a plain status response is NOT a finish receipt. Do not make the user restart or unlock Bridge. Legacy clients may use action=resume with the current period and user_requested_continue=true at the start of each NEW user message, even before expiry, then carry the returned work_turn_id. Missing turn identity is advisory only and never a chat-wide lockout. These are cooperative agent-declared message boundaries, not a verified ChatGPT turn signal or a security permission.';

// This error may expose a session only AFTER caller ownership has been checked.
export class WorkTurnError extends Error {
  constructor(row, code) {
    super(`${code}: reply identifier does not match the active message. No timer was reset and no requested operation ran. For this SAME reply use the returned current work_turn_id. Only a NEW user message may use action=begin with a fresh id. Do not restart Bridge.`);
    this.name = 'WorkTurnError'; this.code = code; this.sessionId = row.id;
  }
}

export function workSessionsFor(core) {
  if (!managers.has(core)) managers.set(core, new WorkSessions({ dataDir: core.dataDir, onChange: () => core.emit('change') }));
  return managers.get(core);
}

const MAX_WORK_SESSIONS = 256;
export class WorkSessions {
  constructor({ dataDir, clock = () => Date.now(), onChange = () => {}, durations = [20 * 60000, 23 * 60000, 25 * 60000] }) {
    if (!Array.isArray(durations) || durations.length !== 3 || !durations.every(Number.isSafeInteger) || !(0 < durations[0] && durations[0] < durations[1] && durations[1] < durations[2])) throw Error('Invalid work-period timings');
    this.directory = path.join(dataDir, 'work-sessions');
    this.file = path.join(this.directory, 'state.json');
    this.clock = clock; this.onChange = onChange; this.durations = durations;
    this.state = { version: 2, enabled: true, sessions: [] };
    this.queue = Promise.resolve(); this.ready = this.load();
  }
  async load() {
    await mkdir(this.directory, { recursive: true });
    if ((await lstat(this.directory)).isSymbolicLink()) throw Error('Linked work-session directory refused');
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw Error('Invalid work-session store');
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (![1,2].includes(saved.version) || typeof saved.enabled !== 'boolean' || !Array.isArray(saved.sessions) || saved.sessions.length > MAX_WORK_SESSIONS) throw Error('Invalid work-session state');
      const ids = new Set(), keys = new Set();
      for (const row of saved.sessions) {
        if (!idPattern.test(row.id) || ids.has(row.id) || !/^[0-9a-f]{64}$/.test(row.owner) || !/^[0-9a-f]{64}$/.test(row.key) || keys.has(row.key) || !Number.isSafeInteger(row.period) || row.period < 1 || !Number.isFinite(row.started) || !Number.isFinite(row.last_seen) || !Number.isFinite(row.high_water) || ![row.warn_at, row.checkpoint_at, row.deadline].every(Number.isFinite) || !(row.started < row.warn_at && row.warn_at < row.checkpoint_at && row.checkpoint_at < row.deadline) || typeof row.yielded !== 'boolean' || !Array.isArray(row.events) || row.events.length > 50 || !Array.isArray(row.checkpoints) || row.checkpoints.length > 8 || !Array.isArray(row.history) || row.history.length > 8 || !['provider_session', 'explicit_token'].includes(row.identity)) throw Error('Invalid saved work session');
        ids.add(row.id); keys.add(row.key);
        if (saved.version === 1) {
          // Preserve the old handovers/history, but never enforce a lifetime-chat clock.
          row.turn_id = null; row.retired_turn_ids = []; row.legacy_chat_clock = true;
        } else if (!(row.turn_id === null || turnPattern.test(row.turn_id)) || !Array.isArray(row.retired_turn_ids) || row.retired_turn_ids.length > 128 || !row.retired_turn_ids.every(x => turnPattern.test(x))) throw Error('Invalid saved message period');
      }
      saved.version = 2;
      this.state = saved;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  serial(operation) {
    const next = this.queue.then(() => this.ready).then(operation);
    this.queue = next.catch(() => {}); return next;
  }
  async save() {
    const temp = this.file + '.' + randomUUID() + '.tmp';
    const content=JSON.stringify(this.state);
    if(Buffer.byteLength(content)>8*1024*1024)throw Error('Work-session store limit reached; preserve and archive existing handovers locally');
    await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
    await rename(temp, this.file);
    this.onChange();
  }
  owner(client) { return hash(JSON.stringify([client.id, client.provider, client.transport])); }
  nativeKey(client, metadata) {
    const value = metadata?.['openai/session'];
    if (client.provider !== 'openai' || typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\x00-\x1f]/.test(value)) return null;
    return hash(JSON.stringify([this.owner(client), value]));
  }
  now(row) { return Math.max(this.clock(), row?.high_water ?? 0); }
  phase(row) {
    if (!this.state.enabled) return 'disabled';
    if (!row.turn_id) return 'awaiting_message';
    if (row.yielded) return 'yielded';
    const now = this.now(row);
    return now >= row.deadline ? 'report_due' : now >= row.checkpoint_at ? 'checkpoint_due' : now >= row.warn_at ? 'wrap_up' : 'working';
  }
  view(row, { includeCheckpoint = false } = {}) {
    if (!row) return { identity: 'unidentified', phase: this.state.enabled ? 'untracked' : 'disabled', instruction: 'Call bridge_work_session action=begin with one fresh work_turn_id for this user message; carry the returned work_session_id and same work_turn_id on subsequent calls. No timer lockout without a message identity.' };
    const phase = this.phase(row), latest = row.checkpoints.at(-1) ?? null;
    const instruction = phase === 'awaiting_message'
      ? 'No current user-message timer has been identified. For EACH new user message, call bridge_work_session or bridge_status action=begin with a fresh work_turn_id; keep the returned id unchanged during that reply.'
      : phase === 'report_due' || phase === 'yielded'
      ? 'This message period is finished. If still answering that message, save a handover and report back. If the user has since sent a NEW message, call bridge_work_session or bridge_status action=begin with a fresh work_turn_id. Do not ask the user to unlock Bridge.'
      : phase === 'checkpoint_due' ? 'Save a handover now with bridge_work_session action=checkpoint. Do not start another substantial task. Prepare the final user update.'
      : phase === 'wrap_up' ? 'Start winding down. Finish the current small step and save a handover before the deadline.'
      : 'A NEW user message starts with action=begin and a fresh work_turn_id for 25 minutes; this SAME reply keeps the returned id across tools, retries and reconnects. Ordinary calls cannot replace it. Call finish before the final reply.';
    return { work_session_id: row.id, identity: row.identity, label: row.label, period: row.period, phase,
      scope: 'user_message', work_turn_id: row.turn_id, turn_identity_source: row.turn_id ? 'agent_or_owner_declared' : 'not_received',
      started_at: row.turn_id ? new Date(row.started).toISOString() : null, deadline_at: row.turn_id ? new Date(row.deadline).toISOString() : null,
      remaining_seconds: row.turn_id ? Math.max(0, Math.ceil((row.deadline - this.now(row)) / 1000)) : null,
      checkpoint: includeCheckpoint ? latest : latest ? { at: latest.at, period: latest.period, notes_available: true } : null,
      finish_control: { preferred_tool: 'bridge_work_session', compatibility_tool: 'bridge_status', action: 'finish', period: row.period, work_turn_id: row.turn_id, expected_phase: 'yielded' },
      instruction, limitation: 'Bridge cannot force a final response or save work not sent to the PC.' };
  }
  newRow(client, key, identity, label) {
    if (this.state.sessions.length >= MAX_WORK_SESSIONS) throw Error('Work-session capacity reached. Preserve/archive existing handovers locally; do not silently discard a checkpoint.');
    const now = this.clock();
    const row = { id: randomBytes(16).toString('hex'), owner: this.owner(client), key, identity,
      label: safeText(label || (identity === 'provider_session' ? 'ChatGPT chat' : 'Connected chat'), 80),
      period: 1, started: now, high_water: now, last_seen: now, yielded: false,
      warn_at: now + this.durations[0], checkpoint_at: now + this.durations[1], deadline: now + this.durations[2],
      events: [], checkpoints: [], history: [], turn_id: null, retired_turn_ids: [], legacy_chat_clock: false };
    this.state.sessions.push(row); return row;
  }
  startTurn(row, turnId) {
    if (!turnPattern.test(turnId)) throw Error('Invalid work_turn_id: use an opaque 8-96 character message identifier');
    if (row.turn_id === turnId) return; // Duplicate first calls and reconnects cannot renew a deadline.
    if (row.retired_turn_ids.includes(turnId)) throw new WorkTurnError(row, 'STALE_WORK_TURN');
    const now = this.now(row);
    if (row.turn_id || row.legacy_chat_clock) {
      row.history.push({ period: row.period, turn_id: row.turn_id, started: row.started, deadline: row.deadline, ended: now });
      row.history = row.history.slice(-8); row.period++;
      if (row.turn_id) row.retired_turn_ids = [...row.retired_turn_ids, row.turn_id].slice(-128);
    }
    row.turn_id = turnId; row.legacy_chat_clock = false;
    row.started = now; row.high_water = now; row.last_seen = now;
    row.warn_at = now + this.durations[0]; row.checkpoint_at = now + this.durations[1]; row.deadline = now + this.durations[2];
    row.yielded = false; row.events = [];
  }
  async touch(client, metadata, token, { begin = false, label, turnId, existingTurn = false, lookupOnly = false } = {}) {
    return this.serial(async () => {
      const key = this.nativeKey(client, metadata), owner = this.owner(client);
      let row;
      if (token !== undefined) {
        if (!idPattern.test(token)) throw Error('Invalid work-session token');
        row = this.state.sessions.find(r => r.id === token && r.owner === owner);
        if (!row || (key && row.key !== key)) throw Error('Work-session identity mismatch');
      } else if (key) row = this.state.sessions.find(r => r.key === key && r.owner === owner);
      if (lookupOnly) return row?.id ?? null;
      if (existingTurn) {
        if (!row) throw Error('Begin a work session first; a finish/checkpoint/resume cannot create one');
        if (turnId !== undefined && row.turn_id !== turnId) throw new WorkTurnError(row, 'STALE_WORK_TURN');
      }
      if (!row && key) row = this.newRow(client, key, 'provider_session', label);
      if (!row && begin) row = this.newRow(client, hash(randomBytes(32)), 'explicit_token', label);
      if (row) {
        if (turnId !== undefined) {
          // A stray marker on an ordinary read/status/command must not retire the
          // actual reply. Only explicit begin/resume can replace an existing one.
          if (row.turn_id && row.turn_id !== turnId && !begin)
            throw new WorkTurnError(row, row.retired_turn_ids.includes(turnId) ? 'STALE_WORK_TURN' : 'WORK_TURN_MISMATCH');
          this.startTurn(row, turnId);
        }
        if (begin && label) row.label = safeText(label, 80);
        row.high_water = this.now(row); row.last_seen = row.high_water; await this.save();
      }
      return row?.id ?? null;
    });
  }
  get(id) { return this.state.sessions.find(r => r.id === id); }
  status(id, options) { return this.view(this.get(id), options); }
  check(id, tool, turnId) {
    const row = this.get(id);
    if (row && turnId && row.turn_id !== turnId) throw new WorkTurnError(row, 'STALE_WORK_TURN');
    // No guessed turn boundary, no lifetime-chat lockout. Unmarked calls receive advice only.
    if (row && turnId && row.turn_id === turnId && ['report_due', 'yielded'].includes(this.phase(row)) && (executionTools.has(tool) || writeTools.has(tool))) throw Error('WORK_PERIOD_FINISHED: This user-message work period is finished. End this reply and report back. Only if the user has sent a NEW message, call bridge_work_session or bridge_status action=begin with a fresh work_turn_id; no owner unlock is needed. Status, checkpoint and cancellation remain available.');
  }
  async record(id, tool, input, result) {
    if (!id) return;
    return this.serial(async () => {
      const row = this.get(id); if (!row) throw Error('Missing work session');
      row.high_water = this.now(row); row.last_seen = row.high_water;
      // Only evidence already visible to this caller. Never capture command text, file bodies or credentials.
      const data = result.data || {};
      const event = { at: new Date(row.high_water).toISOString(), period: row.period, tool, ok: result.ok === true };
      if (typeof data.id === 'string') event.job_id = safeText(data.id, 80);
      if (typeof input.job_id === 'string') event.job_id = safeText(input.job_id, 80);
      if (typeof data.state === 'string') event.job_state = safeText(data.state, 40);
      if (typeof input.path === 'string') event.path = safeText(input.path, 512);
      if (typeof input.project_id === 'string') event.project_id = safeText(input.project_id, 80);
      if (typeof data.receipt_hash === 'string') event.receipt_hash = safeText(data.receipt_hash, 64);
      if (typeof data.sha256 === 'string') event.sha256 = safeText(data.sha256, 64);
      row.events.push(event); row.events = row.events.slice(-20);
      await this.save();
    });
  }
  async checkpoint(id, input, finish = false, expectedTurn) {
    return this.serial(async () => {
      const row = this.get(id); if (!row) throw Error('Begin a work session first');
      if (expectedTurn !== undefined && row.turn_id !== expectedTurn) throw new WorkTurnError(row, 'STALE_WORK_TURN');
      if (input.period !== row.period) throw Error('Stale work period: inspect session status before saving');
      const notes = {};
      for (const key of ['completed', 'verified', 'remaining', 'next_step']) {
        if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 2000)) throw Error('Invalid checkpoint notes');
        notes[key] = safeText(input[key], 2000);
      }
      if (finish && row.yielded) {
        const latest = row.checkpoints.at(-1);
        if (latest?.period === row.period && JSON.stringify(latest.agent_reported_not_independently_verified) === JSON.stringify(notes)) return this.view(row, { includeCheckpoint: true });
        throw Error('This reply is already finished; read its handover instead of overwriting it');
      }
      const checkpoint = { at: new Date(this.now(row)).toISOString(), period: row.period,
        agent_reported_not_independently_verified: notes, observed_tool_receipts: structuredClone(row.events),
        files_already_on_disk_are_not_a_full_snapshot: true };
      row.checkpoints.push(checkpoint); row.checkpoints = row.checkpoints.slice(-3);
      if (finish) row.yielded = true;
      await this.save(); return this.view(row, { includeCheckpoint: true });
    });
  }
  async resume(id, period, confirmation, expectedTurn) {
    return this.serial(async () => {
      const row = this.get(id); if (!row) throw Error('Unknown work session');
      if (!Number.isSafeInteger(period) || period < 1) throw Error('Current period required');
      // A replay of the previous resume is idempotent, not another extension.
      if (confirmation !== true) throw Error('Resume only after the user explicitly asks to continue');
      if (period === row.period - 1 && row.last_resume_from === period) return this.view(row, { includeCheckpoint: true });
      if (expectedTurn !== undefined && row.turn_id !== expectedTurn) throw new WorkTurnError(row, 'STALE_WORK_TURN');
      if (period !== row.period) throw Error('Stale work period');
      // A new user message starts a new budget even if the previous reply had time left.
      if (!row.turn_id) row.legacy_chat_clock = true;
      this.startTurn(row, 'message-' + randomUUID()); row.last_resume_from = period;
      await this.save(); return this.view(row, { includeCheckpoint: true });
    });
  }
  async operate(id, input, expectedTurn) {
    if (input.action === 'checkpoint' || input.action === 'finish') return this.checkpoint(id, input, input.action === 'finish', expectedTurn);
    if (input.action === 'resume') return this.resume(id, input.period, input.user_requested_continue, expectedTurn);
    return this.status(id, { includeCheckpoint: true });
  }
  snapshot() {
    return { enabled: this.state.enabled, timing_minutes: this.durations.map(n => n / 60000),
      sessions: [...this.state.sessions].sort((a, b) => b.last_seen - a.last_seen).map(r => ({ ...this.view(r, { includeCheckpoint: true }), last_seen_at: new Date(r.last_seen).toISOString() })) };
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw Error('Expected a local on/off choice');
    return this.serial(async () => { this.state.enabled = enabled; await this.save(); return this.snapshot(); });
  }
}

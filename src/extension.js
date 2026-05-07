'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const DEFAULT_CACHE = path.join(HOME, '.claude', '.statusline-cache.json');
const DEFAULT_PROJECTS = path.join(HOME, '.claude', 'projects');
const TAIL_BYTES = 128 * 1024;
const DEFAULT_CONTEXT_WINDOW = 200_000;

let item;
let timer;
let lastSig = '';
let cachedTranscript = null; // { path, mtimeMs, usage, model }

function activate(context) {
  item = createItem();
  context.subscriptions.push(item);
  item.command = 'claudeStatusline.refresh';
  item.show();

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeStatusline.refresh', () => render()),
    vscode.commands.registerCommand('claudeStatusline.openCache', openCache),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeStatusline')) return;
      const old = item;
      item = createItem();
      item.command = 'claudeStatusline.refresh';
      item.show();
      old.dispose();
      lastSig = '';
      reschedule();
      render();
    })
  );

  render();
  reschedule();
  context.subscriptions.push({ dispose: () => { if (timer) clearInterval(timer); } });
}

function deactivate() { if (timer) clearInterval(timer); }

function createItem() {
  const cfg = vscode.workspace.getConfiguration('claudeStatusline');
  const align = cfg.get('alignment', 'right') === 'left'
    ? vscode.StatusBarAlignment.Left
    : vscode.StatusBarAlignment.Right;
  return vscode.window.createStatusBarItem(align, cfg.get('priority', 100));
}

function reschedule() {
  if (timer) clearInterval(timer);
  const ms = vscode.workspace.getConfiguration('claudeStatusline').get('refreshIntervalMs', 2000);
  timer = setInterval(() => render(), ms);
}

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

function getCachePath() {
  const p = (vscode.workspace.getConfiguration('claudeStatusline').get('cachePath', '') || '').trim();
  return p ? expandHome(p) : DEFAULT_CACHE;
}

function getProjectsDir() {
  const p = (vscode.workspace.getConfiguration('claudeStatusline').get('transcriptDir', '') || '').trim();
  return p ? expandHome(p) : DEFAULT_PROJECTS;
}

async function openCache() {
  const p = getCachePath();
  try {
    const doc = await vscode.workspace.openTextDocument(p);
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    vscode.window.showWarningMessage(`Cache file not available: ${p}\n${err.message}`);
  }
}

// ---------- bash-cache reader ----------

function readCache() {
  const p = getCachePath();
  try {
    const stat = fs.statSync(p);
    const raw = fs.readFileSync(p, 'utf8');
    return { data: JSON.parse(raw), mtimeMs: stat.mtimeMs, path: p };
  } catch (err) {
    return { error: err, path: p };
  }
}

// ---------- live-transcript reader ----------

function findLatestTranscript() {
  const root = getProjectsDir();
  let best = null;
  let workspaces;
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return null; }

  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    let entries;
    try { entries = fs.readdirSync(wsDir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const fp = path.join(wsDir, e.name);
      try {
        const st = fs.statSync(fp);
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: fp, mtimeMs: st.mtimeMs };
      } catch { /* ignore */ }
    }
  }
  return best;
}

function readTailUsage(transcriptPath) {
  let fd;
  try {
    const st = fs.statSync(transcriptPath);
    const len = Math.min(st.size, TAIL_BYTES);
    if (len === 0) return null;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n');
    // If we didn't read from byte 0, the first chunk is likely a partial line — skip it.
    const start = len < st.size ? 1 : 0;
    for (let i = lines.length - 1; i >= start; i--) {
      const line = lines[i].trim();
      if (!line || line[0] !== '{') continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;
      return {
        model: obj.message.model || null,
        usage: obj.message.usage,
        ts: obj.timestamp || null,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function readLive() {
  const lt = findLatestTranscript();
  if (!lt) { cachedTranscript = null; return null; }
  if (cachedTranscript
      && cachedTranscript.path === lt.path
      && cachedTranscript.mtimeMs === lt.mtimeMs) {
    return cachedTranscript;
  }
  const u = readTailUsage(lt.path);
  cachedTranscript = u
    ? { path: lt.path, mtimeMs: lt.mtimeMs, usage: u.usage, model: u.model, ts: u.ts }
    : { path: lt.path, mtimeMs: lt.mtimeMs, usage: null, model: null, ts: null };
  return cachedTranscript;
}

// ---------- context-window size resolution ----------

function contextWindowSize(cacheData, modelId) {
  const override = vscode.workspace.getConfiguration('claudeStatusline')
    .get('contextWindowOverride', 0);
  if (override && override > 0) return override;

  const fromCache = cacheData && cacheData.context_window && cacheData.context_window.context_window_size;
  if (typeof fromCache === 'number' && fromCache > 0) return fromCache;

  // The cache stores the canonical model.id with a "[1m]" suffix for 1M-context variants;
  // transcripts only have the bare id, so we also accept it on the cache's id.
  const cacheModelId = cacheData && cacheData.model && cacheData.model.id;
  if (cacheModelId && /\[1m\]/i.test(cacheModelId)) return 1_000_000;
  if (modelId && /\[1m\]/i.test(modelId)) return 1_000_000;

  return DEFAULT_CONTEXT_WINDOW;
}

function computeCtxPct(usage, ctxSize) {
  const used = (usage.input_tokens || 0)
             + (usage.cache_creation_input_tokens || 0)
             + (usage.cache_read_input_tokens || 0);
  return Math.floor(100 * used / ctxSize);
}

// ---------- render ----------

function render() {
  const cfg = vscode.workspace.getConfiguration('claudeStatusline');
  const staleSec = cfg.get('staleThresholdSec', 300);
  const now = Date.now();

  const cache = readCache();
  const live = readLive();

  if (!cache.data && !(live && live.usage)) {
    if (lastSig !== 'no-data') {
      item.text = '$(circle-slash) Claude: no data';
      item.tooltip = noDataTooltip(cache.path, getProjectsDir());
      item.backgroundColor = undefined;
      lastSig = 'no-data';
    }
    return;
  }

  // ---- assemble fields ----

  const cacheData = cache.data || null;
  const cacheAgeSec = cacheData ? (now - cache.mtimeMs) / 1000 : null;
  const cacheStale = cacheAgeSec == null || cacheAgeSec > staleSec;

  const liveAgeSec = (live && live.mtimeMs) ? (now - live.mtimeMs) / 1000 : null;
  const liveStale = liveAgeSec == null || liveAgeSec > staleSec;

  // Model: prefer cache's display_name (prettiest), else live's id, else cache's id.
  const model = (cacheData && cacheData.model && cacheData.model.display_name)
             || (live && live.model)
             || (cacheData && cacheData.model && cacheData.model.id)
             || '?';

  // Effort: only present in the bash cache.
  const effort = cacheData && cacheData.effort && cacheData.effort.level;

  // Context: prefer live transcript; fall back to cache.
  let ctxPct, ctxSource, ctxAgeSec;
  if (live && live.usage) {
    const ctxSize = contextWindowSize(cacheData, live.model);
    ctxPct = computeCtxPct(live.usage, ctxSize);
    ctxSource = 'live';
    ctxAgeSec = liveAgeSec;
  } else if (cacheData && cacheData.context_window && typeof cacheData.context_window.used_percentage === 'number') {
    ctxPct = Math.floor(cacheData.context_window.used_percentage);
    ctxSource = 'cached';
    ctxAgeSec = cacheAgeSec;
  } else {
    ctxPct = 0;
    ctxSource = 'unknown';
    ctxAgeSec = null;
  }

  // Rate limits: bash cache only.
  const h5raw = cacheData && cacheData.rate_limits && cacheData.rate_limits.five_hour;
  const d7raw = cacheData && cacheData.rate_limits && cacheData.rate_limits.seven_day;
  const h5 = h5raw && typeof h5raw.used_percentage === 'number'
    ? { pct: Math.floor(h5raw.used_percentage), resets_at: h5raw.resets_at, stale: cacheStale }
    : null;
  const d7 = d7raw && typeof d7raw.used_percentage === 'number'
    ? { pct: Math.floor(d7raw.used_percentage), resets_at: d7raw.resets_at, stale: cacheStale }
    : null;

  // ---- format ----

  const fmtLimit = (label, lim) => {
    let s = `${label}:${lim.pct}%`;
    if (lim.resets_at) s += ` (${fmtEta(lim.resets_at)})`;
    if (lim.stale) s += ' stale';
    return s;
  };
  const parts = [model];
  if (effort) parts.push(`effort:${effort}`);
  if (h5) parts.push(fmtLimit('5h', h5));
  if (d7) parts.push(fmtLimit('7d', d7));
  parts.push(`ctx:${ctxPct}%${ctxSource === 'cached' && cacheStale ? ' stale' : ''}`);
  const text = parts.join(' · ');

  // Severity: count fresh metrics only — stale data shouldn't keep the bar red forever.
  const fresh = [];
  if (ctxSource === 'live' && !liveStale) fresh.push(ctxPct);
  if (ctxSource === 'cached' && !cacheStale) fresh.push(ctxPct);
  if (h5 && !h5.stale) fresh.push(h5.pct);
  if (d7 && !d7.stale) fresh.push(d7.pct);
  const worst = fresh.length ? Math.max(...fresh) : 0;
  let bg;
  if (worst >= 80) bg = new vscode.ThemeColor('statusBarItem.errorBackground');
  else if (worst >= 50) bg = new vscode.ThemeColor('statusBarItem.warningBackground');
  else bg = undefined;

  const sig = `${text}|${worst}|${ctxSource}|${cacheStale}|${liveStale}`;
  if (sig === lastSig) return;
  lastSig = sig;

  item.text = `$(zap) ${text}`;
  item.backgroundColor = bg;
  item.tooltip = formatTooltip({
    model, effort, ctxPct, ctxSource, ctxAgeSec, liveStale,
    h5, d7, cacheStale, cacheAgeSec, cachePath: cache.path,
    transcriptPath: live ? live.path : null,
  });
}

// ---------- tooltip ----------

function formatTooltip(s) {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportThemeIcons = true;
  md.appendMarkdown(`**Claude Code session**\n\n`);
  md.appendMarkdown(`| Field | Value | Source |\n|---|---|---|\n`);
  md.appendMarkdown(`| Model | \`${escapeMd(s.model)}\` | cached |\n`);
  md.appendMarkdown(`| Effort | ${s.effort ? '`' + escapeMd(s.effort) + '`' : '_n/a_'} | cached |\n`);
  md.appendMarkdown(`| Context | ${s.ctxPct}% | ${s.ctxSource === 'live' ? 'live (' + fmtAge(s.ctxAgeSec) + ' ago)' : 'cached (' + fmtAge(s.ctxAgeSec) + ' ago)'} |\n`);
  if (s.h5) md.appendMarkdown(`| 5-hour limit | ${s.h5.pct}%${s.h5.resets_at ? ' (resets in ' + fmtEta(s.h5.resets_at) + ')' : ''} | cached${s.h5.stale ? ' (stale)' : ''} |\n`);
  if (s.d7) md.appendMarkdown(`| 7-day limit  | ${s.d7.pct}%${s.d7.resets_at ? ' (resets in ' + fmtEta(s.d7.resets_at) + ')' : ''} | cached${s.d7.stale ? ' (stale)' : ''} |\n`);

  md.appendMarkdown(`\n_Cache_: \`${escapeMd(s.cachePath)}\` · age ${fmtAge(s.cacheAgeSec)}\n\n`);
  if (s.transcriptPath) {
    md.appendMarkdown(`_Transcript_: \`${escapeMd(s.transcriptPath)}\`${s.ctxAgeSec != null && s.ctxSource === 'live' ? ' · age ' + fmtAge(s.ctxAgeSec) : ''}\n\n`);
  }

  if (s.cacheStale) {
    md.appendMarkdown(`Note: rate-limit data is older than the stale threshold. Run a Claude Code prompt in a terminal to refresh it; rate limits are not exposed by the VS Code panel.\n`);
  }
  return md;
}

function noDataTooltip(cachePathStr, projectsDir) {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Claude Code Status Line**\n\n`);
  md.appendMarkdown(`No data yet. Looked at:\n\n`);
  md.appendMarkdown(`- Cache: \`${escapeMd(cachePathStr)}\`\n`);
  md.appendMarkdown(`- Transcripts: \`${escapeMd(projectsDir)}\`\n\n`);
  md.appendMarkdown(`Run any Claude Code prompt (terminal or VS Code panel) to populate the transcript directory; `);
  md.appendMarkdown(`run a terminal prompt at least once for the rate-limit cache (see [claude-prompt](https://github.com/gagar1n/claude-prompt)).`);
  return md;
}

// ---------- formatting ----------

function fmtEta(epoch) {
  const r = epoch - Math.floor(Date.now() / 1000);
  if (r <= 0) return 'now';
  const d = Math.floor(r / 86400);
  const h = Math.floor((r % 86400) / 3600);
  const m = Math.floor((r % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtAge(s) {
  if (s == null) return 'unknown';
  s = Math.floor(s);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function escapeMd(s) {
  return String(s).replace(/[\\`*_{}\[\]()#+\-.!|]/g, (c) => '\\' + c);
}

module.exports = { activate, deactivate };

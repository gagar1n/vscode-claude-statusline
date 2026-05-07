'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CACHE = path.join(os.homedir(), '.claude', '.statusline-cache.json');

let item;
let timer;
let lastSig = '';

function activate(context) {
  item = createItem();
  context.subscriptions.push(item);
  item.command = 'claudeStatusline.refresh';
  item.show();

  const refresh = () => render();

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeStatusline.refresh', refresh),
    vscode.commands.registerCommand('claudeStatusline.openCache', openCache),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeStatusline')) return;
      reschedule();
      // Recreate the item if alignment/priority changed.
      const old = item;
      item = createItem();
      item.command = 'claudeStatusline.refresh';
      item.show();
      old.dispose();
      lastSig = '';
      refresh();
    })
  );

  refresh();
  reschedule();

  context.subscriptions.push({ dispose: () => { if (timer) clearInterval(timer); } });
}

function deactivate() {
  if (timer) clearInterval(timer);
}

function createItem() {
  const cfg = vscode.workspace.getConfiguration('claudeStatusline');
  const align = cfg.get('alignment', 'right') === 'left'
    ? vscode.StatusBarAlignment.Left
    : vscode.StatusBarAlignment.Right;
  const priority = cfg.get('priority', 100);
  return vscode.window.createStatusBarItem(align, priority);
}

function reschedule() {
  if (timer) clearInterval(timer);
  const cfg = vscode.workspace.getConfiguration('claudeStatusline');
  const intervalMs = cfg.get('refreshIntervalMs', 2000);
  timer = setInterval(render, intervalMs);
}

function cachePath() {
  const cfg = vscode.workspace.getConfiguration('claudeStatusline');
  const p = (cfg.get('cachePath', '') || '').trim();
  return p ? expandHome(p) : DEFAULT_CACHE;
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function openCache() {
  const p = cachePath();
  try {
    const doc = await vscode.workspace.openTextDocument(p);
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    vscode.window.showWarningMessage(`Cache file not available: ${p}\n${err.message}`);
  }
}

function render() {
  const p = cachePath();
  let stat, raw, data, ageSec;
  try {
    stat = fs.statSync(p);
    ageSec = (Date.now() - stat.mtimeMs) / 1000;
    raw = fs.readFileSync(p, 'utf8');
    data = JSON.parse(raw);
  } catch (err) {
    if (lastSig !== `error:${err.code || err.message}`) {
      item.text = '$(circle-slash) Claude: no data';
      item.tooltip = noDataTooltip(p, err);
      item.backgroundColor = undefined;
      lastSig = `error:${err.code || err.message}`;
    }
    return;
  }

  const cfg = vscode.workspace.getConfiguration('claudeStatusline');
  const staleSec = cfg.get('staleThresholdSec', 300);
  const stale = ageSec > staleSec;

  const fields = extract(data);
  const sig = `${JSON.stringify(fields)}|${stale}`;
  if (sig === lastSig) return;
  lastSig = sig;

  item.text = `$(zap) ${formatText(fields, stale)}`;
  item.tooltip = formatTooltip(fields, ageSec, stale, p);
  item.backgroundColor = severityBg(fields, stale);
}

function extract(d) {
  const model = (d && d.model && d.model.display_name) || '?';
  const effort = (d && d.effort && d.effort.level) || null;
  const ctx = Math.floor(((d && d.context_window && d.context_window.used_percentage) || 0));
  const h5raw = d && d.rate_limits && d.rate_limits.five_hour;
  const d7raw = d && d.rate_limits && d.rate_limits.seven_day;
  const h5 = h5raw && typeof h5raw.used_percentage === 'number'
    ? { pct: Math.floor(h5raw.used_percentage), resets_at: h5raw.resets_at }
    : null;
  const d7 = d7raw && typeof d7raw.used_percentage === 'number'
    ? { pct: Math.floor(d7raw.used_percentage), resets_at: d7raw.resets_at }
    : null;
  return { model, effort, ctx, h5, d7 };
}

function formatText(f, stale) {
  const parts = [f.model];
  if (f.effort) parts.push(`effort:${f.effort}`);
  if (f.h5) parts.push(`5h:${f.h5.pct}%`);
  if (f.d7) parts.push(`7d:${f.d7.pct}%`);
  parts.push(`ctx:${f.ctx}%`);
  const text = parts.join(' · ');
  return stale ? `(stale) ${text}` : text;
}

function severityBg(f, stale) {
  if (stale) return undefined;
  const worst = Math.max(
    f.ctx,
    f.h5 ? f.h5.pct : 0,
    f.d7 ? f.d7.pct : 0
  );
  if (worst >= 80) return new vscode.ThemeColor('statusBarItem.errorBackground');
  if (worst >= 50) return new vscode.ThemeColor('statusBarItem.warningBackground');
  return undefined;
}

function formatTooltip(f, ageSec, stale, cachePathStr) {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportThemeIcons = true;
  md.appendMarkdown(`**Claude Code session**\n\n`);
  md.appendMarkdown(`| | |\n|---|---|\n`);
  md.appendMarkdown(`| Model | \`${f.model}\` |\n`);
  md.appendMarkdown(`| Effort | ${f.effort ? '`' + f.effort + '`' : '_n/a_'} |\n`);
  md.appendMarkdown(`| Context | ${f.ctx}% |\n`);
  if (f.h5) md.appendMarkdown(`| 5-hour limit | ${f.h5.pct}%${f.h5.resets_at ? ' (resets in ' + fmtEta(f.h5.resets_at) + ')' : ''} |\n`);
  if (f.d7) md.appendMarkdown(`| 7-day limit | ${f.d7.pct}%${f.d7.resets_at ? ' (resets in ' + fmtEta(f.d7.resets_at) + ')' : ''} |\n`);
  md.appendMarkdown(`\n_Cache age: ${fmtAge(ageSec)}_  \n`);
  md.appendMarkdown(`_Source: \`${cachePathStr}\`_`);
  if (stale) {
    md.appendMarkdown(`\n\n⚠ Data is older than the stale threshold. The Claude Code session that produced it may have ended.`);
  }
  return md;
}

function noDataTooltip(p, err) {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Claude Code Status Line**\n\n`);
  md.appendMarkdown(`No data yet. Expected cache at \`${p}\`.\n\n`);
  md.appendMarkdown(`This file is written by the \`statusLine\` shell script that ships with [claude-prompt](https://github.com/gagar1n/claude-prompt). `);
  md.appendMarkdown(`Run any Claude Code session in a terminal once and the cache will appear.\n\n`);
  md.appendMarkdown(`_Last error: ${err.code || err.message}_`);
  return md;
}

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
  s = Math.floor(s);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

module.exports = { activate, deactivate };

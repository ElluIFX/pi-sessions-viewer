#!/usr/bin/env node
// End-to-end checks against a real binary, using synthetic data only.
// Usage: node scripts/browser-test.mjs [path/to/pi-sessions-viewer]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.resolve(process.argv[2] || path.join(root, 'dist/pi-sessions-viewer-linux-amd64'));
const artifacts = path.join(root, 'browser-artifacts');
const port = Number(process.env.BROWSER_TEST_PORT || 27893);
assert(Number.isInteger(port) && port > 0 && port < 65535, 'BROWSER_TEST_PORT must be a valid port');
const base = `http://127.0.0.1:${port}`;
const temp = await mkdtemp(path.join(tmpdir(), 'pi-browser-test-'));
const sessionsDir = path.join(temp, 'sessions');
await mkdir(sessionsDir, { recursive: true });
await mkdir(artifacts, { recursive: true });

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const fixtures = [
  { project: '--workspace--atlas--', file: 'same name #1.jsonl', title: 'Polish the command palette and keyboard navigation', tokens: 286400, cost: 0.4827, count: 6 },
  { project: '--workspace--atlas--', file: 'search.jsonl', title: 'Build a faster search experience', tokens: 124600, cost: 0.2145, count: 8 },
  { project: '--workspace--design-system--', file: 'same name #1.jsonl', title: 'Refine typography and spacing across the dashboard', tokens: 206700, cost: 0.3274, count: 4 },
  { project: '--workspace--api-gateway--', file: 'timeout.jsonl', title: 'Trace the intermittent request timeout', tokens: 48300, cost: 0.0791, count: 10 },
  { project: '--workspace--design-system--', file: 'colors.jsonl', title: 'Explore a quieter, more focused color palette', tokens: 69100, cost: 0.1062, count: 12 },
  { project: '--workspace--sandbox--', file: 'escaping.jsonl', title: '<script>window.injected=true</script> 中文 & “quoted” title', tokens: 0, cost: 0, count: 2 },
];
const message = (id, parentId, timestamp, role, content, extra = {}) => ({ type: 'message', id, parentId, timestamp, message: { role, content, ...extra } });
for (const [index, fixture] of fixtures.entries()) {
  const start = Date.parse('2026-10-21T12:00:00Z') - index * 3600000;
  const timestamp = step => new Date(start + step * 1000).toISOString();
  const usage = { input: fixture.tokens, output: 0, totalTokens: fixture.tokens, cost: { total: fixture.cost } };
  const header = { type: 'session', version: 3, id: `fixture-${index}`, timestamp: timestamp(0), name: fixture.title, cwd: '/workspace/' + fixture.project.split('--')[2] };
  let entries;
  if (index === 0) {
    entries = [
      message('u1', null, timestamp(1), 'user', 'Can you polish our command palette and keyboard navigation? Keep everything local and easy to review.'),
      message('a1', 'u1', timestamp(2), 'assistant', [
        { type: 'thinking', thinking: 'Reviewing the offline workflow and keyboard interactions.' },
        { type: 'text', text: '## A more focused workspace\n\nThe session library now supports **offline review**.\n\n- Embedded assets, with no CDN dependencies\n- Responsive navigation and keyboard shortcuts\n- A single portable binary\n\n```bash\n./pi-sessions-viewer -p 8080\n```\n\n![remote image](https://example.invalid/tracker.png)\n\n<img src="https://example.invalid/injected.png" onerror="window.hacked=1">\n\n[unsafe](javascript:alert(1))' },
      ], { model: 'fixture-model', provider: 'local', usage }),
      message('u2', 'a1', timestamp(3), 'user', [{ type: 'text', text: 'Looks good. Verify the themes and this image attachment.' }, { type: 'image', mimeType: 'image/png', data: png }]),
      message('branch-alt', 'u2', timestamp(4), 'assistant', [{ type: 'thinking', thinking: 'Alternative navigation approach.' }, { type: 'text', text: 'An alternative branch is available for comparison.' }]),
      message('a2', 'u2', timestamp(5), 'assistant', [{ type: 'text', text: 'Both themes preserve the same layout. Running the verification now.' }, { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'go test ./...' } }]),
      message('r1', 'a2', timestamp(6), 'toolResult', [{ type: 'text', text: Array.from({ length: 25 }, (_, n) => `ok test ${n + 1}`).join('\n') }], { toolCallId: 'tool-1', toolName: 'bash', isError: false }),
    ];
  } else {
    entries = Array.from({ length: fixture.count }, (_, n) => message(`m${n}`, n ? `m${n - 1}` : null, timestamp(n + 1), n % 2 ? 'assistant' : 'user', [{ type: 'text', text: n ? 'Synthetic local test message.' : fixture.title }], n === 1 ? { usage } : {}));
  }
  const dir = path.join(sessionsDir, fixture.project);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fixture.file), [header, ...entries].map(value => JSON.stringify(value)).join('\n') + '\n');
}

let server;
let browser;
let page;
let serverLog = '';
const issues = [];
let expectedNetworkInterruption = false;
let checks = 0;
const check = (condition, description) => { assert(condition, description); checks++; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function monitor(context) {
  context.on('page', opened => {
    opened.on('pageerror', error => issues.push(`Page error: ${error.message}`));
    opened.on('console', message => {
      if (message.type() !== 'error') return;
      // Offline/reconnect is intentional in one regression. Only its exact
      // browser network diagnostics are exempt; all script errors still fail.
      if (expectedNetworkInterruption && /net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED)/.test(message.text())) return;
      issues.push(`Console error: ${message.text()}`);
    });
  });
  context.on('request', request => {
    const url = request.url();
    if (/^https?:/i.test(url) && new URL(url).origin !== base) issues.push(`External request: ${url}`);
  });
}
async function visibleCount(selector, count) {
  await page.waitForFunction(({ selector, count }) => Array.from(document.querySelectorAll(selector)).filter(el => !el.hidden && el.getClientRects().length).length === count, { selector, count });
  check(await page.locator(`${selector}:visible`).count() === count, `${selector}: expected ${count} visible`);
}
async function screenshot(name) { await page.screenshot({ path: path.join(artifacts, name), fullPage: true, animations: 'disabled' }); }
async function noOverflow(label) { check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no horizontal overflow`); }
async function stopServer() {
  if (!server || !server.pid || server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), delay(5000).then(() => false)])) return;
  server.kill('SIGKILL');
  await exited;
}
try {
  await readFile(binary); // Fail with a useful path before spawning a missing binary.
  server = spawn(binary, ['-host', '127.0.0.1', '-p', String(port), '-sessions-dir', sessionsDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.on('error', error => { serverLog += '\n' + error.message; });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { serverLog = (serverLog + data).slice(-20000); });
  let ready = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Server exited during startup:\n${serverLog}`);
    try { const response = await fetch(base, { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  check(ready, `Server did not become ready:\n${serverLog}`);
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC', acceptDownloads: true });
  monitor(context);
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await visibleCount('.session-item', 6);
  check(await page.locator('#total-projects').textContent() === '4', 'Project summary');
  check(await page.locator('#total-tokens').textContent() === '735.1k', 'Token summary');
  check(await page.evaluate(() => window.injected === undefined), 'Session title cannot execute HTML');
  await noOverflow('Desktop dashboard');
  await screenshot('dashboard-desktop-light.png');

  await page.locator('#search').fill('atlas keyboard');
  await visibleCount('.session-item', 1);
  check(new URL(page.url()).searchParams.get('q') === 'atlas keyboard', 'Search is stored in the URL');
  await page.reload({ waitUntil: 'domcontentloaded' });
  check(await page.locator('#search').inputValue() === 'atlas keyboard', 'Search survives reload');
  await visibleCount('.session-item', 1);
  await page.locator('#search').fill('this phrase does not exist');
  await page.locator('#no-results').waitFor({ state: 'visible' });
  await page.locator('#empty-reset').click();
  await visibleCount('.session-item', 6);
  await page.locator('#project-filter').selectOption('project:workspace/design-system');
  await visibleCount('.session-item', 2);
  await page.locator('#reset-filters').click();
  const sortExpected = { newest: fixtures[0].title, oldest: fixtures[5].title, messages: fixtures[4].title, tokens: fixtures[0].title, cost: fixtures[0].title, title: fixtures.slice().sort((a, b) => a.title.localeCompare(b.title, 'en-US'))[0].title };
  for (const [sort, title] of Object.entries(sortExpected)) {
    await page.locator('#sort-order').selectOption(sort);
    check(await page.locator('.session-item').first().getAttribute('data-title') === title, `Sort: ${sort}`);
  }
  await page.locator('#sort-order').selectOption('newest');
  await page.locator('#search').evaluate(el => el.blur());
  await page.keyboard.press('/');
  check(await page.locator('#search').evaluate(el => el === document.activeElement), 'Slash focuses search');
  await page.keyboard.type('temporary');
  await page.keyboard.press('Escape');
  check(await page.locator('#search').inputValue() === '', 'Escape clears dashboard search');
  await page.locator('#theme-toggle').click();
  check(await page.locator('html').getAttribute('data-theme') === 'dark', 'Dashboard dark theme');
  await page.reload({ waitUntil: 'domcontentloaded' });
  check(await page.locator('html').getAttribute('data-theme') === 'dark', 'Theme persists after reload');
  await screenshot('dashboard-desktop-dark.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('Mobile dashboard');
  await screenshot('dashboard-mobile-dark.png');
  await page.setViewportSize({ width: 1440, height: 1000 });

  const card = page.locator('.session-card').first();
  const href = await card.getAttribute('href');
  const id = new URL(href, base).searchParams.get('id');
  check(id === `${fixtures[0].project}/${fixtures[0].file}`, 'Project-qualified ID preserves spaces and # characters');
  await card.click();
  await page.locator('#messages .user-message').first().waitFor();
  check(await page.locator('.viewer-actions a[href^="/export?"]').count() === 1, 'Local HTML export is available');
  check(await page.locator('#share-btn').count() === 0, 'Sharing is disabled by default');
  check(await page.locator('html').getAttribute('data-theme') === 'dark', 'Reader shares dashboard theme');
  check(await page.evaluate(() => window.hacked === undefined), 'Unsafe Markdown cannot execute');
  check(await page.locator('img[src^="https:"]').count() === 0, 'Remote images do not become loading image tags');
  check(await page.locator('a[href^="javascript:"]').count() === 0, 'Unsafe links are suppressed');
  await noOverflow('Desktop reader');
  await page.locator('#content').evaluate(el => { el.scrollTop = 0; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await screenshot('reader-desktop-dark.png');
  await page.locator('[data-action="toggle-theme"]').click();
  check(await page.locator('html').getAttribute('data-theme') === 'light', 'Reader light theme');
  await screenshot('reader-desktop-light.png');
  await page.locator('[data-action="toggle-thinking"]').click();
  check(await page.locator('.thinking-text:visible').count() === 0, 'Hide thinking');
  await page.locator('.tree-node[data-id="branch-alt"]').click();
  check(await page.locator('.thinking-text:visible').count() === 0, 'Thinking preference survives branch navigation');
  await page.locator('#tree-search').fill('impossible search phrase');
  await page.locator('.tree-empty').waitFor();
  await page.locator('#tree-search').press('Escape');
  await page.locator('#tree-search').press('ArrowDown');
  check(await page.evaluate(() => document.activeElement.classList.contains('tree-node')), 'ArrowDown focuses tree entry');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.locator('.tree-node[data-id="r1"]').click();
  await page.locator('.message-image').click();
  check(await page.locator('#image-modal').isVisible(), 'Image preview opens');
  await page.keyboard.press('Escape');
  check(await page.locator('#image-modal').isHidden(), 'Escape dismisses image preview');
  await page.locator('#sidebar-resizer').focus();
  const beforeWidth = await page.locator('#sidebar').evaluate(el => el.clientWidth);
  await page.keyboard.press('ArrowRight');
  check(await page.locator('#sidebar').evaluate(el => el.clientWidth) > beforeWidth, 'Keyboard resizing works');

  // Live updates must rebuild the tree and resolve an already-rendered pending tool.
  const livePath = path.join(sessionsDir, fixtures[0].project, fixtures[0].file);
  // Selecting an ancestor pauses follow mode even if it resolves to the
  // currently newest leaf. A newly appended sibling must not steal selection.
  await page.locator('.tree-node[data-id="a1"]').click();
  const pausedLeaf = new URL(page.url()).searchParams.get('leafId');
  const pausedTarget = new URL(page.url()).searchParams.get('targetId');
  const sibling = message('live-sibling', 'u2', '2026-10-21T12:00:50Z', 'assistant', [
    { type: 'text', text: 'NEW_SIBLING_MUST_STAY_PAUSED' },
  ]);
  await appendFile(livePath, JSON.stringify(sibling) + '\n');
  await page.locator('.tree-node[data-id="live-sibling"]').waitFor();
  check(new URL(page.url()).searchParams.get('leafId') === pausedLeaf, 'Paused ancestor does not jump to a new sibling branch');
  check(new URL(page.url()).searchParams.get('targetId') === pausedTarget, 'Paused target survives live append');
  check(await page.locator('#entry-live-sibling').count() === 0, 'Paused conversation does not render the new sibling');
  await page.locator('.viewer-follow').click();
  await page.locator('#entry-live-sibling').waitFor();
  check((await page.locator('#entry-live-sibling').textContent()).includes('NEW_SIBLING_MUST_STAY_PAUSED'), 'Explicit Follow latest opens the new branch');
  const liveCall = message('live-call', 'r1', '2026-10-21T12:01:00Z', 'assistant', [
    { type: 'text', text: 'Checking a new file while the reader stays open.' },
    { type: 'toolCall', id: 'live-tool', name: 'read', arguments: { path: '/workspace/src/main.go', offset: 1, limit: 10 } },
  ]);
  await appendFile(livePath, JSON.stringify(liveCall) + '\n');
  await page.locator('.tree-node[data-id="live-call"]').waitFor();
  if (await page.locator('.viewer-follow').isVisible()) await page.locator('.viewer-follow').click();
  await page.locator('#entry-live-call .tool-execution.pending').waitFor();
  check(await page.locator('.tree-node[data-id="live-call"]').count() === 1, 'Live append adds one tree node');
  const liveResult = message('live-result', 'live-call', '2026-10-21T12:01:01Z', 'toolResult', [
    { type: 'text', text: 'LIVE_TOOL_RESULT_OK' },
  ], { toolCallId: 'live-tool', toolName: 'read', isError: false });
  await appendFile(livePath, JSON.stringify(liveResult) + '\n');
  await page.locator('.tree-node[data-id="live-result"]').waitFor();
  await page.locator('#entry-live-call .tool-execution.success').waitFor();
  check((await page.locator('#entry-live-call').textContent()).includes('LIVE_TOOL_RESULT_OK'), 'Live tool result replaces pending output');
  check(await page.locator('#entry-live-call .tool-execution.pending').count() === 0, 'Resolved live tool is not pending');
  check(await page.locator('.tree-node[data-id="live-call"]').count() === 1, 'Repeated live refresh does not duplicate entries');

  // Recover a write genuinely missed while disconnected, from the first
  // reopened SSE connection. An independent Node subscriber proves the server
  // processed the write while the browser was offline, so a delayed watcher
  // notification cannot accidentally make this regression pass.
  expectedNetworkInterruption = true;
  await page.locator('.viewer-live[data-state="live"]').waitFor();
  const liveDotColor = await page.locator('.viewer-live').evaluate(el => getComputedStyle(el, '::before').backgroundColor);
  const watcherAbort = new AbortController();
  const watcherTimeout = setTimeout(() => watcherAbort.abort(), 15000);
  let watcherReader;
  try {
    const watcherResponse = await fetch(`${base}/events?id=${encodeURIComponent(id)}`, { signal: watcherAbort.signal });
    check(watcherResponse.ok, 'Independent watcher subscription opens');
    watcherReader = watcherResponse.body.getReader();
    const decoder = new TextDecoder();
    const watcherEvent = async () => {
      let buffered = '';
      while (true) {
        const { value, done } = await watcherReader.read();
        if (done) throw new Error('Independent watcher closed before observing the missed write');
        buffered += decoder.decode(value, { stream: true });
        if (buffered.includes('data: reload\n\n')) return;
      }
    };
    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false && document.querySelector('.viewer-live')?.dataset.state === 'offline');
    check(await page.locator('.viewer-live').textContent() === 'Offline', 'Network loss disconnects the live reader before the write');
    check(await page.locator('.viewer-live').evaluate(el => getComputedStyle(el, '::before').backgroundColor) !== liveDotColor, 'Offline indicator is not green');
    const reconnectEntry = message('reconnected-entry', 'live-result', '2026-10-21T12:02:00Z', 'assistant', [
      { type: 'text', text: 'RECOVERED_WITHOUT_A_SECOND_WRITE' },
    ]);
    const observedWrite = watcherEvent();
    await appendFile(livePath, JSON.stringify(reconnectEntry) + '\n');
    await observedWrite;
    check(await page.locator('.tree-node[data-id="reconnected-entry"]').count() === 0, 'Disconnected reader missed a write already processed by the watcher');
    const reopened = page.waitForResponse(response => new URL(response.url()).pathname === '/events' && response.status() === 200, { timeout: 20000 });
    await context.setOffline(false);
    await reopened;
    check(await page.evaluate(() => navigator.onLine), 'Returning online opens a new SSE connection');
    await page.locator('.tree-node[data-id="reconnected-entry"]').waitFor({ timeout: 20000 });
    await page.locator('#entry-reconnected-entry').waitFor();
    check((await page.locator('#entry-reconnected-entry').textContent()).includes('RECOVERED_WITHOUT_A_SECOND_WRITE'), 'SSE reconnect fetches missed data without another write');
    await page.locator('.viewer-live[data-state="live"]').waitFor();
  } finally {
    clearTimeout(watcherTimeout);
    watcherAbort.abort();
    if (watcherReader) await watcherReader.cancel().catch(() => {});
    await context.setOffline(false);
  }
  expectedNetworkInterruption = false;

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('.download-json-btn').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonPath = path.join(temp, 'live-session.jsonl');
  await jsonDownload.saveAs(jsonPath);
  const downloadedEntries = (await readFile(jsonPath, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  check(downloadedEntries.filter(entry => entry.type === 'session').length === 1, 'JSONL download contains exactly one session header');
  for (const id of ['live-sibling', 'live-call', 'live-result', 'reconnected-entry']) {
    check(downloadedEntries.filter(entry => entry.id === id).length === 1, `JSONL download contains current entry exactly once: ${id}`);
  }

  const downloadPromise = page.waitForEvent('download');
  await page.locator('.viewer-actions a[href^="/export?"]').click();
  const download = await downloadPromise;
  const exported = path.join(temp, 'session-export.html');
  await download.saveAs(exported);
  const exportHTML = await readFile(exported, 'utf8');
  check(exportHTML.includes('<html') && !exportHTML.includes('{{SESSION_DATA}}'), 'Export is rendered and self-contained');
  // Verify the actual downloaded document works from disk, without the server.
  const offline = await browser.newContext({ offline: true, viewport: { width: 1200, height: 900 }, colorScheme: 'light' });
  monitor(offline);
  const exportedPage = await offline.newPage();
  await exportedPage.goto(pathToFileURL(exported).href, { waitUntil: 'domcontentloaded' });
  await exportedPage.locator('#messages .user-message').first().waitFor();
  check(await exportedPage.locator('.viewer-actions').count() === 0, 'Offline export does not expose live server actions');
  check(await exportedPage.locator('.assistant-message').count() > 0, 'Downloaded HTML works offline');
  await offline.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#content').evaluate(el => { el.scrollTop = 0; });
  await noOverflow('Mobile reader');
  await screenshot('reader-mobile-light.png');
  await page.locator('#hamburger').click();
  check(await page.locator('#hamburger').getAttribute('aria-expanded') === 'true', 'Mobile navigation opens');
  check(await page.evaluate(() => document.activeElement.id) === 'tree-search', 'Mobile navigation focuses search');
  await screenshot('reader-mobile-navigation.png');
  await page.keyboard.press('Escape');
  check(await page.locator('#hamburger').getAttribute('aria-expanded') === 'false', 'Escape dismisses mobile navigation');
  check(await page.evaluate(() => document.activeElement.id) === 'hamburger', 'Mobile navigation restores focus');
  await page.locator('.viewer-actions a[href="/"]').click();
  await visibleCount('.session-item', 6);
  check(await page.locator('html').getAttribute('data-theme') === 'light', 'Reader theme syncs back to dashboard');

  const noJS = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  monitor(noJS);
  const fallback = await noJS.newPage();
  await fallback.goto(base);
  check(await fallback.locator('.session-card').count() === 6, 'Dashboard supports browsing without JavaScript');
  check(await fallback.locator('#toolbar').isHidden(), 'Nonfunctional search controls are hidden without JavaScript');
  await noJS.close();
  // Malformed and adversarial fields must be inert on every rendering path.
  // Create this additional session only after fixed-count dashboard checks.
  const attack = '<img src="https://example.invalid/field.png" onerror="window.hacked=1">';
  const adversarialDir = path.join(sessionsDir, '--adversarial--');
  await mkdir(adversarialDir);
  const adversarialEntries = [
    { type: 'session', id: 'adversarial-session', version: 3, name: 'Malformed and adversarial input', timestamp: '2026-10-21T13:00:00Z' },
    null, [], 42,
    { type: 'message', id: 'missing-message', message: null },
    { type: 'message', id: 'invalid-role', message: { role: { raw: attack }, content: null } },
    message('attack-role', null, 'invalid date', attack, [{ type: 'text', text: attack }]),
    message('attack-call', 'attack-role', '2026-10-21T13:00:02Z', 'assistant', [
      null, 42, { type: 'text', text: { malformed: attack } },
      { type: 'thinking', thinking: null },
      { type: 'toolCall', id: 'attack-tool', name: 'read', arguments: { path: '/tmp/example.go', offset: attack, limit: attack } },
      { type: 'toolCall', id: 'attack-tool-name', name: attack, arguments: { command: attack } },
    ], { usage: { input: attack, output: null, cost: { input: attack, output: {} } } }),
    message('attack-result', 'attack-call', '2026-10-21T13:00:03Z', 'toolResult', [null, { type: 'text', text: attack }], { toolName: attack, toolCallId: 'attack-tool', isError: false }),
    message('attack-bash', 'attack-result', '2026-10-21T13:00:04Z', 'bashExecution', [], { command: 'echo safe', output: 'Synthetic command output', exitCode: attack }),
    { type: 'compaction', id: 'attack-compaction', parentId: 'attack-bash', timestamp: '2026-10-21T13:00:05Z', tokensBefore: attack, summary: attack },
    { type: 'compaction', id: 'null-compaction', parentId: 'attack-compaction', timestamp: '2026-10-21T13:00:06Z', tokensBefore: null, summary: null },
    message('attack-final', 'null-compaction', '2026-10-21T13:00:07Z', 'assistant', [{ type: 'text', text: 'The reader remains usable after malformed input.' }]),
  ];
  const adversarialPath = path.join(adversarialDir, 'input.jsonl');
  await writeFile(adversarialPath, adversarialEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n{invalid JSON line}\n');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/session?id=${encodeURIComponent('--adversarial--/input.jsonl')}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#entry-attack-final').waitFor();
  check(await page.evaluate(() => window.hacked === undefined), 'Adversarial role, offset, exitCode and tokensBefore are inert');
  check(await page.locator('img[src^="https:"]').count() === 0, 'Adversarial field markup creates no remote images');
  await page.locator('[data-filter="all"]').click();
  check(await page.locator('.tree-node[data-id="attack-result"]').count() === 1, 'Adversarial toolName remains safely navigable');
  await page.locator('.tree-node[data-id="attack-result"]').click();
  check(await page.evaluate(() => window.hacked === undefined), 'Tree navigation never executes adversarial field markup');
  await page.locator('#tree-search').fill('not a matching entry');
  await page.locator('.tree-empty').waitFor();
  await page.locator('#tree-search').press('Escape');
  await noOverflow('Adversarial reader');
  await screenshot('reader-adversarial-input.png');
  // A live result exercises the same normalization path on an already-open document.
  const malformedLive = message('attack-live', 'attack-final', '2026-10-21T13:00:08Z', 'bashExecution', [], { command: attack, output: 'Still safe', exitCode: attack });
  await appendFile(adversarialPath, JSON.stringify(malformedLive) + '\n');
  await page.locator('.tree-node[data-id="attack-live"]').waitFor();
  if (await page.locator('.viewer-follow').isVisible()) await page.locator('.viewer-follow').click();
  await page.locator('#entry-attack-live').waitFor();
  check(await page.evaluate(() => window.hacked === undefined), 'Adversarial live updates are inert');
  check(await page.locator('img[src^="https:"]').count() === 0, 'Adversarial live updates create no loading images');

  await context.close();
  await stopServer();
  // A separate clean start verifies a genuinely empty library without cache timing assumptions.
  await rm(sessionsDir, { recursive: true });
  await mkdir(sessionsDir);
  server = spawn(binary, ['-host', '127.0.0.1', '-p', String(port), '-sessions-dir', sessionsDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.on('error', error => { serverLog += '\n' + error.message; });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { serverLog = (serverLog + data).slice(-20000); });
  let emptyReady = false;
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) { emptyReady = true; break; } } catch {}
    await delay(100);
  }
  check(emptyReady, 'Empty library server starts');
  const emptyContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  monitor(emptyContext);
  page = await emptyContext.newPage();
  await page.goto(base);
  check(await page.locator('#empty-library').isVisible(), 'Empty library has useful guidance');
  check(await page.locator('#total-projects').textContent() === '0', 'Empty library totals');
  await noOverflow('Empty mobile dashboard');
  await screenshot('dashboard-empty.png');
  await emptyContext.close();
  assert.deepEqual(issues, [], 'Browser must have no page errors, console errors, or external requests');
  console.log(`PASS: ${checks} browser checks. Screenshots: ${artifacts}`);
} catch (error) {
  if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {});
  console.error(serverLog);
  if (issues.length) console.error(issues.join('\n'));
  throw error;
} finally {
  if (browser) await browser.close();
  await stopServer();
  await rm(temp, { recursive: true, force: true });
}

// 真实浏览器跨来源表单测试；独立服务和临时数据库，不访问外部行情。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync('.probe', {recursive: true});
  const directory = fs.mkdtempSync(path.resolve('.probe/request-security-'));
  const env = {...process.env, FINDSTOCK_DATA_DIR: directory,
    FINDSTOCK_DB_PATH: path.join(directory, 'test.sqlite3'),
    FINDSTOCK_LOG_DIR: path.join(directory, 'logs')};
  const python = process.env.PYTHON_COMMAND || path.resolve('.venv/Scripts/python.exe');
  execFileSync(python, ['-c', 'from app.container import Container; from app.core.config import get_settings; from app.domain.enums import SyncMode; Container.build(get_settings()).sync_repository.create_run("protected", SyncMode.INCREMENTAL)'], {env, windowsHide: true});
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(python, ['-m', 'uvicorn', 'app.main:create_app', '--factory',
    '--host', '127.0.0.1', '--port', String(port)], {env, windowsHide: true});
  let output = '', browser;
  server.stdout.on('data', data => { output += data; });
  server.stderr.on('data', data => { output += data; });
  const attacker = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<iframe name="result"></iframe><form target="result" method="POST" action="${base}/api/data/sync/cancel"></form><script>document.forms[0].submit()</script>`);
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(base + '/api/health')).ok; } catch {}
      if (ready || server.exitCode !== null) break;
      await pause(100);
    }
    assert.equal(ready, true, output);
    await new Promise(resolve => attacker.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
    const page = await browser.newPage();
    const rejected = page.waitForResponse(response => response.url() === base + '/api/data/sync/cancel');
    await page.goto(`http://127.0.0.1:${attacker.address().port}/`);
    assert.equal((await rejected).status(), 403);
    const phase = execFileSync(python, ['-c', 'from app.container import Container; from app.core.config import get_settings; print(Container.build(get_settings()).sync_repository.get("protected").phase)'], {env, windowsHide: true, encoding: 'utf8'});
    assert.equal(phase.trim(), 'starting');
    console.log('Browser origin protection passed; sync task was preserved.');
  } finally {
    if (browser) await browser.close();
    attacker.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

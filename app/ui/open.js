import { TrimApp } from '/app/FnOffice/trim-web-app.js?v=0.4.59';

const filePath = new URLSearchParams(location.search).get('path');
const msg = document.getElementById('message');
const auth = document.getElementById('authorize');
const openStandaloneButton = document.getElementById('openStandalone');
const apiBase = '/app/FnOffice';
const sdk = new TrimApp();
let currentSessionId = '';
let editorInstance = null;
let lastActivityAt = Date.now();
let heartbeatTimer = null;
let handingOffToStandalone = false;

function markActivity() { lastActivityAt = Date.now(); }
['pointerdown', 'keydown', 'input', 'focus'].forEach(type => window.addEventListener(type, markActivity, { passive: true }));

async function heartbeat() {
  if (!currentSessionId) return;
  try {
    await fetch(`${apiBase}/api/editor-session/${encodeURIComponent(currentSessionId)}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lastActivityAt, visible: document.visibilityState === 'visible' }),
      keepalive: true,
    });
  } catch {}
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(heartbeat, 10000);
  void heartbeat();
}

async function requestForceSave() {
  if (!currentSessionId) return;
  try {
    await fetch(`${apiBase}/api/editor-session/${encodeURIComponent(currentSessionId)}/force-save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      keepalive: true,
    });
  } catch {}
}
window.addEventListener('pagehide', () => { if (!handingOffToStandalone) void requestForceSave(); });

async function openStandaloneEditor() {
  if (!filePath || handingOffToStandalone) return;
  handingOffToStandalone = true;
  openStandaloneButton.disabled = true;
  try {
    const target = new URL(location.href);
    target.searchParams.set('standalone', '1');
    await sdk.ready();
    await sdk.openURL(target.toString(), '_blank');
    await sdk.close();
  } catch (error) {
    handingOffToStandalone = false;
    openStandaloneButton.disabled = false;
    msg.textContent = `无法打开独立编辑器：${error.message || error}`;
  }
}

if (new URLSearchParams(location.search).get('standalone') === '1') {
  openStandaloneButton.hidden = true;
} else {
  openStandaloneButton.onclick = openStandaloneEditor;
}

async function reportEditorError(code, description = '') {
  if (!currentSessionId) return;
  const sessionId = currentSessionId;
  currentSessionId = '';
  clearInterval(heartbeatTimer);
  try {
    await fetch(`${apiBase}/api/editor-session/${encodeURIComponent(sessionId)}/error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: String(code || 'unknown').slice(0, 32), description: String(description || '').slice(0, 200) }),
      keepalive: true,
    });
  } catch {}
}

async function openDoc() {
  if (!filePath) { msg.textContent = '未收到文件路径。'; return; }
  msg.textContent = '正在读取文档…';
  let r;
  let d;
  try {
    r = await fetch(`${apiBase}/api/editor-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: filePath }) });
    d = await r.json();
  } catch (error) {
    msg.textContent = `无法读取文档：${error.message}`;
    return;
  }
  if (!r.ok) {
    msg.textContent = d.error === 'file_access_denied' ? '需要先授权当前文件。' : `无法打开：${d.message || d.error}`;
    auth.hidden = d.error !== 'file_access_denied';
    return;
  }
  currentSessionId = d.sessionId || '';
  startHeartbeat();
  // The Document Server dialog only shows a short localized message. Keep its
  // detailed code in the parent console without recording document contents.
  d.editorConfig.events = {
    ...(d.editorConfig.events || {}),
    onRequestClose() {
      void requestForceSave().finally(() => {
        try { editorInstance?.destroyEditor(); } catch {}
      });
    },
    onError(event) {
      const detail = event?.data || {};
      const code = detail.errorCode ?? detail.code ?? 'unknown';
      const description = detail.errorDescription || detail.description || '';
      console.error('[FnOffice] OnlyOffice editor error', JSON.stringify({ code, description, raw: detail }));
      msg.textContent = `OnlyOffice 无法加载文档（错误代码：${code}${description ? `，${description}` : ''}）。`;
      void reportEditorError(code, description);
    },
  };
  const script = document.createElement('script');
  const documentServer = String(d.browserOnlyOfficeUrl || `${apiBase}/onlyoffice`).replace(/\/$/, '');
  script.src = `${documentServer}/web-apps/apps/api/documents/api.js`;
  script.onerror = () => {
    msg.textContent = 'OnlyOffice 未连接，请在 FnOffice 设置中检查服务状态或先完成自动安装。';
    void reportEditorError('script_load_failed');
  };
  script.onload = () => {
    try { editorInstance = new DocsAPI.DocEditor('placeholder', d.editorConfig); msg.textContent = ''; }
    catch (error) {
      msg.textContent = `OnlyOffice 编辑器加载失败：${error.message}`;
      void reportEditorError('editor_init_failed', error.message);
    }
  };
  document.head.appendChild(script);
}

auth.onclick = async () => {
  if (!filePath) return;
  auth.disabled = true;
  try {
    await sdk.ready();
    if (sdk.isStandaloneWeb) {
      const redirectUri = `${apiBase}/auth-callback.html`;
      await sdk.openAppAuth('authorizeUserFile', { appName: 'FnOffice', path: filePath, redirectUri, state: filePath }, { target: '_self' });
      return;
    }
    const result = await sdk.authorizeUserFile(filePath);
    if (result?.code && result.code !== 0) throw new Error(result.msg || '授权未完成');
    await openDoc();
  } catch (error) {
    msg.textContent = `无法申请文件授权：${error.message || error}`;
  } finally {
    auth.disabled = false;
  }
};

openDoc();

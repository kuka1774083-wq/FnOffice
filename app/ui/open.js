import { TrimApp } from '/app/FnOffice/trim-web-app.js?v=0.4.59';

const pageUrl = new URL(location.href);
const filePath = pageUrl.searchParams.get('path');
const shareToken = pageUrl.pathname.match(/\/share\/([^/]+)$/)?.[1] || '';
const manageShareToken = pageUrl.searchParams.get('manageShare') || '';
const reshareRequested = pageUrl.searchParams.get('reshare') === '1';
const msg = document.getElementById('message');
const auth = document.getElementById('authorize');
const openStandaloneButton = document.getElementById('openStandalone');
const downloadButton = document.getElementById('downloadFile');
const shareButton = document.getElementById('shareFile');
const shareDialog = document.getElementById('shareDialog');
const shareChoice = document.getElementById('shareChoice');
const shareDownload = document.getElementById('shareDownload');
const shareWrite = document.getElementById('shareWrite');
const shareUrlInput = document.getElementById('shareUrl');
const shareStatus = document.getElementById('shareStatus');
const copyShareUrl = document.getElementById('copyShareUrl');
const revokeShare = document.getElementById('revokeShare');
const saveShare = document.getElementById('saveShare');
const reuseShare = document.getElementById('reuseShare');
const newShare = document.getElementById('newShare');
const apiBase = '/app/FnOffice';
const sdk = new TrimApp();
let currentSessionId = '';
let editorInstance = null;
let lastActivityAt = Date.now();
let heartbeatTimer = null;
let handingOffToStandalone = false;
let shareState = null;
let editorReady = false;
const visitorId = (() => { try { const key='fnoffice-share-visitor'; let value=localStorage.getItem(key); if(!value){value=crypto.randomUUID();localStorage.setItem(key,value);}return value; } catch { return crypto.randomUUID(); } })();

function markActivity() { lastActivityAt = Date.now(); }
function askConfirm(message) {
  return new Promise(resolve => {
    const dialog=document.createElement('dialog'); dialog.className='share-dialog confirm-dialog';
    dialog.innerHTML=`<form method="dialog"><h2>确认操作</h2><p class="share-dialog-hint"></p><div class="share-dialog-actions"><button value="cancel" type="submit">取消</button><button class="editor-toolbar-button" value="ok" type="submit">确定</button></div></form>`;
    dialog.querySelector('.share-dialog-hint').textContent=message; document.body.appendChild(dialog);
    dialog.addEventListener('close',()=>{resolve(dialog.returnValue==='ok');dialog.remove();},{once:true}); dialog.showModal();
  });
}
['pointerdown', 'keydown', 'input', 'focus'].forEach(type => window.addEventListener(type, markActivity, { passive: true }));

async function heartbeat() {
  if (!currentSessionId) return;
  try {
    await fetch(`${apiBase}/api/editor-session/${encodeURIComponent(currentSessionId)}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lastActivityAt, visible: document.visibilityState === 'visible', shareToken }),
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
      body: JSON.stringify({ shareToken }),
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
if (shareToken) shareButton.hidden = true;

async function reportEditorError(code, description = '') {
  if (!currentSessionId) return;
  const sessionId = currentSessionId;
  currentSessionId = '';
  clearInterval(heartbeatTimer);
  try {
    await fetch(`${apiBase}/api/editor-session/${encodeURIComponent(sessionId)}/error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: String(code || 'unknown').slice(0, 32), description: String(description || '').slice(0, 200), shareToken }),
      keepalive: true,
    });
  } catch {}
}

async function openDoc() {
  if (!filePath && !shareToken) { msg.textContent = '未收到文件路径。'; return; }
  msg.textContent = '正在读取文档…';
  let r;
  let d;
  try {
    r = await fetch(`${apiBase}/api/editor-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: filePath, shareToken, visitorId }) });
    d = await r.json();
  } catch (error) {
    msg.textContent = `无法读取文档：${error.message}`;
    return;
  }
  if (!r.ok) {
    msg.textContent = d.error === 'file_access_denied' ? '需要先授权当前文件。' : `无法打开：${d.message || d.error}`;
    auth.hidden = shareToken || d.error !== 'file_access_denied';
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
      if (!editorReady) msg.textContent = `OnlyOffice 无法加载文档（错误代码：${code}${description ? `，${description}` : ''}）。`;
      else { const previous=shareStatus.textContent; shareStatus.textContent=`连接暂时中断（${code}），正在由 OnlyOffice 自动恢复…`; setTimeout(()=>{if(shareStatus.textContent.includes('连接暂时中断'))shareStatus.textContent=previous;},8000); }
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
      try { editorInstance = new DocsAPI.DocEditor('placeholder', d.editorConfig); editorReady=true; msg.textContent = ''; }
    catch (error) {
      msg.textContent = `OnlyOffice 编辑器加载失败：${error.message}`;
      void reportEditorError('editor_init_failed', error.message);
    }
  };
  document.head.appendChild(script);
}

function setShareButton() {
  shareButton.textContent = shareState?.active ? '分享权限管理' : '↗ 对外分享';
}
function showShareDialog(share) {
  shareState = {...shareState, active:share};
  shareDownload.checked = share.permissions.download === true;
  shareWrite.checked = share.permissions.write === true;
  shareUrlInput.value = share.url;
  shareStatus.textContent = '链接已启用。权限变更会立即生效。';
  revokeShare.hidden = false;
  setShareButton();
  if (!shareDialog.open) shareDialog.showModal();
}
async function loadShareState() {
  if (!filePath || shareToken) return null;
  const response = await fetch(`${apiBase}/api/shares?path=${encodeURIComponent(filePath)}`);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || '无法读取分享状态');
  shareState = await response.json(); setShareButton(); return shareState;
}
async function createOrReuseShare(mode) {
  if (!await askConfirm('分享链接可免登录访问文件。请确认链接只发送给可信访客。')) return;
  const response = await fetch(`${apiBase}/api/shares`, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({path:filePath,mode,permissions:{download:false,write:false}}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || '创建分享链接失败');
  showShareDialog(data.share);
}
async function openShareManager() {
  try {
    const state = await loadShareState();
    if (state.active) return showShareDialog(state.active);
    if (state.hasPrevious) { shareChoice.showModal(); return; }
    await createOrReuseShare('new');
  } catch (error) { msg.textContent = `无法管理分享：${error.message || error}`; }
}
async function saveSharePermissions() {
  try {
    saveShare.disabled = true;
    const response=await fetch(`${apiBase}/api/shares`, {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({path:filePath,mode:'reuse',permissions:{download:shareDownload.checked,write:shareWrite.checked}})});
    const data=await response.json().catch(()=>({})); if(!response.ok) throw new Error(data.message||data.error||'保存失败');
    showShareDialog(data.share); shareStatus.textContent='分享权限已保存。';
  } catch(error) { shareStatus.textContent=`保存失败：${error.message||error}`; }
  finally { saveShare.disabled=false; }
}
async function revokeShareLink() {
  if (!await askConfirm('撤回后该链接将立即失效，确定继续吗？')) return;
  try {
    revokeShare.disabled=true;
    const response=await fetch(`${apiBase}/api/shares?path=${encodeURIComponent(filePath)}`,{method:'DELETE'});
    const data=await response.json().catch(()=>({})); if(!response.ok) throw new Error(data.message||data.error||'撤回失败');
    shareState={...shareState,active:null,previous:data.previous}; setShareButton(); shareDialog.close();
  } catch(error) { shareStatus.textContent=`撤回失败：${error.message||error}`; }
  finally { revokeShare.disabled=false; }
}
async function copyShareLink() {
  try { await navigator.clipboard.writeText(shareUrlInput.value); shareStatus.textContent='链接已复制。'; }
  catch { shareUrlInput.focus(); shareUrlInput.select(); shareStatus.textContent='请从上方文本框手动复制链接。'; }
}
function downloadCurrentFile() {
  const target=shareToken ? `${apiBase}/share/${encodeURIComponent(shareToken)}/download` : `${apiBase}/api/file-download?path=${encodeURIComponent(filePath)}`;
  window.location.assign(target);
}

downloadButton.onclick = downloadCurrentFile;
shareButton.onclick = openShareManager;
saveShare.onclick = saveSharePermissions;
revokeShare.onclick = revokeShareLink;
copyShareUrl.onclick = copyShareLink;
reuseShare.onclick = async () => { shareChoice.close(); try { await createOrReuseShare('reuse'); } catch(error) { msg.textContent=`无法启用分享：${error.message||error}`; } };
newShare.onclick = async () => { shareChoice.close(); try { await createOrReuseShare('new'); } catch(error) { msg.textContent=`无法创建新链接：${error.message||error}`; } };

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

if (!shareToken) void loadShareState().then(async state => { if (manageShareToken && state?.active) showShareDialog(state.active); else if (manageShareToken && reshareRequested && state?.hasPrevious) await createOrReuseShare('reuse'); }).catch(() => { shareButton.hidden = true; });
openDoc();

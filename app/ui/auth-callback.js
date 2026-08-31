import { TrimApp } from '/app/FnOffice/trim-web-app.js?v=0.4.59';

const message = document.getElementById('message');
const result = new TrimApp().parseAppAuthCallback(window.location.href);
if (result.status === 'success' || result.path?.length) {
  const path = result.state;
  if (path) window.location.replace(`/app/FnOffice/open?path=${encodeURIComponent(path)}`);
  else message.textContent = '授权完成，请返回文件管理器重新打开文件。';
} else {
  message.textContent = `文件授权未完成：${result.error || '已取消'}`;
}

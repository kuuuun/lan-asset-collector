/*
 * 帮助页的「首次安装」提示条。
 *
 * 为什么单独放一个文件，而不写在 HTML 里：
 * MV3 的默认内容安全策略是 script-src 'self'，页面上任何**内联** <script> 都会被
 * 直接拦掉，扩展管理页的「错误」里就会红一条
 * 「Executing inline script violates the following Content Security Policy directive
 *   'script-src 'self'」。
 * 同理，onclick="..." 这类内联事件属性也在被禁之列 —— 要绑事件一律用 addEventListener。
 * （内联的 <style> 与 style="" 不受影响：MV3 默认策略没有限制 style-src。）
 */
(function () {
  if (location.search.indexOf('first=1') < 0) return;
  var el = document.getElementById('first');
  if (el) el.hidden = false;
})();

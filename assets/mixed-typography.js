(function (scope) {
  "use strict";

  var han = /\p{Script=Han}/u;
  var westernStart = /[A-Za-z0-9$£€¥±]/;
  var westernEnd = /[A-Za-z0-9%‰°$£€¥]/;
  // Preserve addresses and code literally, including any Chinese path segments.
  var literal = /https?:\/\/[^\s<>"'，。；：！？（）【】《》、]+|www\.[^\s<>"'，。；：！？（）【】《》、]+|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|`[^`\n]+`/g;
  var excluded = "script,style,code,pre,kbd,samp,textarea,input,[contenteditable]:not([contenteditable='false']),[data-typography='literal'],[data-accounting-money],option:not([value])";
  var labelAttributes = ["title", "aria-label", "aria-description", "alt", "placeholder"];

  function needsSpace(left, right) {
    if (!left || !right) return false;
    var tail = Array.from(left).pop(), head = Array.from(right)[0];
    return (han.test(tail) && (westernStart.test(head) || /^[+−-]\d/.test(right))) ||
      (westernEnd.test(tail) && han.test(head));
  }

  function spaceProse(text) {
    return text.replace(/(\p{Script=Han})([A-Za-z0-9$£€¥±])/gu, "$1 $2")
      .replace(/(\p{Script=Han})([+−-])(?=\d)/gu, "$1 $2")
      .replace(/([A-Za-z0-9%‰°$£€¥])(\p{Script=Han})/gu, "$1 $2");
  }

  function formatText(text) {
    var result = "", end = 0;
    function append(piece) {
      if (needsSpace(result, piece)) result += " ";
      result += piece;
    }
    String(text).replace(literal, function (match, offset) {
      append(spaceProse(String(text).slice(end, offset)));
      append(match);
      end = offset + match.length;
      return match;
    });
    append(spaceProse(String(text).slice(end)));
    return result;
  }

  function formatTree(root) {
    var previous = null;
    function visit(node) {
      if (node.nodeType === 3) {
        var text = formatText(node.data);
        // Adjacent inline emphasis/links belong to the same reading flow.
        if (previous && needsSpace(previous.data, text)) text = " " + text;
        if (text !== node.data) node.data = text;
        if (text) previous = node;
        return;
      }
      if (node.nodeType !== 1) return;
      labelAttributes.forEach(function (name) {
        if (node.closest("[data-typography='literal']") || !node.hasAttribute(name)) return;
        var value = node.getAttribute(name), formatted = formatText(value);
        if (value !== formatted) node.setAttribute(name, formatted);
      });
      if (node.matches(excluded)) { previous = null; return; }
      var display = getComputedStyle(node).display;
      var boundary = (display !== "inline" && display !== "contents") ||
        /^(BR|HR|TEXT)$/.test(node.tagName.toUpperCase());
      if (boundary) previous = null;
      Array.from(node.childNodes).forEach(visit);
      if (boundary) previous = null;
    }
    visit(root);
  }

  scope.MixedTypography = Object.freeze({ formatText: formatText, formatTree: formatTree });
  if (typeof document === "undefined") return;

  var roots = new Set(), pending = false;
  function contextRoot(node) {
    var element = node.nodeType === 1 ? node : node.parentElement;
    if (!element || element.closest(excluded)) return null;
    while (element.parentElement && element !== document.body) {
      var display = getComputedStyle(element).display;
      if (display !== "inline" && display !== "contents") break;
      element = element.parentElement;
    }
    return element;
  }
  function observe() {
    observer.observe(document.documentElement, { subtree: true, childList: true,
      characterData: true, attributes: true, attributeFilter: labelAttributes });
  }
  function flush() {
    pending = false;
    observer.disconnect();
    try {
      var work = Array.from(roots).filter(function (node) { return node.isConnected; });
      roots.clear();
      work.filter(function (node) {
        return !work.some(function (other) { return other !== node && other.contains(node); });
      }).forEach(formatTree);
      var title = formatText(document.title);
      if (title !== document.title) document.title = title;
    } finally { observe(); }
  }
  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      var root = mutation.type === "attributes" ? mutation.target : contextRoot(mutation.target);
      if (root) roots.add(root);
    });
    if (!pending) { pending = true; queueMicrotask(flush); }
  });
  function start() {
    if (document.body) roots.add(document.body);
    flush();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}(typeof window === "undefined" ? globalThis : window));

(function () {
  "use strict";

  var pendingFrame = 0;

  function visualColumnIndex(cell) {
    var index = 0;
    var sibling = cell.previousElementSibling;
    while (sibling) {
      index += Number(sibling.colSpan) || 1;
      sibling = sibling.previousElementSibling;
    }
    return index;
  }

  function measuredTextWidth(node) {
    var text = String(node.textContent || "");
    if (!text) return 0;
    var rect = node.getBoundingClientRect();
    if (rect.width > 0) return rect.width;
    var style = getComputedStyle(node);
    var probe = document.createElement("span");
    probe.textContent = text;
    probe.style.position = "fixed";
    probe.style.inset = "auto auto 0 -10000px";
    probe.style.display = "inline-block";
    probe.style.visibility = "hidden";
    probe.style.width = "max-content";
    probe.style.whiteSpace = "pre";
    [
      "fontFamily", "fontSize", "fontStyle", "fontWeight", "fontStretch",
      "fontVariant", "fontVariantNumeric", "fontFeatureSettings",
      "fontKerning", "fontVariationSettings", "letterSpacing", "textTransform"
    ].forEach(function (property) {
      probe.style[property] = style[property];
    });
    document.body.appendChild(probe);
    var width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  }

  function alignAccountingMoney() {
    pendingFrame = 0;
    observer.disconnect();
    try {
      var tables = new Map();
      document.querySelectorAll("table [data-accounting-money]").forEach(function (wrapper) {
        wrapper.style.removeProperty("--accounting-money-symbol-width");
        wrapper.style.removeProperty("--accounting-money-amount-width");
        wrapper.style.removeProperty("--accounting-money-lane-width");
        var cell = wrapper.closest("td, th");
        var table = wrapper.closest("table");
        var symbol = wrapper.querySelector("[data-accounting-symbol]");
        var amount = wrapper.querySelector("[data-accounting-amount]");
        if (!cell || !table || !symbol || !amount) return;
        if (!tables.has(table)) tables.set(table, new Map());
        var columns = tables.get(table);
        var columnIndex = visualColumnIndex(cell);
        if (!columns.has(columnIndex)) columns.set(columnIndex, []);
        columns.get(columnIndex).push({ wrapper: wrapper, symbol: symbol, amount: amount });
      });

      tables.forEach(function (columns) {
        columns.forEach(function (entries) {
          var symbolWidth = 0;
          var amountWidth = 0;
          var gapWidth = 0;
          entries.forEach(function (entry) {
            symbolWidth = Math.max(symbolWidth, measuredTextWidth(entry.symbol));
            amountWidth = Math.max(amountWidth, measuredTextWidth(entry.amount));
            var fontSize = Number.parseFloat(getComputedStyle(entry.wrapper).fontSize);
            gapWidth = Math.max(gapWidth, (Number.isFinite(fontSize) ? fontSize : 16) * 0.45);
          });
          symbolWidth = Math.ceil(symbolWidth * 100) / 100;
          amountWidth = Math.ceil(amountWidth * 100) / 100;
          var laneWidth = Math.ceil((symbolWidth + gapWidth + amountWidth) * 100) / 100;
          entries.forEach(function (entry) {
            entry.wrapper.style.setProperty("--accounting-money-symbol-width", symbolWidth + "px");
            entry.wrapper.style.setProperty("--accounting-money-amount-width", amountWidth + "px");
            entry.wrapper.style.setProperty("--accounting-money-lane-width", laneWidth + "px");
          });
        });
      });
    } finally {
      observeChanges();
    }
  }

  function scheduleAlignment() {
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(alignAccountingMoney);
  }

  function observeChanges() {
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "open", "aria-expanded"]
    });
  }

  var observer = new MutationObserver(scheduleAlignment);
  observeChanges();
  window.addEventListener("resize", scheduleAlignment, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleAlignment);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scheduleAlignment, { once: true });
  else scheduleAlignment();

  window.AccountingMoney = Object.freeze({ align: alignAccountingMoney });
}());

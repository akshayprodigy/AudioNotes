/* Theme toggle. The head script in every page has already set data-theme before paint; this only
   wires the buttons. Storage can throw in private modes, so every touch is guarded. */
(function () {
  var root = document.documentElement;
  var COLORS = { light: '#FAFBFE', dark: '#0A0C15' };

  function current() { return root.dataset.theme === 'dark' ? 'dark' : 'light'; }

  function paint() {
    var t = current();
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = COLORS[t];
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
    }
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-theme-toggle]') : null;
    if (!b) return;
    var next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('verbale-theme', next); } catch (err) {}
    paint();
  });

  paint();
})();

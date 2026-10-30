/* Shared behaviour: theme toggle, copy buttons, ⌘K search shortcut. */
(function () {
  var root = document.documentElement;

  function currentTheme() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function updateToggleLabels() {
    var target = currentTheme() === 'dark' ? 'Light' : 'Dark';
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) buttons[i].textContent = target;
  }

  function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch (e) { /* private mode */ }
    updateToggleLabels();
  }

  function copyFrom(button) {
    var text = button.getAttribute('data-copy') || '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
    } catch (e) { /* ignore */ }
    if (!button.hasAttribute('data-label')) button.setAttribute('data-label', button.textContent);
    button.textContent = button.getAttribute('data-copied') || 'copied';
    clearTimeout(button._copyTimer);
    button._copyTimer = setTimeout(function () {
      button.textContent = button.getAttribute('data-label');
    }, 1400);
  }

  document.addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-theme-toggle]');
    if (toggle) {
      setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      return;
    }
    var copy = e.target.closest('[data-copy]');
    if (copy) {
      e.preventDefault();
      e.stopPropagation();
      copyFrom(copy);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || (e.key !== 'k' && e.key !== 'K')) return;
    e.preventDefault();
    var input = document.getElementById('searchInput');
    if (input) {
      input.focus();
      input.select();
    } else {
      window.location.href = '/#search';
    }
  });

  updateToggleLabels();
})();

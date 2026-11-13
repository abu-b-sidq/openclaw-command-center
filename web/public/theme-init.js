// Paint the saved theme before Angular boots, so a dark-mode user never sees a light flash.
(function () {
  try {
    var t = localStorage.getItem('occ-theme');
    document.documentElement.dataset.theme = t === 'light' || t === 'dark' ? t : 'system';
  } catch (e) {
    /* storage blocked: stay on system */
  }
})();

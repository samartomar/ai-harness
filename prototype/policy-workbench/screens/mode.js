/* Light or dark, as in admin-sources: <html class="dark|light">. ?mode=light|dark wins, then the last choice, then dark.
 * Any button with data-mode-toggle (or the header's "Switch to ... mode" button) flips it. */
(function () {
  var d = document.documentElement, q = new URLSearchParams(location.search).get("mode"), saved = null;
  try { saved = localStorage.getItem("wb-mode"); } catch (e) {}
  function set(m) {
    d.classList.toggle("dark", m === "dark"); d.classList.toggle("light", m !== "dark"); d.dataset.mode = m;
    document.querySelectorAll("[data-mode-toggle], button[aria-label^='Switch to']").forEach(function (b) {
      b.setAttribute("aria-label", m === "dark" ? "Switch to light mode" : "Switch to dark mode");
      var i = b.querySelector(".material-symbols-outlined"); if (i) i.textContent = m === "dark" ? "light_mode" : "dark_mode";
    });
  }
  set(q === "light" || q === "dark" ? q : saved === "light" ? "light" : "dark");
  document.addEventListener("DOMContentLoaded", function () {
    set(d.dataset.mode);
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-mode-toggle], button[aria-label^='Switch to']"); if (!b) return;
      var m = d.classList.contains("dark") ? "light" : "dark"; set(m); try { localStorage.setItem("wb-mode", m); } catch (e2) {}
    });
  });
})();

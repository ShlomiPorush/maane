// Runs before the first paint (index.html loads it synchronously): applies the theme, the language this browser
// chose, and a folded sidebar, so the page never flashes in the wrong theme or direction. Without a choice of its
// own, the page starts in Hebrew and the app then follows the server's default language.
// A file rather than an inline script, so the Content Security Policy can forbid inline scripts.
;(() => {
  try {
    const theme = localStorage.getItem("maane.theme") || "system"
    const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
    document.documentElement.classList.toggle("dark", dark)
    const lang = localStorage.getItem("maane.language") === "en" ? "en" : "he"
    document.documentElement.lang = lang
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr"
    if (localStorage.getItem("maane.nav") === "rail") document.documentElement.dataset.nav = "rail"
  } catch {
    // Private mode or storage blocked: the defaults (the system's theme, Hebrew) stay.
  }
})()

;(() => {
  try {
    const theme = localStorage.getItem("maane.theme") || "system"
    const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
    document.documentElement.classList.toggle("dark", dark)
    const lang = localStorage.getItem("maane.language") === "en" ? "en" : "he"
    document.documentElement.lang = lang
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr"
    if (localStorage.getItem("maane.nav") === "rail") document.documentElement.dataset.nav = "rail"
  } catch {}
})()
;(() => {
  const marker = "maane.reloaded"
  let assetFailed = false
  const reloadOnce = () => {
    try {
      if (sessionStorage.getItem(marker)) return false
      sessionStorage.setItem(marker, "1")
    } catch {
      return false
    }
    location.reload()
    return true
  }
  const pageAsset = (element) => {
    const url =
      element instanceof HTMLScriptElement
        ? element.src
        : element instanceof HTMLLinkElement && element.rel === "stylesheet"
          ? element.href
          : ""
    if (!url) return false
    const parsed = new URL(url, location.href)
    return parsed.origin === location.origin && parsed.pathname.startsWith("/assets/")
  }
  window.addEventListener(
    "error",
    (event) => {
      if (!pageAsset(event.target)) return
      assetFailed = true
      reloadOnce()
    },
    true,
  )
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadOnce()) event.preventDefault()
  })
  window.addEventListener("load", () => {
    if (assetFailed) return
    try {
      sessionStorage.removeItem(marker)
    } catch {}
  })
})()

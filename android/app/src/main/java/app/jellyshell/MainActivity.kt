package app.jellyshell

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout

/**
 * JellyShell for Android: a WebView around the JellyShell web UI. Two flavors share this activity:
 *  - tv     (Android TV / Google TV): immersive, landscape. D-pad/OK = arrows/Enter (Chromium does that itself).
 *           Back -> keydown/keyup Escape (27) = the app's 'back' action (web/src/lib/input.ts). Back 5x in 2 s = settings.
 *  - mobile (phones/tablets): touch UI (html.mode-mobile), system bars visible, rotation, element fullscreen
 *           for the player. Back closes an open sheet, else WebView history (the mobile UI mirrors routes into
 *           history.pushState and handles popstate), else the app goes to the background.
 *           Settings = long-press the app icon -> "Server address", or the error dialog.
 * Playback stays in the page (hls.js + <video>, browser DeviceProfile). UA gets "<UA_TAG>/<version>".
 * Start URL: the saved one, else BuildConfig.DEFAULT_URL (gradle -PJELLYSHELL_DEFAULT_URL); empty = ask on first launch.
 * Debug: adb shell am start -n <applicationId>/app.jellyshell.MainActivity --es url https://host/jellyshell/
 */
class MainActivity : Activity() {
    companion object {
        val DEFAULT_URL: String = BuildConfig.DEFAULT_URL
        const val ACTION_SETTINGS = "app.jellyshell.SETTINGS"
        private const val PREFS = "jellyshell"
        private const val KEY_URL = "url"
        private const val BG = "#07070b"
        // The web UI's overlays that Back closes first (same list MobileChrome's popstate handler uses).
        private const val SHEETS = ".dialog-wrap, .epp-wrap, .sf-wrap, .rq-sheet-wrap:not(.hidden), .m-sheet-wrap"
    }

    private val isTv = BuildConfig.FLAVOR == "tv"
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private val ui = Handler(Looper.getMainLooper())
    private val backTimes = ArrayDeque<Long>()
    private var dialogOpen = false
    private var mainFrameFailed = false
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    private val prefs get() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    /** "" = nothing saved and no build-time default: the address dialog asks for one. */
    private val url: String get() = prefs.getString(KEY_URL, null) ?: DEFAULT_URL

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        intent?.getStringExtra("url")?.let { saveUrl(it) }

        WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect over adb, handy for support
        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor(BG))
            isFocusable = true
            isFocusableInTouchMode = true
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
        }
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            // Marker the web UI keys off (lib/mode.ts): JellyShellTV -> 10-foot layout, JellyShellMobile -> touch.
            userAgentString = "$userAgentString ${BuildConfig.UA_TAG}/${BuildConfig.VERSION_NAME}"
        }
        web.webChromeClient = object : WebChromeClient() {
            // Element fullscreen (the mobile player's fullscreen button) only works in a WebView through these two.
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) { callback.onCustomViewHidden(); return }
                customView = view
                customCallback = callback
                root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                web.visibility = View.INVISIBLE
                if (!isTv) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                applySystemBars()
            }
            override fun onHideCustomView() = leaveFullscreen()
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, u: String?, favicon: android.graphics.Bitmap?) {
                mainFrameFailed = false
            }
            override fun onReceivedError(view: WebView?, req: WebResourceRequest?, err: WebResourceError?) {
                if (req?.isForMainFrame == true) {
                    mainFrameFailed = true
                    showError(err?.description?.toString() ?: "Connection failed")
                }
            }
            // Phones: links to other sites (IMDb, TMDB, trailers) open in the browser instead of replacing the app.
            override fun shouldOverrideUrlLoading(view: WebView?, req: WebResourceRequest?): Boolean {
                val target = req?.url ?: return false
                if (isTv || !req.isForMainFrame || target.host == Uri.parse(url).host) return false
                return try { startActivity(Intent(Intent.ACTION_VIEW, target)); true } catch (_: Exception) { false }
            }
        }
        root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor(BG)); addView(web) }
        setContentView(root)
        if (!isTv) padForSystemBars()
        applySystemBars()
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else load()
        web.requestFocus()
        ui.postDelayed(awake, 15_000)
        if (intent?.action == ACTION_SETTINGS && url.isNotEmpty()) ui.post { showSettings() }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        intent?.getStringExtra("url")?.let { saveUrl(it); load() }
        if (intent?.action == ACTION_SETTINGS) showSettings()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() { super.onResume(); web.onResume(); applySystemBars() }
    override fun onPause() { web.onPause(); super.onPause() }
    override fun onDestroy() { ui.removeCallbacksAndMessages(null); web.destroy(); super.onDestroy() }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applySystemBars()
    }

    /** targetSdk 35 is edge-to-edge on Android 15: keep the page out from under the status/nav bars, cutout and keyboard. */
    private fun padForSystemBars() {
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (customView != null) v.setPadding(0, 0, 0, 0)
            else if (Build.VERSION.SDK_INT >= 30) {
                val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                v.setPadding(i.left, i.top, i.right, i.bottom)
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
    }

    /** TV: always immersive. Phone: bars visible, hidden only while the player is fullscreen. */
    @Suppress("DEPRECATION")
    private fun applySystemBars() {
        val immersive = isTv || customView != null
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                val bars = WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars()
                if (immersive) it.hide(bars) else it.show(bars)
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            window.decorView.systemUiVisibility = if (immersive) (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN) else 0
        }
        root.requestApplyInsets()
    }

    private fun leaveFullscreen() {
        val v = customView ?: return
        root.removeView(v)
        customView = null
        customCallback?.onCustomViewHidden()
        customCallback = null
        web.visibility = View.VISIBLE
        if (!isTv) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_USER
        applySystemBars()
    }

    /** Keep the screen on only while a <video> is actually playing (no screensaver mid-film, no burn-in in menus). */
    private val awake = object : Runnable {
        override fun run() {
            web.evaluateJavascript("(function(){var v=document.querySelector('video');return !!(v&&!v.paused&&!v.ended)})()") { r ->
                if (r == "true") window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            ui.postDelayed(this, 15_000)
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (dialogOpen || event.keyCode != KeyEvent.KEYCODE_BACK) return super.dispatchKeyEvent(event)
        if (mainFrameFailed) {
            if (event.action == KeyEvent.ACTION_UP) showSettings()
            return true
        }
        if (isTv) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0 && countBack()) {
                showSettings()
                return true
            }
            sendKey(if (event.action == KeyEvent.ACTION_DOWN) "keydown" else "keyup", event.repeatCount > 0)
            return true
        }
        if (event.action == KeyEvent.ACTION_UP) phoneBack()
        return true
    }

    /** Phone Back: fullscreen -> exit it; open sheet/dialog -> close it; route history -> pop; else background the app. */
    private fun phoneBack() {
        if (customView != null) { leaveFullscreen(); return }
        web.evaluateJavascript("!!document.querySelector('$SHEETS')") { open ->
            when {
                open == "true" -> { sendKey("keydown", false); sendKey("keyup", false) }
                web.canGoBack() -> web.goBack()
                else -> moveTaskToBack(true)
            }
        }
    }

    /** True on the 5th Back press within 2 s: the hidden way into settings on TV. */
    private fun countBack(): Boolean {
        val now = System.currentTimeMillis()
        backTimes.addLast(now)
        while (backTimes.isNotEmpty() && now - backTimes.first() > 2000) backTimes.removeFirst()
        if (backTimes.size >= 5) { backTimes.clear(); return true }
        return false
    }

    private fun sendKey(type: String, repeat: Boolean) {
        val js = "document.dispatchEvent(new KeyboardEvent('$type',{key:'Escape',code:'Escape',keyCode:27,which:27,repeat:$repeat,bubbles:true,cancelable:true}))"
        web.evaluateJavascript(js, null)
    }

    /** Load the configured page, or ask for an address when there is none yet (fork build without a default). */
    private fun load() {
        if (url.isEmpty()) ui.post { showSettings() } else web.loadUrl(url)
    }

    /** "" clears the saved address (back to the build default, which may be empty too). */
    private fun saveUrl(u: String) {
        var s = u.trim()
        if (s.isEmpty()) { prefs.edit().remove(KEY_URL).apply(); return }
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://$s"
        prefs.edit().putString(KEY_URL, s).apply()
    }

    private fun showError(msg: String) {
        if (dialogOpen) return
        dialogOpen = true
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Can't reach JellyShell")
            .setMessage("$url\n\n$msg")
            .setPositiveButton("Retry") { _, _ -> load() }
            .setNeutralButton("Change address") { _, _ -> ui.post { showSettings() } }
            .setOnDismissListener { dialogOpen = false }
            .show()
    }

    /**
     * Address of the JellyShell page server. First launch without a saved or build-time address: the same dialog,
     * worded as setup, and backing out of it leaves the app (there is nothing to show without an address).
     */
    private fun showSettings() {
        if (dialogOpen) return
        dialogOpen = true
        val firstRun = url.isEmpty()
        val input = EditText(this).apply {
            setText(url)
            hint = "http://192.168.1.10:8097/"
            setSingleLine()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSelection(text.length)
        }
        val b = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(if (firstRun) "Set up JellyShell" else "JellyShell address")
            .setMessage(
                if (firstRun) "Enter the address of your JellyShell server (the page server, usually port 8097, or its public URL)."
                else if (DEFAULT_URL.isNotEmpty()) "Default: $DEFAULT_URL" else "Leave empty and Save to clear it."
            )
            .setView(FrameLayout(this).apply { setPadding(48, 8, 48, 0); addView(input) })
            .setPositiveButton(if (firstRun) "Connect" else "Save") { _, _ -> saveUrl(input.text.toString()); load() }
            .setOnDismissListener { dialogOpen = false; web.requestFocus() }
        if (firstRun) b.setNegativeButton("Exit") { _, _ -> finish() }.setOnCancelListener { finish() }
        else {
            if (DEFAULT_URL.isNotEmpty()) b.setNeutralButton("Reset") { _, _ -> prefs.edit().remove(KEY_URL).apply(); load() }
            b.setNegativeButton("Cancel", null)
        }
        b.show()
    }
}

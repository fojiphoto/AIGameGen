package __PACKAGE__;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * The entire native surface of a game: one full-screen WebView serving the bundled
 * assets over a synthetic HTTPS origin.
 *
 * WHY NOT file:///android_asset/index.html, WHICH IS THE OBVIOUS ANSWER
 * Because a file:// page is not a real origin, and three things a game needs stop
 * working there:
 *
 *   1. fetch() rejects file:// URLs outright — not a CORS failure, an unsupported
 *      scheme. Any game that loads a data file, a WebAssembly module or a wheel at
 *      runtime shows a loading bar that never finishes. That is exactly what the
 *      Python-on-WebAssembly games do.
 *   2. WebAssembly.instantiateStreaming needs a response with a real
 *      application/wasm content type. file:// supplies no content type at all.
 *   3. localStorage on an opaque origin is at the WebView's discretion, and the
 *      save system — progress, high scores, unlocks — is built on it.
 *
 * So requests to https://appassets.androidplatform.net/ are intercepted and answered
 * from the APK's own assets. That host is reserved precisely for this and does not
 * resolve on the public internet, and since the app holds no INTERNET permission,
 * anything this interceptor fails to answer fails loudly rather than quietly
 * reaching the network.
 *
 * Assets keep their directory structure. aapt2's -A packaging would mangle nested
 * paths on Windows into entries like "assets/runtime\main.wasm" that AssetManager
 * cannot resolve, so tools/build-apk.mjs appends nested files with `aapt add`
 * instead and then asserts the final entry names.
 *
 * Deliberately NOT Capacitor. An offline canvas game needs no native plugins, and
 * hand-rolling this removes Node, npm and the whole Capacitor dependency chain
 * from the build worker while producing a smaller APK. If IAP, AdMob or haptics
 * are added later, that is the point to reconsider.
 *
 * The app requests NO permissions at all — not even INTERNET. That is both an
 * honest privacy claim and a hard guarantee that the game really is offline.
 */
public class MainActivity extends Activity {

    /** Reserved by Android for exactly this purpose; never resolves publicly. */
    private static final String HOST = "appassets.androidplatform.net";
    private static final String ORIGIN = "https://" + HOST + "/";

    /**
     * The WebAssembly runtime fetches part of itself from a public CDN at run time.
     *
     * Even the "self-hosted" web build does this: the Python interpreter is served from our own
     * files, but the loader then goes to pygame-web.github.io for its package index and for the
     * pygame wheel. On a website that is invisible. In an app holding no INTERNET permission it
     * is a loading bar that never finishes, which is exactly how this was found.
     *
     * Those two files are already mirrored into the bundle, so requests to that host are
     * answered from the mirror instead of from the network. Interception happens before the
     * network stack is consulted, so nothing leaves the device either way — the difference is
     * whether the game starts.
     */
    private static final String CDN_HOST = "pygame-web.github.io";
    private static final String CDN_PREFIX = "/cdn/";
    private static final String MIRROR = "engine-runtime/";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        // Players hold a phone without touching the screen for long stretches.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        // localStorage — the save system (progress, stars, high scores) needs this.
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        // Lets the WebAudio context start without a separate gesture handshake.
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100); // ignore the OS font-size setting; it would break HUD layout

        web.setWebViewClient(new AssetClient(getAssets()));
        web.setBackgroundColor(0xFF000000);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setHorizontalScrollBarEnabled(false);
        web.setVerticalScrollBarEnabled(false);

        setContentView(web);
        hideSystemUi();

        web.loadUrl(ORIGIN + "index.html");
    }

    private void hideSystemUi() {
        // setSystemUiVisibility is deprecated on API 30+ but still honoured, and it
        // compiles against every minSdk we support without a compat library.
        View d = getWindow().getDecorView();
        d.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    /**
     * Hardware back: let the game handle it first (pause menu), and only exit from
     * the top level. Without this, back instantly kills the app mid-run.
     */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (web != null && web.canGoBack()) {
                web.goBack();
            } else {
                finish();
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) {
            web.onPause();
            web.pauseTimers(); // stops requestAnimationFrame and JS timers
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.resumeTimers();
            web.onResume();
        }
        hideSystemUi();
    }

    /**
     * Serves the APK's own assets over the synthetic origin.
     *
     * Three details here are load-bearing:
     *
     *   - It never returns null for our own host. Returning null tells the WebView to
     *       fetch the URL itself, which with no INTERNET permission fails with a network
     *       error that looks nothing like the missing file it actually is. A 404 we
     *       build ourselves says what went wrong.
     *   - The MIME type is derived from the extension, and it genuinely matters:
     *       WebAssembly.instantiateStreaming rejects anything that is not
     *       application/wasm, and a .js served as text/plain will not execute.
     *   - Directory paths get index.html appended, so a game that links to a folder
     *       behaves the way it does on a web server.
     */
    private static final class AssetClient extends WebViewClient {

        private final AssetManager assets;

        AssetClient(AssetManager assets) {
            this.assets = assets;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String host = url.getHost();
            String path = url.getPath();
            if (path == null) path = "/";

            if (CDN_HOST.equals(host) && path.startsWith(CDN_PREFIX)) {
                path = "/" + MIRROR + path.substring(CDN_PREFIX.length());
            } else if (!HOST.equals(host)) {
                return null;
            }
            // Collapse the empty segments a "dir//file.js" reference produces; the
            // browser keeps them verbatim but AssetManager treats them as real names.
            path = path.replaceAll("/+", "/");
            if (path.startsWith("/")) path = path.substring(1);
            if (path.isEmpty() || path.endsWith("/")) path = path + "index.html";

            try {
                InputStream in = assets.open(path);
                WebResourceResponse res =
                        new WebResourceResponse(mimeOf(path), null, 200, "OK", headers(), in);
                return res;
            } catch (IOException missing) {
                return notFound(path);
            }
        }

        private Map<String, String> headers() {
            Map<String, String> h = new HashMap<>();
            // Everything is same-origin here, but a game may load a worker or a module
            // and the checks still run. Being explicit costs nothing.
            h.put("Access-Control-Allow-Origin", "*");
            h.put("Cache-Control", "no-cache");
            return h;
        }

        private WebResourceResponse notFound(String path) {
            byte[] body = ("Not in this APK: " + path).getBytes();
            return new WebResourceResponse(
                    "text/plain", "utf-8", 404, "Not Found", headers(),
                    new java.io.ByteArrayInputStream(body));
        }

        private static String mimeOf(String path) {
            int dot = path.lastIndexOf('.');
            String ext = dot < 0 ? "" : path.substring(dot + 1).toLowerCase();
            switch (ext) {
                case "html": case "htm": return "text/html";
                case "js": case "mjs":   return "text/javascript";
                case "css":              return "text/css";
                case "json":             return "application/json";
                case "wasm":             return "application/wasm";
                case "png":              return "image/png";
                case "jpg": case "jpeg": return "image/jpeg";
                case "gif":              return "image/gif";
                case "svg":              return "image/svg+xml";
                case "webp":             return "image/webp";
                case "ico":              return "image/x-icon";
                case "woff":             return "font/woff";
                case "woff2":            return "font/woff2";
                case "ttf":              return "font/ttf";
                case "mp3":              return "audio/mpeg";
                case "ogg":              return "audio/ogg";
                case "wav":              return "audio/wav";
                case "mp4":              return "video/mp4";
                // .data, .whl, .apk and anything else: an opaque byte stream, which is
                // what the code fetching them expects.
                default:                 return "application/octet-stream";
            }
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}

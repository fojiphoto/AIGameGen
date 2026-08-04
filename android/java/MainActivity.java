package __PACKAGE__;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * The entire native surface of a generated game: one full-screen WebView loading
 * bundled assets from file:///android_asset/index.html.
 *
 * Assets are stored FLAT (no subdirectory) on purpose. aapt2's -A packaging emits
 * OS-native separators for nested asset paths on Windows, producing zip entries
 * like "assets/public\index.html" that the Android AssetManager cannot resolve.
 * Keeping the tree flat sidesteps it, and tools/build-apk.mjs asserts the final
 * entry names so the problem can never come back silently.
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

        web.setWebViewClient(new WebViewClient());
        web.setBackgroundColor(0xFF000000);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setHorizontalScrollBarEnabled(false);
        web.setVerticalScrollBarEnabled(false);

        setContentView(web);
        hideSystemUi();

        web.loadUrl("file:///android_asset/index.html");
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

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}

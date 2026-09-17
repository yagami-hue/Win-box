package android.webkit;

import android.content.Context;
import android.view.View;

import java.util.Map;

/**
 * WebSettings stub —— WebView 配置项集合。
 *
 * <p>真实调用面（扫描确认）：内部枚举 {@code LayoutAlgorithm} / {@code PluginState} /
 * {@code RenderPriority}，以及大量 {@code setXxx} / {@code getXxx}。
 *
 * <p>★ 枚举**必须把常量补齐**：蜘蛛字节码里是
 * {@code getstatic WebSettings$LayoutAlgorithm.NARROW_COLUMNS}，
 * 少一个常量就是 NoSuchFieldError（在类初始化阶段直接炸，连方法体都进不去）。
 * 这里按安卓 API 28 的真实枚举成员全量声明。
 */
public class WebSettings {

    /** 布局算法（安卓原版常量，勿删减）。 */
    public enum LayoutAlgorithm {
        NORMAL,
        NARROW_COLUMNS,
        TEXT_AUTOSIZING
    }

    /** 插件状态（安卓原版常量，勿删减）。 */
    public enum PluginState {
        ON,
        ON_DEMAND,
        OFF
    }

    /** 渲染优先级（安卓原版常量，勿删减）。 */
    public enum RenderPriority {
        NORMAL,
        HIGH,
        LOW
    }

    public enum ZoomDensity {
        FAR,
        MEDIUM,
        CLOSE
    }

    public enum TextSize {
        SMALLEST,
        SMALLER,
        NORMAL,
        LARGER,
        LARGEST
    }

    WebSettings() {
    }

    public void setSupportZoom(boolean support) {
    }

    public boolean supportZoom() {
        return false;
    }

    public void setMediaPlaybackRequiresUserGesture(boolean require) {
    }

    public boolean getMediaPlaybackRequiresUserGesture() {
        return false;
    }

    public void setBuiltInZoomControls(boolean enabled) {
    }

    public boolean getBuiltInZoomControls() {
        return false;
    }

    public void setDisplayZoomControls(boolean enabled) {
    }

    public boolean getDisplayZoomControls() {
        return false;
    }

    public void setAllowFileAccess(boolean allow) {
    }

    public boolean getAllowFileAccess() {
        return true;
    }

    public void setAllowContentAccess(boolean allow) {
    }

    public boolean getAllowContentAccess() {
        return true;
    }

    public void setLoadWithOverviewMode(boolean overview) {
    }

    public boolean getLoadWithOverviewMode() {
        return false;
    }

    public void setLoadsImagesAutomatically(boolean flag) {
    }

    public boolean getLoadsImagesAutomatically() {
        return true;
    }

    public void setBlockNetworkImage(boolean flag) {
    }

    public boolean getBlockNetworkImage() {
        return false;
    }

    public void setBlockNetworkLoads(boolean flag) {
    }

    public boolean getBlockNetworkLoads() {
        return false;
    }

    public void setJavaScriptEnabled(boolean flag) {
    }

    public void setAllowUniversalAccessFromFileURLs(boolean flag) {
    }

    public void setAllowFileAccessFromFileURLs(boolean flag) {
    }

    public void setPluginState(PluginState state) {
    }

    public void setDatabasePath(String databasePath) {
    }

    public void setGeolocationDatabasePath(String databasePath) {
    }

    public void setAppCacheEnabled(boolean flag) {
    }

    public void setAppCachePath(String appCachePath) {
    }

    public void setAppCacheMaxSize(long appCacheMaxSize) {
    }

    public void setDatabaseEnabled(boolean flag) {
    }

    public void setDomStorageEnabled(boolean flag) {
    }

    public boolean getDomStorageEnabled() {
        return true;
    }

    public void setGeolocationEnabled(boolean flag) {
    }

    public void setJavaScriptCanOpenWindowsAutomatically(boolean flag) {
    }

    public void setDefaultTextEncodingName(String encoding) {
    }

    public void setUserAgentString(String ua) {
    }

    public String getUserAgentString() {
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    }

    public void setUseWideViewPort(boolean use) {
    }

    public boolean getUseWideViewPort() {
        return false;
    }

    public void setSupportMultipleWindows(boolean support) {
    }

    public void setLayoutAlgorithm(LayoutAlgorithm l) {
    }

    public LayoutAlgorithm getLayoutAlgorithm() {
        return LayoutAlgorithm.NORMAL;
    }

    public void setStandardFontFamily(String font) {
    }

    public void setFixedFontFamily(String font) {
    }

    public void setSansSerifFontFamily(String font) {
    }

    public void setSerifFontFamily(String font) {
    }

    public void setCursiveFontFamily(String font) {
    }

    public void setFantasyFontFamily(String font) {
    }

    public void setMinimumFontSize(int size) {
    }

    public void setMinimumLogicalFontSize(int size) {
    }

    public void setDefaultFontSize(int size) {
    }

    public void setDefaultFixedFontSize(int size) {
    }

    public void setTextZoom(int textZoom) {
    }

    public int getTextZoom() {
        return 100;
    }

    public void setCacheMode(int mode) {
    }

    public int getCacheMode() {
        return 0;
    }

    public void setMixedContentMode(int mode) {
    }

    public void setRenderPriority(RenderPriority priority) {
    }

    public void setOffscreenPreRaster(boolean enabled) {
    }

    public void setSafeBrowsingEnabled(boolean enabled) {
    }

    public void setSaveFormData(boolean save) {
    }

    public void setSavePassword(boolean save) {
    }

    public void setLightTouchEnabled(boolean enabled) {
    }

    public void setNeedInitialFocus(boolean flag) {
    }

    public void setEnableSmoothTransition(boolean enable) {
    }

    public void setDatabasePath(Context context, String databasePath) {
        setDatabasePath(databasePath);
    }

    /** 部分蜘蛛用 map 一次性下发；保持签名兼容即可。 */
    public void setUserAgent(Map<String, String> ignored) {
    }

    public void setVisualZoomLevelLimits(float min, float max) {
    }

    public void setDisplayZoomControls(View view) {
    }

    public void setSupportZoom(float scale) {
    }
}

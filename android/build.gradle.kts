// Investment Tracker for Android: the same Python backend (embedded with Chaquopy) and the same web frontend
// (in a WebView), with the encrypted vault kept in the app's private storage and opened from / saved to any file.
plugins {
    id("com.android.application") version "8.9.3" apply false
    id("org.jetbrains.kotlin.android") version "2.1.21" apply false
    id("com.chaquo.python") version "17.2.0" apply false
}

package com.investmenttracker.app

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.net.Uri
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.PopupMenu
import com.chaquo.python.Python
import java.io.File
import java.util.concurrent.Executors

/**
 * One screen: the web frontend in a WebView, talking to the backend that runs inside this app on a loopback port.
 * A long press on the top bar (or the overflow menu on devices with a menu key) opens the vault file actions.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var splash: View
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private val executor = Executors.newSingleThreadExecutor()
    private var port: Int = 0

    private val vaultDir: File get() = File(filesDir, "data")
    private val vaultFile: File get() = File(vaultDir, "portfolio.enc")
    private val frontendDir: File get() = File(filesDir, "frontend")

    private val openVault = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { confirmReplace(it) } }
    private val saveVault = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri -> uri?.let { copyOut(it) } }
    // <input type="file"> in the page (the CAS statement PDF): the WebView asks the activity, which opens the system picker
    private var fileChooser: ValueCallback<Array<Uri>>? = null
    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        fileChooser?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        fileChooser = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        splash = findViewById(R.id.splash)
        status = findViewById(R.id.status)
        progress = findViewById(R.id.progress)
        setUpWebView()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })
        web.setOnLongClickListener { showMenu(it); true }
        startBackend()
    }

    private fun setUpWebView() {
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true           // the frontend keeps theme, tabs and collapsed groups in localStorage
            allowFileAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        web.addJavascriptInterface(Bridge(), "AndroidApp") // the page calls AndroidApp.print() from its Print button
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileChooser?.onReceiveValue(null)
                fileChooser = callback
                val types = params.acceptTypes.filter { it.isNotBlank() }.map { if (it.startsWith(".")) (if (it.equals(".pdf", true)) "application/pdf" else "*/*") else it }
                pickFile.launch((if (types.isEmpty()) listOf("*/*") else types).toTypedArray())
                return true
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == "127.0.0.1" || url.host == "localhost") return false
                // Links to Google Finance and the like open in the browser
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                return true
            }
        }
    }

    /** Unpack the frontend when the app version changed, start the backend, then show the page. */
    private fun startBackend() {
        splash.visibility = View.VISIBLE
        web.visibility = View.INVISIBLE
        executor.execute {
            try {
                unpackFrontend()
                val py = Python.getInstance().getModule("android_main")
                port = py.callAttr("start", vaultDir.absolutePath, frontendDir.absolutePath).toInt()
                runOnUiThread {
                    web.loadUrl("http://127.0.0.1:$port/")
                    web.visibility = View.VISIBLE
                    splash.visibility = View.GONE
                }
            } catch (e: Exception) {
                runOnUiThread {
                    progress.visibility = View.GONE
                    status.text = getString(R.string.start_failed, e.toString())
                }
            }
        }
    }

    private fun unpackFrontend() {
        val stamp = File(frontendDir, ".version")
        // the install time is part of the stamp, so reinstalling the same version (a rebuild during development) refreshes the pages too
        val installed = try { packageManager.getPackageInfo(packageName, 0).lastUpdateTime } catch (e: Exception) { 0L }
        val wanted = BuildConfig.VERSION_NAME + "/" + BuildConfig.VERSION_CODE + "/" + installed
        if (stamp.exists() && stamp.readText() == wanted) return
        frontendDir.deleteRecursively()
        copyAssetDir("frontend", frontendDir)
        stamp.writeText(wanted)
    }

    private fun copyAssetDir(assetPath: String, target: File) {
        val entries = assets.list(assetPath) ?: return
        target.mkdirs()
        for (name in entries) {
            val childAsset = "$assetPath/$name"
            val childFile = File(target, name)
            val grandChildren = assets.list(childAsset)
            if (grandChildren != null && grandChildren.isNotEmpty()) {
                copyAssetDir(childAsset, childFile)
            } else {
                assets.open(childAsset).use { input -> childFile.outputStream().use { input.copyTo(it) } }
            }
        }
    }

    // ---- vault file actions ---------------------------------------------------------------------------------------

    override fun onResume() {
        super.onResume()
        runCatching { SignInService.stop(this) }  // back in front: the backend no longer needs the keep-alive
    }

    /** What the page may ask of the app. `print()` hands the current page (the report) to Android's print dialog,
     *  where a printer or Save as PDF can be chosen; the page's print stylesheet applies. */
    inner class Bridge {
        @JavascriptInterface
        fun print() {
            runOnUiThread {
                val manager = getSystemService(Context.PRINT_SERVICE) as PrintManager
                val name = getString(R.string.app_name)
                manager.print(name, web.createPrintDocumentAdapter(name), PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build())
            }
        }

        /** Open a web address in the phone's browser: the cloud providers' sign-in pages, which must not run inside
         *  the WebView (Google refuses embedded sign-ins) and which send the browser back to the app's own address. */
        @JavascriptInterface
        fun openUrl(url: String) {
            if (!url.startsWith("https://")) return
            runOnUiThread {
                // Android freezes a backgrounded app within seconds; the sign-in comes back to the app's own address,
                // so the backend must stay up until then (SignInService stops in onResume).
                runCatching { SignInService.start(this@MainActivity) }
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            }
        }

        /** Can this device ask for a fingerprint or its screen lock at all? */
        @JavascriptInterface
        fun biometricAvailable(): Boolean = bioAvailable()

        /** Is a password kept for fingerprint unlock? */
        @JavascriptInterface
        fun biometricEnabled(): Boolean = bioEnabled()

        /** Keep this password for fingerprint unlock, after one fingerprint or screen-lock confirmation. */
        @JavascriptInterface
        fun enableBiometric(password: String) = bioEnable(password)

        /** Ask for a fingerprint or the screen lock, then unlock the vault with the kept password. */
        @JavascriptInterface
        fun biometricUnlock() = bioUnlock()

        /** Forget the kept password. */
        @JavascriptInterface
        fun disableBiometric() { bioForget(); tellPage("disabled") }
    }

    // ---- fingerprint / screen-lock unlock. The vault password is kept encrypted with an AES key that lives in the
    // Android Keystore and can only be used right after a fingerprint or the device's PIN / pattern / password
    // (BiometricPrompt with a CryptoObject). New fingerprints or a removed screen lock invalidate the key, so the
    // password has to be typed once more and the feature turned on again. The vault file itself stays encrypted
    // with the password as before.
    private val authPrefs by lazy { getSharedPreferences("auth", MODE_PRIVATE) }
    private val keyAlias = "vault-password"
    private val authenticators = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
        BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
    else BiometricManager.Authenticators.BIOMETRIC_STRONG

    private fun bioAvailable(): Boolean = BiometricManager.from(this).canAuthenticate(authenticators) == BiometricManager.BIOMETRIC_SUCCESS
    private fun bioEnabled(): Boolean = authPrefs.contains("bio_ct")

    private fun secretKey(create: Boolean): SecretKey? {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val spec = KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
        } else {
            @Suppress("DEPRECATION")
            spec.setUserAuthenticationValidityDurationSeconds(-1)
        }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec.build()) }.generateKey()
    }

    private fun bioForget() {
        authPrefs.edit().remove("bio_iv").remove("bio_ct").apply()
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(keyAlias) }
    }

    /** window.onBiometric(kind, detail) in the page: enabled, disabled, unlocked, cancelled, stale, invalidated, failed. */
    private fun tellPage(kind: String, detail: String = "") {
        runOnUiThread { web.evaluateJavascript("window.onBiometric && window.onBiometric(${JSONObject.quote(kind)}, ${JSONObject.quote(detail)})", null) }
    }

    private fun prompt(title: String, subtitle: String, cipher: Cipher, onDone: (Cipher) -> Unit) {
        val info = BiometricPrompt.PromptInfo.Builder().setTitle(title).setSubtitle(subtitle).setAllowedAuthenticators(authenticators)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) info.setNegativeButtonText(getString(R.string.cancel))
        BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val c = result.cryptoObject?.cipher
                if (c == null) tellPage("failed", "no cipher") else try { onDone(c) } catch (e: Exception) { bioForget(); tellPage("failed", e.toString()) }
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) { tellPage("cancelled", errString.toString()) }
        }).authenticate(info.build(), BiometricPrompt.CryptoObject(cipher))
    }

    private fun bioEnable(password: String) {
        runOnUiThread {
            try {
                val key = secretKey(create = true) ?: throw IllegalStateException("no key")
                val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
                prompt(getString(R.string.bio_enable_title), getString(R.string.bio_enable_sub), cipher) { c ->
                    val ct = c.doFinal(password.toByteArray(Charsets.UTF_8))
                    authPrefs.edit()
                        .putString("bio_iv", Base64.encodeToString(c.iv, Base64.NO_WRAP))
                        .putString("bio_ct", Base64.encodeToString(ct, Base64.NO_WRAP))
                        .apply()
                    tellPage("enabled")
                }
            } catch (e: Exception) {
                bioForget()
                tellPage("failed", e.toString())
            }
        }
    }

    private fun bioUnlock() {
        runOnUiThread {
            val iv = authPrefs.getString("bio_iv", null)
            val ct = authPrefs.getString("bio_ct", null)
            if (iv == null || ct == null) { tellPage("disabled"); return@runOnUiThread }
            try {
                val key = secretKey(create = false) ?: throw KeyPermanentlyInvalidatedException()
                val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP))) }
                prompt(getString(R.string.bio_unlock_title), getString(R.string.bio_unlock_sub), cipher) { c ->
                    val password = String(c.doFinal(Base64.decode(ct, Base64.NO_WRAP)), Charsets.UTF_8)
                    executor.execute {
                        when (val status = postUnlock(password)) {
                            200 -> tellPage("unlocked")
                            401, 409 -> { bioForget(); tellPage("stale") }
                            else -> tellPage("failed", "the app answered $status")
                        }
                    }
                }
            } catch (e: KeyPermanentlyInvalidatedException) {
                bioForget()
                tellPage("invalidated")
            } catch (e: Exception) {
                bioForget()
                tellPage("failed", e.toString())
            }
        }
    }

    /** POST the password to the backend inside this app; the page never sees it. */
    private fun postUnlock(password: String): Int {
        val conn = URL("http://127.0.0.1:$port/api/auth/unlock").openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.connectTimeout = 10_000
            conn.readTimeout = 120_000
            conn.doOutput = true
            conn.outputStream.use { it.write(JSONObject().put("password", password).toString().toByteArray(Charsets.UTF_8)) }
            conn.responseCode
        } catch (e: Exception) {
            -1
        } finally {
            conn.disconnect()
        }
    }

    private fun showMenu(anchor: View) {
        val menu = PopupMenu(this, anchor)
        menu.menuInflater.inflate(R.menu.main, menu.menu)
        menu.setOnMenuItemClickListener { onOptionsItemSelected(it) }
        menu.show()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.action_open -> openVault.launch(arrayOf("*/*"))
            R.id.action_save -> {
                if (!vaultFile.exists()) toast(getString(R.string.vault_none)) else saveVault.launch("portfolio.enc")
            }
            R.id.action_reload -> web.reload()
            R.id.action_about -> AlertDialog.Builder(this)
                .setTitle(R.string.app_name)
                .setMessage(getString(R.string.about_body, BuildConfig.VERSION_NAME))
                .setPositiveButton(android.R.string.ok, null)
                .show()
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    private fun confirmReplace(uri: Uri) {
        if (!vaultFile.exists()) { copyIn(uri); return }
        AlertDialog.Builder(this)
            .setTitle(R.string.vault_replace_title)
            .setMessage(R.string.vault_replace_body)
            .setPositiveButton(R.string.replace) { _, _ -> copyIn(uri) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** Replace the phone's vault with the picked file: lock first so the old key is forgotten, then reload. */
    private fun copyIn(uri: Uri) {
        executor.execute {
            try {
                Python.getInstance().getModule("android_main").callAttr("lock")
                vaultDir.mkdirs()
                val tmp = File(vaultDir, "portfolio.enc.incoming")
                contentResolver.openInputStream(uri)!!.use { input -> tmp.outputStream().use { input.copyTo(it) } }
                if (!tmp.renameTo(vaultFile)) { vaultFile.delete(); tmp.renameTo(vaultFile) }
                runOnUiThread { toast(getString(R.string.vault_opened)); web.loadUrl("http://127.0.0.1:$port/") }
            } catch (e: Exception) {
                runOnUiThread { toast(e.toString()) }
            }
        }
    }

    /** Write the phone's vault (the file on disk, which is saved after every change) to the picked location. */
    private fun copyOut(uri: Uri) {
        executor.execute {
            try {
                contentResolver.openOutputStream(uri, "wt")!!.use { output -> vaultFile.inputStream().use { it.copyTo(output) } }
                runOnUiThread { toast(getString(R.string.vault_saved)) }
            } catch (e: Exception) {
                runOnUiThread { toast(e.toString()) }
            }
        }
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()
}

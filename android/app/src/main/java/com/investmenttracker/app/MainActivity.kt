package com.investmenttracker.app

import android.app.AlertDialog
import android.content.Intent
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
        val wanted = BuildConfig.VERSION_NAME + "/" + BuildConfig.VERSION_CODE
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

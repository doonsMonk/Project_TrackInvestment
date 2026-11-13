import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

// The app's version follows the backend's VERSION constant, so the phone and the PC can be compared.
val backendVersion: String = file("../../backend/main.py").readLines()
    .firstOrNull { it.startsWith("VERSION = ") }?.substringAfter("\"")?.substringBefore("\"") ?: "0.0.0"
val versionParts = backendVersion.split(".").map { it.toIntOrNull() ?: 0 } + listOf(0, 0, 0)

android {
    namespace = "com.investmenttracker.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.doonsmonk.investmenttracker"
        minSdk = 24
        targetSdk = 35
        versionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]
        versionName = backendVersion
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }  // phones, and the x86_64 emulator
    }

    // The release key lives outside git: android/keystore.properties names the keystore file and its passwords.
    // With it, both build types are signed with that one key, so a debug build (WebView debugging on, for device
    // tests) and a release build (what is published) install over each other. Without it, the debug key is used.
    val keystoreProps = Properties().apply {
        val f = rootProject.file("keystore.properties")
        if (f.exists()) f.inputStream().use { load(it) }
    }
    val hasReleaseKey = keystoreProps.getProperty("storeFile") != null
    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (hasReleaseKey) "release" else "debug")
        }
        debug {
            if (hasReleaseKey) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }  // BuildConfig.VERSION_NAME / VERSION_CODE are used to version the unpacked frontend
    sourceSets.getByName("main") {
        assets.srcDir(layout.buildDirectory.dir("generated/frontend-assets"))
    }
}

// The backend package and the frontend are copied from the repository at build time, so the Android app always
// ships the same code as the PC app.
val syncBackend by tasks.registering(Sync::class) {
    from("../../backend") { exclude("__pycache__/**", "*.pyc") }
    into(layout.buildDirectory.dir("python-src/backend"))
}
val syncFrontend by tasks.registering(Sync::class) {
    from("../../frontend")
    into(layout.buildDirectory.dir("generated/frontend-assets/frontend"))
}
// Every Chaquopy task that reads the Python sources, and every Android task that reads the assets, must run after
// the copies (Gradle refuses an undeclared producer / consumer relationship).
tasks.configureEach {
    if (name != "syncBackend" && name.contains("Python")) dependsOn(syncBackend)
    if (name != "syncFrontend" && name.contains("Assets")) dependsOn(syncFrontend)
    if (name == "preBuild") dependsOn(syncBackend, syncFrontend)
}

chaquopy {
    defaultConfig {
        version = "3.13"   // cryptography has Android builds for 3.13; the PC runs 3.14 but the code is the same
        buildPython("py", "-3.13")  // Chaquopy needs the same minor version at build time (winget: Python.Python.3.13)
        pip {
            // FastAPI 0.115 is the last line that runs on pydantic v1, the pure-Python one: pydantic v2 needs
            // pydantic-core, a compiled library with no Android build. backend/compat.py makes the models run on both.
            install("fastapi==0.115.14")
            install("pydantic==1.10.22")
            install("uvicorn==0.34.3")
            install("cryptography==42.0.8")
            install("certifi")
            install("pdfminer.six==20260107")  // CAS statement PDFs; pure Python
        }
        pyc { src = false }
    }
    sourceSets.getByName("main") {
        srcDir(layout.buildDirectory.dir("python-src"))
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("com.google.android.material:material:1.12.0")
}

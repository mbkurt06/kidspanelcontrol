plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Sürüm numarası GitHub derlemesinden gelir (her derleme bir artar)
val orbitVersionCode: Int = (System.getenv("ORBIT_VERSION_CODE") ?: "1").toInt()
val keystoreFile: File? = System.getenv("ORBIT_KEYSTORE")?.let { file(it) }?.takeIf { it.exists() }

android {
    namespace = "app.orbit"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.orbit"
        minSdk = 28
        targetSdk = 35
        versionCode = orbitVersionCode
        versionName = "0.1.$orbitVersionCode"
        buildConfigField("String", "SUPABASE_URL", "\"https://pwxbrkbljcknstjbccwu.supabase.co\"")
        buildConfigField("String", "SUPABASE_KEY", "\"sb_publishable_R99I09PlEL6wy3tmgh70nw_ULFc9uzI\"")
        buildConfigField("String", "UPDATE_REPO", "\"mbkurt06/kidspanelcontrol\"")
    }

    signingConfigs {
        create("release") {
            if (keystoreFile != null) {
                storeFile = keystoreFile
                storePassword = System.getenv("ORBIT_SIGNING_PASSWORD")
                keyAlias = "orbit"
                keyPassword = System.getenv("ORBIT_SIGNING_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystoreFile != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-service:2.8.7")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-session:1.4.1")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    val camerax = "1.4.1"
    implementation("androidx.camera:camera-core:$camerax")
    implementation("androidx.camera:camera-camera2:$camerax")
    implementation("androidx.camera:camera-lifecycle:$camerax")
    implementation("androidx.camera:camera-video:$camerax")
    implementation("androidx.camera:camera-view:$camerax")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

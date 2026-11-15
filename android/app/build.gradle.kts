plugins {
    id("com.android.application")
}

android {
    namespace = "cloud.neoix.yuchao"
    compileSdk = 34

    defaultConfig {
        applicationId = "cloud.neoix.yuchao"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "1.2.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

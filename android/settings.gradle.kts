pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Gecko (Firefox) tarayıcı motoru: Orbit içi web sayfaları ve YouTube
        maven { url = uri("https://maven.mozilla.org/maven2/") }
    }
}
rootProject.name = "orbit"
include(":app")

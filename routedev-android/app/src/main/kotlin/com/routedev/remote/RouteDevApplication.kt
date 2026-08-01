package com.routedev.remote

import android.app.Application
import com.routedev.remote.data.local.RouteDevDatabase
import com.routedev.remote.data.remote.RouteDevApi
import com.routedev.remote.data.remote.SseClient
import com.routedev.remote.data.repository.SessionRepository
import com.routedev.remote.notification.NotificationCoordinator
import com.routedev.remote.security.DeviceCredentialStore
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient

class RouteDevApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.notifications.createChannels()
    }
}

class AppContainer(application: Application) {
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }
    val credentials = DeviceCredentialStore(application)
    val database = RouteDevDatabase.create(application)
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    val api = RouteDevApi(http, json)
    val repository = SessionRepository(database, api, SseClient(http, json), credentials::load, json)
    val notifications = NotificationCoordinator(application)
}

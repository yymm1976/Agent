package com.routedev.remote.service

import android.app.Service
import android.content.Intent
import android.os.IBinder
import com.routedev.remote.RouteDevApplication
import com.routedev.remote.notification.NotificationCoordinator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class TaskConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var connection: Job? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as RouteDevApplication
        val credentials = app.container.credentials.load()
        if (credentials == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(
            NotificationCoordinator.FOREGROUND_ID,
            app.container.notifications.connectionNotification(credentials.desktopName),
        )
        connection?.cancel()
        connection = scope.launch {
            val sessionJobs = mutableMapOf<String, Job>()
            try {
                app.container.repository.refreshSessions()
                app.container.repository.observeSessions().collect { sessions ->
                    val activeIds = sessions
                        .filter { it.status == "running" || it.status == "waiting_approval" }
                        .mapTo(mutableSetOf()) { it.sessionId }
                    (sessionJobs.keys - activeIds).forEach { id -> sessionJobs.remove(id)?.cancel() }
                    (activeIds - sessionJobs.keys).forEach { id ->
                        sessionJobs[id] = scope.launch {
                            try {
                                app.container.repository.liveEvents(id).collect(app.container.notifications::notify)
                            } catch (revoked: com.routedev.remote.domain.RemoteApiException) {
                                if (revoked.code == "AUTH_REVOKED") {
                                    app.container.credentials.clear()
                                    stopSelf()
                                }
                            }
                        }
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                delay(15_000)
                stopSelf()
            } finally {
                sessionJobs.values.forEach(Job::cancel)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}

package com.routedev.remote.notification

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.routedev.remote.MainActivity
import com.routedev.remote.R
import com.routedev.remote.domain.WireEvent

class NotificationCoordinator(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    fun createChannels() {
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(
                    CONNECTION_CHANNEL,
                    context.getString(R.string.notification_channel_connection),
                    NotificationManager.IMPORTANCE_LOW,
                ),
                NotificationChannel(
                    RESULT_CHANNEL,
                    context.getString(R.string.notification_channel_result),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ),
            ),
        )
    }

    fun connectionNotification(desktopName: String): Notification =
        NotificationCompat.Builder(context, CONNECTION_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("任务通知连接已开启")
            .setContentText("正在连接 $desktopName；电脑离线时会自动重试")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp(null))
            .build()

    fun notify(event: WireEvent) {
        if (ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return
        val title = when (event.type) {
            "task.completed" -> "RouteDev 任务已完成"
            "task.failed" -> "RouteDev 任务失败"
            "approval.required" -> "RouteDev 等待你的授权"
            else -> return
        }
        manager.notify(
            event.eventId.hashCode(),
            NotificationCompat.Builder(context, RESULT_CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_more)
                .setContentTitle(title)
                .setContentText("点按查看对话进度")
                .setAutoCancel(true)
                .setContentIntent(openApp(event.sessionId))
                .build(),
        )
    }

    private fun openApp(sessionId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_SESSION_ID, sessionId)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(
            context,
            sessionId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        const val CONNECTION_CHANNEL = "task_connection"
        const val RESULT_CHANNEL = "task_results"
        const val FOREGROUND_ID = 41017
    }
}

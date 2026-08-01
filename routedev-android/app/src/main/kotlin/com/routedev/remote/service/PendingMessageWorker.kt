package com.routedev.remote.service

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.routedev.remote.RouteDevApplication
import java.util.concurrent.TimeUnit

class PendingMessageWorker(
    context: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result =
        runCatching {
            (applicationContext as RouteDevApplication).container.repository.retryPending()
        }.fold(
            onSuccess = { Result.success() },
            onFailure = { Result.retry() },
        )

    companion object {
        private const val UNIQUE_WORK = "pending-routedev-messages"

        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<PendingMessageWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                UNIQUE_WORK,
                ExistingWorkPolicy.KEEP,
                request,
            )
        }
    }
}

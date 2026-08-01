package com.routedev.remote.data.remote

import com.routedev.remote.domain.DeviceCredentials
import com.routedev.remote.domain.RemoteApiException
import com.routedev.remote.domain.WireEvent
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

class SseClient(
    client: OkHttpClient,
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    private val factory = EventSources.createFactory(
        client.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build(),
    )

    fun events(
        credentials: DeviceCredentials,
        sessionId: String,
        lastEventId: String?,
    ): Flow<WireEvent> = callbackFlow {
        val request = Request.Builder()
            .url("${credentials.baseUrl.trimEnd('/')}/v1/events?sessionId=$sessionId")
            .header("Authorization", "Bearer ${credentials.token}")
            .header("Accept", "text/event-stream")
            .apply { if (lastEventId != null) header("Last-Event-ID", lastEventId) }
            .build()
        val source = factory.newEventSource(request, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                runCatching { json.decodeFromString(WireEvent.serializer(), data) }
                    .onSuccess { trySend(it) }
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                close(
                    if (response?.code == 401) {
                        RemoteApiException("AUTH_REVOKED", "设备配对已被电脑端撤销", false)
                    } else {
                        t ?: IllegalStateException("SSE disconnected: ${response?.code}")
                    },
                )
            }
        })
        awaitClose { source.cancel() }
    }
}

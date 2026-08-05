package com.routedev.remote.data.repository

import androidx.room.withTransaction
import com.routedev.remote.data.local.PendingMessageEntity
import com.routedev.remote.data.local.RouteDevDatabase
import com.routedev.remote.data.local.SessionEntity
import com.routedev.remote.data.local.TimelineEventEntity
import com.routedev.remote.data.remote.RouteDevApi
import com.routedev.remote.data.remote.SseClient
import com.routedev.remote.domain.DeviceCredentials
import com.routedev.remote.domain.IngestResult
import com.routedev.remote.domain.RemoteMcpServer
import com.routedev.remote.domain.RemoteSkill
import com.routedev.remote.domain.RemoteTool
import com.routedev.remote.domain.SessionDetail
import com.routedev.remote.domain.SessionSummary
import com.routedev.remote.domain.WireEvent
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class SessionRepository(
    private val database: RouteDevDatabase,
    private val api: RouteDevApi,
    private val sse: SseClient,
    private val credentials: () -> DeviceCredentials?,
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    private val dao = database.routeDevDao()

    fun observeSessions(): Flow<List<SessionEntity>> = dao.observeSessions()
    fun observeSession(sessionId: String): Flow<SessionEntity?> = dao.observeSession(sessionId)
    fun observeTimeline(sessionId: String): Flow<List<TimelineEventEntity>> = dao.observeTimeline(sessionId)

    suspend fun refreshSessions() {
        val auth = requireCredentials()
        // The server summary sequence is not the local ingestion cursor. Preserve
        // the cursor and last event id so the next timeline refresh still fetches
        // events that are missing from this device.
        for (summary in api.sessions(auth)) {
            dao.upsertSession(toEntity(summary, dao.session(summary.sessionId)))
        }
        dao.trimTimeline()
    }

    suspend fun createSession(title: String?): String {
        val result = api.createSession(requireCredentials(), title)
        dao.upsertSession(toEntity(result.session, dao.session(result.session.sessionId)))
        return result.session.sessionId
    }

    suspend fun refreshTimeline(sessionId: String) {
        val auth = requireCredentials()
        val current = dao.session(sessionId)
        val result = api.timeline(auth, sessionId, current?.lastSequence ?: 0)
        for (event in result.events.sortedBy { it.sequence }) {
            when (val ingested = ingest(event)) {
                is IngestResult.Gap -> {
                    val recovered = api.timeline(auth, sessionId, ingested.expected - 1)
                    recovered.events.sortedBy { it.sequence }.forEach { ingest(it) }
                    return
                }
                else -> Unit
            }
        }
    }

    fun liveEvents(sessionId: String): Flow<WireEvent> = flow {
        var backoff = 1_000L
        while (true) {
            val auth = requireCredentials()
            val cursor = dao.session(sessionId)?.lastEventId
            try {
                sse.events(auth, sessionId, cursor).collect { event ->
                    if (ingest(event) is IngestResult.Gap) refreshTimeline(sessionId)
                    emit(event)
                    backoff = 1_000L
                }
            } catch (error: Exception) {
                if (error is com.routedev.remote.domain.RemoteApiException && error.code == "AUTH_REVOKED") {
                    throw error
                }
                delay(backoff)
                backoff = (backoff * 2).coerceAtMost(30_000L)
            }
        }
    }

    suspend fun send(
        sessionId: String,
        text: String,
        skillIds: List<String>,
        mcpIds: List<String>,
        toolNames: List<String>,
    ) {
        val clientId = UUID.randomUUID().toString()
        val pending = PendingMessageEntity(
            clientId,
            sessionId,
            text,
            json.encodeToString(ListSerializer(String.serializer()), skillIds),
            json.encodeToString(ListSerializer(String.serializer()), mcpIds),
            json.encodeToString(ListSerializer(String.serializer()), toolNames),
            System.currentTimeMillis(),
            0,
        )
        dao.enqueue(pending)
        api.sendMessage(requireCredentials(), sessionId, text, clientId, skillIds, mcpIds, toolNames)
        dao.deletePending(pending)
    }

    suspend fun retryPending() {
        val auth = requireCredentials()
        dao.pendingMessages().forEach { message ->
            api.sendMessage(
                auth,
                message.sessionId,
                message.text,
                message.clientMessageId,
                json.decodeFromString(ListSerializer(String.serializer()), message.skillIdsJson),
                json.decodeFromString(ListSerializer(String.serializer()), message.mcpServerIdsJson),
                json.decodeFromString(ListSerializer(String.serializer()), message.toolNamesJson),
            )
            dao.deletePending(message)
        }
    }

    suspend fun stop(sessionId: String, turnId: String?) =
        api.stop(requireCredentials(), sessionId, turnId)

    suspend fun resolveApproval(approvalId: String, approved: Boolean) =
        api.resolveApproval(requireCredentials(), approvalId, approved)

    suspend fun capabilities(): Triple<List<RemoteSkill>, List<RemoteMcpServer>, List<RemoteTool>> {
        val auth = requireCredentials()
        return Triple(api.skills(auth), api.mcpServers(auth), api.tools(auth))
    }

    suspend fun ingest(event: WireEvent): IngestResult = database.withTransaction {
        val session = dao.session(event.sessionId)
        if (event.sequence <= (session?.lastSequence ?: 0)) return@withTransaction IngestResult.Duplicate
        val expected = (session?.lastSequence ?: 0) + 1
        if (event.sequence != expected) return@withTransaction IngestResult.Gap(expected, event.sequence)
        val inserted = dao.insertEvent(
            TimelineEventEntity(
                event.sessionId,
                event.sequence,
                event.eventId,
                event.turnId,
                event.timestamp,
                event.type,
                event.payload.toString(),
            ),
        )
        if (inserted == -1L) return@withTransaction IngestResult.Duplicate
        val projection = projectStatus(session, event)
        if (session == null) {
            dao.upsertSession(
                SessionEntity(
                    event.sessionId,
                    "新对话",
                    projection.first,
                    event.timestamp,
                    event.timestamp,
                    projection.second,
                    event.sequence,
                    event.eventId,
                    null,
                ),
            )
        } else {
            dao.advanceSession(
                event.sessionId,
                event.sequence,
                event.eventId,
                event.timestamp,
                projection.first,
                projection.second,
            )
        }
        IngestResult.Inserted
    }

    suspend fun clearLocalData() = database.withTransaction {
        dao.clearEvents()
        dao.clearPending()
        dao.clearSessions()
    }

    private fun projectStatus(session: SessionEntity?, event: WireEvent): Pair<String, String?> =
        when (event.type) {
            "turn.started" -> "running" to event.turnId
            "approval.required" -> "waiting_approval" to event.turnId
            "approval.resolved" -> "running" to event.turnId
            "turn.completed", "task.completed" -> "completed" to null
            "turn.failed", "task.failed" -> "failed" to null
            else -> (session?.status ?: "idle") to session?.activeTurnId
        }

    private fun requireCredentials(): DeviceCredentials =
        credentials() ?: error("尚未配对电脑")

    private fun toEntity(session: SessionSummary, local: SessionEntity? = null) = SessionEntity(
        session.sessionId,
        session.title,
        session.status,
        session.createdAt,
        session.updatedAt,
        session.activeTurnId,
        local?.lastSequence ?: 0,
        local?.lastEventId,
        local?.latestResult,
    )

    private fun toEntity(session: SessionDetail, local: SessionEntity? = null) = SessionEntity(
        session.sessionId,
        session.title,
        session.status,
        session.createdAt,
        session.updatedAt,
        session.activeTurnId,
        local?.lastSequence ?: 0,
        local?.lastEventId,
        session.latestResult,
    )
}

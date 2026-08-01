package com.routedev.remote.domain

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class PairingOffer(
    val baseUrl: String,
    val pairingId: String,
    val secret: String,
    val protocolVersion: Int,
    val desktopName: String,
    val transport: String = "https",
)

@Serializable
data class PairResult(
    val deviceId: String,
    val deviceToken: String,
    val grantedScopes: List<String>,
    val desktopName: String,
    val baseUrl: String,
)

@Serializable
data class SessionSummary(
    val sessionId: String,
    val title: String,
    val status: String,
    val createdAt: String,
    val updatedAt: String,
    val activeTurnId: String? = null,
    val lastSequence: Long,
)

@Serializable
data class SessionDetail(
    val sessionId: String,
    val title: String,
    val status: String,
    val createdAt: String,
    val updatedAt: String,
    val activeTurnId: String? = null,
    val lastSequence: Long,
    val projectId: String? = null,
    val projectName: String? = null,
    val latestResult: String? = null,
)

@Serializable
data class CreateSessionResult(
    val session: SessionDetail,
    val clientSessionId: String,
)

@Serializable
data class SendMessageResult(
    val sessionId: String,
    val turnId: String,
    val clientMessageId: String,
    val acceptedAt: String,
    val duplicate: Boolean,
)

@Serializable
data class RemoteSkill(
    val id: String,
    val name: String,
    val description: String,
    val source: String,
    val enabled: Boolean,
)

@Serializable
data class RemoteMcpServer(
    val id: String,
    val name: String,
    val connected: Boolean,
    val toolCount: Int,
)

@Serializable
data class RemoteTool(
    val name: String,
    val description: String,
    val source: String,
    val mcpServerId: String? = null,
    val allowed: Boolean,
)

@Serializable
data class TimelineResult(
    val events: List<WireEvent>,
    val nextSequence: Long,
)

@Serializable
data class WireEvent(
    val protocolVersion: Int,
    val eventId: String,
    val timestamp: String,
    val sessionId: String,
    val turnId: String? = null,
    val sequence: Long,
    val type: String,
    val payload: JsonObject,
)

data class DeviceCredentials(
    val baseUrl: String,
    val deviceId: String,
    val desktopName: String,
    val token: String,
    val scopes: Set<String>,
)

sealed interface IngestResult {
    data object Inserted : IngestResult
    data object Duplicate : IngestResult
    data class Gap(val expected: Long, val actual: Long) : IngestResult
}

class RemoteApiException(
    val code: String,
    override val message: String,
    val retryable: Boolean,
) : Exception(message)

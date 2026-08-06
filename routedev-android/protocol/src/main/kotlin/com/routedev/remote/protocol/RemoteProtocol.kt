package com.routedev.remote.protocol

import java.time.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

const val REMOTE_PROTOCOL_VERSION: Int = 1

@Serializable
enum class RemoteErrorCode {
    AUTH_REQUIRED,
    AUTH_REVOKED,
    PAIRING_EXPIRED,
    PAIRING_INVALID,
    SCOPE_DENIED,
    SESSION_NOT_FOUND,
    SESSION_BUSY,
    SKILL_NOT_AVAILABLE,
    MCP_NOT_AVAILABLE,
    TOOL_NOT_ALLOWED,
    APPROVAL_EXPIRED,
    CONFLICT,
    RATE_LIMITED,
    ENGINE_UNAVAILABLE,
    PROTOCOL_MISMATCH,
}

@Serializable
enum class RemoteDeviceScope {
    @SerialName("sessions:read") SESSIONS_READ,
    @SerialName("messages:send") MESSAGES_SEND,
    @SerialName("tasks:stop") TASKS_STOP,
    @SerialName("approvals:resolve") APPROVALS_RESOLVE,
    @SerialName("skills:select") SKILLS_SELECT,
    @SerialName("mcp:select") MCP_SELECT,
    @SerialName("autonomy:change") AUTONOMY_CHANGE,
}

@Serializable
enum class RemoteEventType {
    @SerialName("session.created") SESSION_CREATED,
    @SerialName("session.updated") SESSION_UPDATED,
    @SerialName("turn.queued") TURN_QUEUED,
    @SerialName("turn.started") TURN_STARTED,
    @SerialName("assistant.text.delta") ASSISTANT_TEXT_DELTA,
    @SerialName("assistant.reasoning.delta") ASSISTANT_REASONING_DELTA,
    @SerialName("assistant.progress") ASSISTANT_PROGRESS,
    @SerialName("tool.started") TOOL_STARTED,
    @SerialName("tool.output.delta") TOOL_OUTPUT_DELTA,
    @SerialName("tool.completed") TOOL_COMPLETED,
    @SerialName("tool.failed") TOOL_FAILED,
    @SerialName("todo.replaced") TODO_REPLACED,
    @SerialName("todo.updated") TODO_UPDATED,
    @SerialName("approval.required") APPROVAL_REQUIRED,
    @SerialName("approval.resolved") APPROVAL_RESOLVED,
    @SerialName("turn.completed") TURN_COMPLETED,
    @SerialName("turn.failed") TURN_FAILED,
    @SerialName("task.completed") TASK_COMPLETED,
    @SerialName("task.failed") TASK_FAILED,
    @SerialName("connection.notice") CONNECTION_NOTICE,
}

@Serializable
enum class RemoteAutonomyMode {
    @SerialName("auto") AUTO,
    @SerialName("semi") SEMI,
    @SerialName("manual") MANUAL,
}

@Serializable
data class RemoteError(
    val code: RemoteErrorCode,
    val message: String,
    val retryable: Boolean,
    val details: JsonObject? = null,
)

@Serializable
data class RemoteApiResponse(
    val protocolVersion: Int,
    val requestId: String,
    val timestamp: String,
    val sessionId: String?,
    val turnId: String?,
    val ok: Boolean,
    val payload: JsonElement?,
    val error: RemoteError?,
)

@Serializable
data class RemoteEventEnvelope(
    val protocolVersion: Int,
    val eventId: String,
    val timestamp: String,
    val sessionId: String,
    val turnId: String?,
    val sequence: Long,
    val type: RemoteEventType,
    val payload: JsonObject,
)

@Serializable
data class RemotePairRequest(
    val pairingId: String,
    val secret: String,
    val deviceId: String,
    val deviceName: String,
    val requestedScopes: List<RemoteDeviceScope>,
    val protocolVersion: Int,
)

@Serializable
data class RemoteCreateSessionRequest(
    val title: String? = null,
    val projectId: String? = null,
    val clientSessionId: String,
)

@Serializable
data class RemoteImageInput(
    val mediaType: String,
    val dataBase64: String,
    val filename: String? = null,
)

@Serializable
data class RemoteSendMessageRequest(
    val text: String,
    val images: List<RemoteImageInput>? = null,
    val skillIds: List<String>? = null,
    val mcpServerIds: List<String>? = null,
    val allowedToolNames: List<String>? = null,
    val autonomyMode: RemoteAutonomyMode? = null,
    val clientMessageId: String,
)

@Serializable
data class RemoteStopTaskRequest(
    val turnId: String? = null,
    val reason: String? = null,
)

@Serializable
data class RemoteApprovalResolveRequest(
    val approved: Boolean,
    val payload: JsonElement? = null,
)

object RemoteProtocolCodec {
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = true
        encodeDefaults = true
    }

    fun decodeEvent(text: String): RemoteEventEnvelope =
        json.decodeFromString<RemoteEventEnvelope>(text).also(::validateEvent)

    fun decodeResponse(text: String): RemoteApiResponse =
        json.decodeFromString<RemoteApiResponse>(text).also(::validateResponse)

    fun validateSequence(events: List<RemoteEventEnvelope>): List<String> {
        val errors = mutableListOf<String>()
        val eventIds = mutableSetOf<String>()
        var previous = 0L
        var sessionId: String? = null

        events.forEach { event ->
            if (!eventIds.add(event.eventId)) errors += "duplicate eventId: ${event.eventId}"
            if (sessionId == null) sessionId = event.sessionId
            if (sessionId != event.sessionId) errors += "mixed sessionId: ${event.sessionId}"
            if (event.sequence <= previous) {
                errors += "sequence must increase: $previous -> ${event.sequence}"
            }
            previous = event.sequence
        }
        return errors
    }

    private fun validateEvent(event: RemoteEventEnvelope) {
        require(event.protocolVersion == REMOTE_PROTOCOL_VERSION) { "protocol mismatch" }
        require(event.eventId.isNotBlank()) { "eventId is required" }
        require(event.sessionId.isNotBlank()) { "sessionId is required" }
        require(event.sequence > 0) { "sequence must be positive" }
        Instant.parse(event.timestamp)
    }

    private fun validateResponse(response: RemoteApiResponse) {
        require(response.protocolVersion == REMOTE_PROTOCOL_VERSION) { "protocol mismatch" }
        require(response.requestId.isNotBlank()) { "requestId is required" }
        require(response.ok == (response.error == null)) { "ok/error fields conflict" }
        Instant.parse(response.timestamp)
    }
}

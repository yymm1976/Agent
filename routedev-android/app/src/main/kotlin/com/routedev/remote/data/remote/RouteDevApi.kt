package com.routedev.remote.data.remote

import com.routedev.remote.domain.CreateSessionResult
import com.routedev.remote.domain.DeviceCredentials
import com.routedev.remote.domain.PairResult
import com.routedev.remote.domain.PairingOffer
import com.routedev.remote.domain.RemoteApiException
import com.routedev.remote.domain.RemoteMcpServer
import com.routedev.remote.domain.RemoteSkill
import com.routedev.remote.domain.RemoteTool
import com.routedev.remote.domain.SendMessageResult
import com.routedev.remote.domain.SessionDetail
import com.routedev.remote.domain.SessionSummary
import com.routedev.remote.domain.TimelineResult
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class RouteDevApi(
    private val client: OkHttpClient,
    private val json: Json = Json { ignoreUnknownKeys = true; explicitNulls = false },
) {
    suspend fun pair(offer: PairingOffer, deviceId: String, deviceName: String): PairResult =
        request(
            offer.baseUrl,
            "/v1/pair",
            "POST",
            null,
            PairRequest(
                offer.pairingId,
                offer.secret,
                deviceId,
                deviceName,
                DEFAULT_SCOPES,
                offer.protocolVersion,
            ),
            PairResult.serializer(),
        )

    suspend fun sessions(credentials: DeviceCredentials): List<SessionSummary> =
        request(credentials.baseUrl, "/v1/sessions", token = credentials.token, serializer = ListSerializer(SessionSummary.serializer()))

    suspend fun session(credentials: DeviceCredentials, sessionId: String): SessionDetail =
        request(credentials.baseUrl, "/v1/sessions/$sessionId", token = credentials.token, serializer = SessionDetail.serializer())

    suspend fun createSession(credentials: DeviceCredentials, title: String?): CreateSessionResult =
        request(
            credentials.baseUrl,
            "/v1/sessions",
            "POST",
            credentials.token,
            CreateSessionRequest(title, UUID.randomUUID().toString()),
            CreateSessionResult.serializer(),
        )

    suspend fun timeline(credentials: DeviceCredentials, sessionId: String, after: Long = 0): TimelineResult =
        request(
            credentials.baseUrl,
            "/v1/sessions/$sessionId/timeline?afterSequence=$after",
            token = credentials.token,
            serializer = TimelineResult.serializer(),
        )

    suspend fun sendMessage(
        credentials: DeviceCredentials,
        sessionId: String,
        text: String,
        clientMessageId: String,
        skillIds: List<String>,
        mcpServerIds: List<String>,
        toolNames: List<String>,
    ): SendMessageResult = request(
        credentials.baseUrl,
        "/v1/sessions/$sessionId/messages",
        "POST",
        credentials.token,
        SendMessageRequest(
            text,
            skillIds.takeIf(List<String>::isNotEmpty),
            mcpServerIds.takeIf(List<String>::isNotEmpty),
            toolNames.takeIf(List<String>::isNotEmpty),
            clientMessageId,
        ),
        SendMessageResult.serializer(),
    )

    suspend fun stop(credentials: DeviceCredentials, sessionId: String, turnId: String?) {
        request(
            credentials.baseUrl,
            "/v1/sessions/$sessionId/stop",
            "POST",
            credentials.token,
            StopRequest(turnId),
            JsonObject.serializer(),
        )
    }

    suspend fun resolveApproval(credentials: DeviceCredentials, approvalId: String, approved: Boolean) {
        request(
            credentials.baseUrl,
            "/v1/approvals/$approvalId/resolve",
            "POST",
            credentials.token,
            ApprovalRequest(approved),
            JsonObject.serializer(),
        )
    }

    suspend fun skills(credentials: DeviceCredentials): List<RemoteSkill> =
        request(credentials.baseUrl, "/v1/skills", token = credentials.token, serializer = ListSerializer(RemoteSkill.serializer()))

    suspend fun mcpServers(credentials: DeviceCredentials): List<RemoteMcpServer> =
        request(credentials.baseUrl, "/v1/mcp/servers", token = credentials.token, serializer = ListSerializer(RemoteMcpServer.serializer()))

    suspend fun tools(credentials: DeviceCredentials): List<RemoteTool> =
        request(credentials.baseUrl, "/v1/tools", token = credentials.token, serializer = ListSerializer(RemoteTool.serializer()))

    private suspend fun <T> request(
        baseUrl: String,
        path: String,
        method: String = "GET",
        token: String? = null,
        body: Any? = null,
        serializer: KSerializer<T>,
    ): T = withContext(Dispatchers.IO) {
        require(RemoteUrlPolicy.isSupported(baseUrl)) {
            "仅允许 HTTPS，或可信局域网中的私有 IPv4 地址"
        }
        val builder = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .header("Accept", "application/json")
            .header("X-Request-ID", UUID.randomUUID().toString())
        if (token != null) builder.header("Authorization", "Bearer $token")
        if (method != "GET") {
            val encoded = when (body) {
                is PairRequest -> json.encodeToString(PairRequest.serializer(), body)
                is CreateSessionRequest -> json.encodeToString(CreateSessionRequest.serializer(), body)
                is SendMessageRequest -> json.encodeToString(SendMessageRequest.serializer(), body)
                is StopRequest -> json.encodeToString(StopRequest.serializer(), body)
                is ApprovalRequest -> json.encodeToString(ApprovalRequest.serializer(), body)
                else -> "{}"
            }
            builder.method(method, encoded.toRequestBody(JSON))
        }
        client.newCall(builder.build()).execute().use { response ->
            val raw = response.body.string()
            if (response.code == 401) {
                throw RemoteApiException("AUTH_REVOKED", "设备配对已被电脑端撤销", false)
            }
            if (!response.isSuccessful) {
                throw RemoteApiException(
                    "ENGINE_UNAVAILABLE",
                    "电脑端暂时无法响应（HTTP ${response.code}）",
                    response.code >= 500,
                )
            }
            if (raw.isBlank()) {
                throw RemoteApiException("ENGINE_UNAVAILABLE", "电脑端返回了空响应", true)
            }
            val envelope = json.decodeFromString(ApiEnvelope.serializer(), raw)
            if (envelope.protocolVersion != 1) {
                throw RemoteApiException("PROTOCOL_MISMATCH", "电脑端协议版本不兼容", false)
            }
            if (!envelope.ok || envelope.error != null) {
                val error = envelope.error
                throw RemoteApiException(
                    error?.code ?: "ENGINE_UNAVAILABLE",
                    error?.message ?: "电脑端请求失败",
                    error?.retryable ?: (response.code >= 500),
                )
            }
            val payload = envelope.payload ?: throw RemoteApiException("CONFLICT", "响应缺少数据", false)
            json.decodeFromJsonElement(serializer, payload)
        }
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
        val DEFAULT_SCOPES = listOf(
            "sessions:read",
            "messages:send",
            "tasks:stop",
            "skills:select",
            "mcp:select",
        )
    }
}

@Serializable
private data class ApiEnvelope(
    val protocolVersion: Int,
    val ok: Boolean,
    val payload: JsonElement? = null,
    val error: ApiError? = null,
)

@Serializable
private data class ApiError(val code: String, val message: String, val retryable: Boolean)

@Serializable
private data class PairRequest(
    val pairingId: String,
    val secret: String,
    val deviceId: String,
    val deviceName: String,
    val requestedScopes: List<String>,
    val protocolVersion: Int,
)

@Serializable
private data class CreateSessionRequest(val title: String?, val clientSessionId: String)

@Serializable
private data class SendMessageRequest(
    val text: String,
    val skillIds: List<String>? = null,
    val mcpServerIds: List<String>? = null,
    val allowedToolNames: List<String>? = null,
    val clientMessageId: String,
)

@Serializable
private data class StopRequest(val turnId: String?)

@Serializable
private data class ApprovalRequest(val approved: Boolean)

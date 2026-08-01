package com.routedev.remote.ui

import android.app.Application
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.routedev.remote.RouteDevApplication
import com.routedev.remote.data.local.SessionEntity
import com.routedev.remote.data.local.TimelineEventEntity
import com.routedev.remote.data.remote.RemoteUrlPolicy
import com.routedev.remote.domain.DeviceCredentials
import com.routedev.remote.domain.PairingOffer
import com.routedev.remote.domain.RemoteMcpServer
import com.routedev.remote.domain.RemoteSkill
import com.routedev.remote.domain.RemoteTool
import com.routedev.remote.service.PendingMessageWorker
import com.routedev.remote.service.TaskConnectionService
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class CapabilityState(
    val skills: List<RemoteSkill> = emptyList(),
    val mcpServers: List<RemoteMcpServer> = emptyList(),
    val tools: List<RemoteTool> = emptyList(),
    val selectedSkills: Set<String> = emptySet(),
    val selectedMcp: Set<String> = emptySet(),
    val selectedTools: Set<String> = emptySet(),
)

data class UiStatus(
    val busy: Boolean = false,
    val message: String? = null,
    val online: Boolean = false,
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val container = (application as RouteDevApplication).container
    private val repository = container.repository
    val sessions: StateFlow<List<SessionEntity>> = repository.observeSessions()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _credentials = MutableStateFlow(container.credentials.load())
    val credentials = _credentials.asStateFlow()
    private val _status = MutableStateFlow(UiStatus())
    val status = _status.asStateFlow()
    private val _capabilities = MutableStateFlow(CapabilityState())
    val capabilities = _capabilities.asStateFlow()
    private val _notificationsEnabled = MutableStateFlow(container.credentials.notificationsEnabled())
    val notificationsEnabled = _notificationsEnabled.asStateFlow()
    private var liveJob: Job? = null

    init {
        if (_credentials.value != null) {
            refresh()
            if (_notificationsEnabled.value) {
                val context = getApplication<Application>()
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, TaskConnectionService::class.java),
                )
            }
        }
    }

    fun pair(rawOffer: String, deviceName: String, baseUrlOverride: String) = launchAction {
        val decoded = container.json.decodeFromString(PairingOffer.serializer(), rawOffer)
        val offer = decoded.copy(
            baseUrl = baseUrlOverride.trim().ifBlank { decoded.baseUrl }.trimEnd('/'),
        )
        require(offer.protocolVersion == 1) { "协议版本不兼容" }
        require(RemoteUrlPolicy.isSupported(offer.baseUrl, offer.transport)) {
            "请输入 HTTPS 地址，或同一局域网中的电脑地址"
        }
        val deviceId = UUID.randomUUID().toString()
        val result = container.api.pair(offer, deviceId, deviceName.ifBlank { "Android 手机" })
        val stored = DeviceCredentials(
            result.baseUrl,
            result.deviceId,
            result.desktopName,
            result.deviceToken,
            result.grantedScopes.toSet(),
        )
        container.credentials.save(stored)
        _credentials.value = stored
        refresh()
    }

    fun refresh() = launchAction {
        repository.refreshSessions()
        _status.value = UiStatus(online = true)
    }

    fun createSession(title: String?, onCreated: (String) -> Unit) = launchAction {
        onCreated(repository.createSession(title))
    }

    fun observeTimeline(sessionId: String): StateFlow<List<TimelineEventEntity>> =
        repository.observeTimeline(sessionId)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun connectSession(sessionId: String) {
        liveJob?.cancel()
        liveJob = viewModelScope.launch {
            try {
                repository.refreshTimeline(sessionId)
                repository.liveEvents(sessionId).collect { _status.value = UiStatus(online = true) }
            } catch (error: com.routedev.remote.domain.RemoteApiException) {
                if (error.code == "AUTH_REVOKED") clearPairing()
                else _status.value = UiStatus(message = error.message, online = false)
            }
        }
        loadCapabilities()
    }

    fun send(sessionId: String, text: String) {
        if (text.isBlank()) return
        val capability = _capabilities.value
        launchAction {
            try {
                repository.send(
                    sessionId,
                    text,
                    capability.selectedSkills.toList(),
                    capability.selectedMcp.toList(),
                    capability.selectedTools.toList(),
                )
                _capabilities.value = _capabilities.value.copy(
                    selectedSkills = emptySet(),
                    selectedMcp = emptySet(),
                    selectedTools = emptySet(),
                )
            } catch (error: Exception) {
                PendingMessageWorker.schedule(getApplication())
                throw error
            }
        }
    }

    fun stop(session: SessionEntity) = launchAction {
        repository.stop(session.sessionId, session.activeTurnId)
    }

    fun resolveApproval(approvalId: String, approved: Boolean) = launchAction {
        repository.resolveApproval(approvalId, approved)
    }

    fun loadCapabilities() = launchAction {
        val (skills, mcp, tools) = repository.capabilities()
        _capabilities.value = _capabilities.value.copy(
            skills = skills.filter { it.enabled },
            mcpServers = mcp.filter { it.connected },
            tools = tools.filter { it.allowed },
        )
    }

    fun toggleSkill(id: String) {
        _capabilities.value = _capabilities.value.copy(
            selectedSkills = _capabilities.value.selectedSkills.toggle(id),
        )
    }

    fun toggleMcp(id: String) {
        _capabilities.value = _capabilities.value.copy(
            selectedMcp = _capabilities.value.selectedMcp.toggle(id),
        )
    }

    fun toggleTool(id: String) {
        _capabilities.value = _capabilities.value.copy(
            selectedTools = _capabilities.value.selectedTools.toggle(id),
        )
    }

    fun setNotifications(enabled: Boolean) {
        val context = getApplication<Application>()
        val intent = Intent(context, TaskConnectionService::class.java)
        if (enabled) ContextCompat.startForegroundService(context, intent) else context.stopService(intent)
        container.credentials.setNotificationsEnabled(enabled)
        _notificationsEnabled.value = enabled
    }

    fun clearPairing() = launchAction {
        liveJob?.cancel()
        val context = getApplication<Application>()
        context.stopService(Intent(context, TaskConnectionService::class.java))
        repository.clearLocalData()
        container.credentials.clear()
        _notificationsEnabled.value = false
        _credentials.value = null
        _status.value = UiStatus(message = "本地配对信息已清除")
    }

    fun clearMessage() {
        _status.value = _status.value.copy(message = null)
    }

    private fun launchAction(block: suspend () -> Unit) {
        viewModelScope.launch {
            _status.value = _status.value.copy(busy = true, message = null)
            runCatching { block() }
                .onFailure {
                    _status.value = UiStatus(
                        message = it.message ?: "操作失败，请检查电脑连接",
                        online = false,
                    )
                }
                .onSuccess { _status.value = _status.value.copy(busy = false) }
        }
    }

    private fun Set<String>.toggle(id: String): Set<String> =
        if (contains(id)) this - id else this + id
}

package com.routedev.remote.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.routedev.remote.R
import com.routedev.remote.data.local.SessionEntity
import com.routedev.remote.data.local.TimelineEventEntity
import com.routedev.remote.data.remote.RemoteUrlPolicy
import com.routedev.remote.domain.PairingOffer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private sealed interface Screen {
    data object Home : Screen
    data object Settings : Screen
    data class Chat(val sessionId: String) : Screen
}

@Composable
fun RouteDevApp(viewModel: MainViewModel, initialSessionId: String?) {
    val credentials by viewModel.credentials.collectAsState()
    val status by viewModel.status.collectAsState()
    var screen by remember { mutableStateOf<Screen>(initialSessionId?.let(Screen::Chat) ?: Screen.Home) }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(status.message) {
        status.message?.let {
            snackbar.showSnackbar(it)
            viewModel.clearMessage()
        }
    }
    if (credentials == null) {
        PairingScreen(viewModel, status.busy)
        return
    }
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            if (screen !is Screen.Chat) {
                NavigationBar {
                    NavigationBarItem(
                        selected = screen == Screen.Home,
                        onClick = { screen = Screen.Home },
                        icon = {
                            Icon(
                                painterResource(R.drawable.ic_tasks),
                                contentDescription = "任务",
                            )
                        },
                        label = { Text("任务") },
                    )
                    NavigationBarItem(
                        selected = screen == Screen.Settings,
                        onClick = { screen = Screen.Settings },
                        icon = {
                            Icon(
                                painterResource(R.drawable.ic_settings),
                                contentDescription = "设置",
                            )
                        },
                        label = { Text("设置") },
                    )
                }
            }
        },
        contentWindowInsets = WindowInsets(0),
    ) { padding ->
        when (val current = screen) {
            Screen.Home -> HomeScreen(
                viewModel,
                Modifier.padding(padding),
                onOpen = { screen = Screen.Chat(it) },
            )
            Screen.Settings -> SettingsScreen(viewModel, Modifier.padding(padding))
            is Screen.Chat -> {
                BackHandler { screen = Screen.Home }
                ChatScreen(viewModel, current.sessionId, { screen = Screen.Home })
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeScreen(viewModel: MainViewModel, modifier: Modifier, onOpen: (String) -> Unit) {
    val sessions by viewModel.sessions.collectAsState()
    val status by viewModel.status.collectAsState()
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("RouteDev", style = MaterialTheme.typography.titleLarge)
                        Text(
                            if (status.online) "电脑在线" else "等待连接",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (status.online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = { TextButton(onClick = viewModel::refresh) { Text("刷新") } },
            )
        },
        floatingActionButton = {
            Button(onClick = { viewModel.createSession(null, onOpen) }) { Text("新建对话") }
        },
    ) { padding ->
        if (sessions.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("还没有远程任务", style = MaterialTheme.typography.titleMedium)
                    Text("新建对话后，执行过程会实时同步到这里。", style = MaterialTheme.typography.bodyMedium)
                }
            }
        } else {
            LazyColumn(
                contentPadding = PaddingValues(
                    start = 16.dp,
                    top = padding.calculateTopPadding() + 8.dp,
                    end = 16.dp,
                    bottom = 96.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(sessions, key = { it.sessionId }) { session ->
                    SessionRow(session, onOpen)
                }
            }
        }
    }
}

@Composable
private fun SessionRow(session: SessionEntity, onOpen: (String) -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable { onOpen(session.sessionId) },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
    ) {
        Row(
            Modifier.padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(statusGlyph(session.status), style = MaterialTheme.typography.titleMedium)
            Column(Modifier.weight(1f)) {
                Text(session.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(statusLabel(session.status), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(
                painterResource(R.drawable.ic_chevron_right),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreen(viewModel: MainViewModel, sessionId: String, onBack: () -> Unit) {
    val timelineFlow = remember(sessionId) { viewModel.observeTimeline(sessionId) }
    val timeline by timelineFlow.collectAsState()
    val sessions by viewModel.sessions.collectAsState()
    val session = sessions.firstOrNull { it.sessionId == sessionId }
    var input by rememberSaveable { mutableStateOf("") }
    var showCapabilities by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(sessionId) { viewModel.connectSession(sessionId) }
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { TextButton(onClick = onBack) { Text("返回") } },
                title = {
                    Column {
                        Text(session?.title ?: "对话", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(statusLabel(session?.status ?: "idle"), style = MaterialTheme.typography.labelMedium)
                    }
                },
                actions = {
                    if (session?.status == "running" || session?.status == "waiting_approval") {
                        TextButton(onClick = { viewModel.stop(session) }) { Text("停止") }
                    }
                },
            )
        },
        bottomBar = {
            Column(
                Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(12.dp),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AssistChip(onClick = { showCapabilities = true }, label = { Text("Skill · MCP · 工具") })
                }
                Row(
                    verticalAlignment = Alignment.Bottom,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it },
                        placeholder = { Text("给 RouteDev 发消息") },
                        maxLines = 5,
                        modifier = Modifier.weight(1f),
                    )
                    Button(
                        onClick = {
                            viewModel.send(sessionId, input)
                            input = ""
                        },
                        enabled = input.isNotBlank() && session?.status !in setOf("running", "waiting_approval"),
                        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 16.dp),
                    ) { Text("发送") }
                }
            }
        },
    ) { padding ->
        val rows = remember(timeline) { timelineRows(timeline) }
        if (rows.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text("发送第一条消息开始任务", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = 16.dp,
                    end = 16.dp,
                    top = padding.calculateTopPadding() + 8.dp,
                    bottom = padding.calculateBottomPadding() + 8.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                itemsIndexed(rows, key = { _, item -> "${item.sequence}-${item.type}" }) { _, item ->
                    TimelineCard(item, viewModel)
                }
            }
        }
    }
    if (showCapabilities) {
        CapabilitySheet(viewModel) { showCapabilities = false }
    }
}

@Composable
private fun TimelineCard(event: TimelineEventEntity, viewModel: MainViewModel) {
    val payload = remember(event.payloadJson) { runCatching { Json.parseToJsonElement(event.payloadJson).jsonObject }.getOrNull() }
    val title = when (event.type) {
        "turn.started" -> "你的消息"
        "assistant.text.delta" -> "RouteDev"
        "assistant.reasoning.delta" -> "推理过程"
        "assistant.progress" -> "工作进度"
        "tool.started" -> "调用工具"
        "tool.output.delta" -> "工具输出"
        "tool.completed" -> "工具完成"
        "tool.failed" -> "工具失败"
        "todo.replaced", "todo.updated" -> "当前待办"
        "approval.required" -> "需要授权"
        "task.completed" -> "任务完成"
        "task.failed", "turn.failed" -> "任务失败"
        else -> event.type
    }
    val body = payloadText(event.type, payload)
    val collapsible = event.type == "assistant.reasoning.delta" || event.type == "tool.output.delta"
    var expanded by rememberSaveable(event.eventId) { mutableStateOf(false) }
    Card(
        colors = CardDefaults.cardColors(
            containerColor = when {
                event.type == "turn.started" -> MaterialTheme.colorScheme.primaryContainer
                event.type.contains("failed") -> MaterialTheme.colorScheme.errorContainer
                else -> MaterialTheme.colorScheme.surfaceContainer
            },
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text("#${event.sequence}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (body.isNotBlank() && (!collapsible || expanded)) {
                Text(body, style = MaterialTheme.typography.bodyMedium)
            }
            if (collapsible) {
                TextButton(onClick = { expanded = !expanded }) {
                    Text(if (expanded) "收起" else if (event.type == "assistant.reasoning.delta") "展开推理" else "展开输出")
                }
            }
            if (event.type == "approval.required") {
                val approval = payload?.get("approval")?.jsonObject
                val id = approval?.get("approvalId")?.jsonPrimitive?.content
                val canResolve = approval?.get("canResolveRemotely")?.jsonPrimitive?.content == "true"
                if (id != null && canResolve) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { viewModel.resolveApproval(id, false) }) { Text("拒绝") }
                        Button(onClick = { viewModel.resolveApproval(id, true) }) { Text("允许一次") }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CapabilitySheet(viewModel: MainViewModel, onDismiss: () -> Unit) {
    val state by viewModel.capabilities.collectAsState()
    ModalBottomSheet(onDismissRequest = onDismiss) {
        LazyColumn(
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            item {
                Text("本轮可用能力", style = MaterialTheme.typography.titleLarge)
                Text("选择只会收窄电脑端已允许的范围，不会安装插件或修改 MCP 凭据。", style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(12.dp))
                Text("Skill", style = MaterialTheme.typography.titleMedium)
            }
            items(state.skills, key = { "skill-${it.id}" }) { item ->
                CapabilityRow(item.name, item.description, item.id in state.selectedSkills) { viewModel.toggleSkill(item.id) }
            }
            item { Text("MCP Server", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp)) }
            items(state.mcpServers, key = { "mcp-${it.id}" }) { item ->
                CapabilityRow(item.name, "${item.toolCount} 个可用工具", item.id in state.selectedMcp) { viewModel.toggleMcp(item.id) }
            }
            item { Text("进一步限制工具", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp)) }
            items(state.tools, key = { "tool-${it.name}" }) { item ->
                CapabilityRow(item.name, item.description, item.name in state.selectedTools) { viewModel.toggleTool(item.name) }
            }
        }
    }
}

@Composable
private fun CapabilityRow(title: String, subtitle: String, checked: Boolean, onToggle: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
        }
        Checkbox(checked, onCheckedChange = { onToggle() })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsScreen(viewModel: MainViewModel, modifier: Modifier) {
    val credentials by viewModel.credentials.collectAsState()
    val notifications by viewModel.notificationsEnabled.collectAsState()
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            viewModel.setNotifications(true)
        }
    }
    Scaffold(modifier = modifier, topBar = { TopAppBar(title = { Text("设置") }) }) { padding ->
        LazyColumn(
            Modifier.padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                SettingCard("已配对电脑") {
                    Text(credentials?.desktopName ?: "未连接", style = MaterialTheme.typography.titleMedium)
                    Text(credentials?.baseUrl ?: "", style = MaterialTheme.typography.bodySmall)
                    OutlinedButton(onClick = viewModel::refresh) { Text("测试连接") }
                }
            }
            item {
                SettingCard("任务完成通知") {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("保持前台连接服务", modifier = Modifier.weight(1f))
                        Switch(
                            checked = notifications,
                            onCheckedChange = { enabled ->
                                if (enabled && Build.VERSION.SDK_INT >= 33) {
                                    permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                                } else {
                                    viewModel.setNotifications(enabled)
                                }
                            },
                        )
                    }
                    Text(
                        "开启后，屏幕关闭时仍可接收完成、失败和授权通知。强制停止应用、关闭电脑或断开网络后不保证即时通知。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            item {
                SettingCard("设备权限") {
                    Text(credentials?.scopes?.sorted()?.joinToString("\n") ?: "无", style = MaterialTheme.typography.bodyMedium)
                    Text("权限由电脑端控制；高风险的远程审批和自主度修改默认关闭。", style = MaterialTheme.typography.bodySmall)
                }
            }
            item {
                SettingCard("协议与版本") {
                    Text("Remote Protocol v1 · Android 1.0.0", style = MaterialTheme.typography.bodyMedium)
                }
            }
            item {
                OutlinedButton(onClick = viewModel::clearPairing, modifier = Modifier.fillMaxWidth()) {
                    Text("清除本机配对与缓存")
                }
            }
        }
    }
}

@Composable
private fun SettingCard(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

private fun statusGlyph(status: String) = when (status) {
    "running" -> "●"
    "waiting_approval" -> "!"
    "completed" -> "✓"
    "failed" -> "×"
    else -> "○"
}

private fun statusLabel(status: String) = when (status) {
    "running" -> "正在执行"
    "waiting_approval" -> "等待授权"
    "completed" -> "已完成"
    "failed" -> "失败"
    else -> "空闲"
}

internal fun timelineRows(events: List<TimelineEventEntity>): List<TimelineEventEntity> {
    val ordered = events.sortedBy { it.sequence }
    val todoSnapshot = buildTodoSnapshot(ordered)
    val filtered = ordered.filterNot { it.type == "todo.replaced" || it.type == "todo.updated" }.toMutableList()
    todoSnapshot?.let(filtered::add)
    val result = mutableListOf<TimelineEventEntity>()
    for (event in filtered.sortedBy { it.sequence }) {
        val previous = result.lastOrNull()
        val mergeable = event.type == "assistant.text.delta"
            || event.type == "assistant.reasoning.delta"
            || event.type == "tool.output.delta"
        if (mergeable && previous?.type == event.type) {
            val previousPayload = runCatching { Json.parseToJsonElement(previous.payloadJson).jsonObject }.getOrNull()
            val eventPayload = runCatching { Json.parseToJsonElement(event.payloadJson).jsonObject }.getOrNull()
            val key = if (event.type == "tool.output.delta") "delta" else "text"
            val sameTool = event.type != "tool.output.delta"
                || (
                    previousPayload?.get("toolCallId")?.jsonPrimitive?.content
                        == eventPayload?.get("toolCallId")?.jsonPrimitive?.content
                )
            if (sameTool && previousPayload != null && eventPayload != null) {
                val combined = previousPayload[key]?.jsonPrimitive?.content.orEmpty() +
                    eventPayload[key]?.jsonPrimitive?.content.orEmpty()
                val mergedPayload = kotlinx.serialization.json.JsonObject(
                    eventPayload.toMutableMap().apply {
                        put(key, kotlinx.serialization.json.JsonPrimitive(combined))
                    },
                )
                result[result.lastIndex] = event.copy(
                    eventId = previous.eventId,
                    sequence = previous.sequence,
                    timestamp = previous.timestamp,
                    payloadJson = mergedPayload.toString(),
                )
                continue
            }
        }
        result += event
    }
    return result
}

private fun buildTodoSnapshot(events: List<TimelineEventEntity>): TimelineEventEntity? {
    val items = linkedMapOf<String, JsonObject>()
    var latest: TimelineEventEntity? = null
    for (event in events) {
        if (event.type != "todo.replaced" && event.type != "todo.updated") continue
        val payload = runCatching { Json.parseToJsonElement(event.payloadJson).jsonObject }.getOrNull() ?: continue
        if (event.type == "todo.replaced") {
            items.clear()
            payload["items"]?.let { value ->
                runCatching { value.jsonArray }.getOrNull()?.forEach { item ->
                    item.jsonObject["id"]?.jsonPrimitive?.content?.let { id -> items[id] = item.jsonObject }
                }
            }
        } else {
            payload["item"]?.let { value ->
                runCatching { value.jsonObject }.getOrNull()?.let { item ->
                    item["id"]?.jsonPrimitive?.content?.let { id -> items[id] = item }
                }
            }
        }
        latest = event
    }
    return latest?.copy(
        type = "todo.replaced",
        payloadJson = JsonObject(mapOf("items" to JsonArray(items.values.toList()))).toString(),
    )
}

private fun payloadText(type: String, payload: kotlinx.serialization.json.JsonObject?): String {
    if (payload == null) return ""
    fun text(key: String) = payload[key]?.jsonPrimitive?.content.orEmpty()
    return when (type) {
        "turn.started" -> text("userText")
        "assistant.text.delta", "assistant.reasoning.delta", "assistant.progress" -> text("text")
        "tool.started" -> listOf(text("toolName"), text("argsSummary")).filter { it.isNotBlank() }.joinToString("\n")
        "tool.output.delta" -> text("delta")
        "tool.completed" -> text("outputSummary")
        "task.completed" -> text("summary")
        "connection.notice" -> text("message")
        "todo.replaced", "todo.updated" -> payload["items"]?.jsonArray?.joinToString("\n") { element ->
            val item = element.jsonObject
            val mark = if (item["status"]?.jsonPrimitive?.content == "completed") "✓" else "○"
            "$mark ${item["content"]?.jsonPrimitive?.content.orEmpty()}"
        }.orEmpty()
        "approval.required" -> payload["approval"]?.jsonObject?.get("summary")?.jsonPrimitive?.content.orEmpty()
        else -> payload.toString().take(1_500)
    }
}

@Composable
private fun PairingScreen(viewModel: MainViewModel, busy: Boolean) {
    val context = LocalContext.current
    var offer by rememberSaveable { mutableStateOf("") }
    var baseUrl by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf(Build.MODEL.ifBlank { "Android 手机" }) }
    val parsedOffer = remember(offer) {
        runCatching { Json.decodeFromString<PairingOffer>(offer) }.getOrNull()
    }
    LaunchedEffect(parsedOffer?.baseUrl) {
        if (baseUrl.isBlank()) baseUrl = parsedOffer?.baseUrl.orEmpty()
    }
    val scanner = remember {
        GmsBarcodeScanning.getClient(
            context,
            GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build(),
        )
    }
    val canConnect = offer.isNotBlank() && RemoteUrlPolicy.isSupported(baseUrl, parsedOffer?.transport)
    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text("连接 RouteDev", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(8.dp))
            Text(
                "同一 Wi-Fi 可直接连接；跨网络时再使用电脑提供的 HTTPS 地址。模型、文件权限和工具执行始终留在电脑上。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(24.dp))
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("手机名称") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                label = { Text("电脑连接地址") },
                supportingText = {
                    Text("局域网通常是 http://192.168.x.x:43117；跨网络请使用 HTTPS 地址")
                },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = offer,
                onValueChange = { offer = it },
                label = { Text("一次性配对信息") },
                supportingText = {
                    Text(
                        parsedOffer?.let {
                            "${it.desktopName} · ${if (it.transport == "lan") "局域网" else "HTTPS"} · 协议 v${it.protocolVersion}"
                        } ?: "扫描电脑端二维码，或粘贴完整配对 JSON",
                    )
                },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    onClick = {
                        scanner.startScan().addOnSuccessListener { barcode ->
                            barcode.rawValue?.let {
                                offer = it
                                runCatching { Json.decodeFromString<PairingOffer>(it) }
                                    .getOrNull()
                                    ?.let { decoded -> baseUrl = decoded.baseUrl }
                            }
                        }
                    },
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                ) { Text("扫描二维码") }
                Button(
                    onClick = { viewModel.pair(offer.trim(), name.trim(), baseUrl) },
                    enabled = canConnect && !busy,
                    modifier = Modifier.weight(1f),
                ) {
                    if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    else Text("连接电脑")
                }
            }
        }
    }
}

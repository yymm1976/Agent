package com.routedev.remote.data.local

import androidx.room.Entity
import androidx.room.Index

@Entity(tableName = "sessions")
data class SessionEntity(
    @androidx.room.PrimaryKey val sessionId: String,
    val title: String,
    val status: String,
    val createdAt: String,
    val updatedAt: String,
    val activeTurnId: String?,
    val lastSequence: Long,
    val lastEventId: String?,
    val latestResult: String?,
)

@Entity(
    tableName = "timeline_events",
    primaryKeys = ["sessionId", "sequence"],
    indices = [Index(value = ["eventId"], unique = true)],
)
data class TimelineEventEntity(
    val sessionId: String,
    val sequence: Long,
    val eventId: String,
    val turnId: String?,
    val timestamp: String,
    val type: String,
    val payloadJson: String,
)

@Entity(tableName = "pending_messages", indices = [Index(value = ["sessionId"])])
data class PendingMessageEntity(
    @androidx.room.PrimaryKey val clientMessageId: String,
    val sessionId: String,
    val text: String,
    val skillIdsJson: String,
    val mcpServerIdsJson: String,
    val toolNamesJson: String,
    val createdAtEpochMs: Long,
    val attempts: Int,
)

package com.routedev.remote.data.local

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface RouteDevDao {
    @Query("SELECT * FROM sessions ORDER BY updatedAt DESC")
    fun observeSessions(): Flow<List<SessionEntity>>

    @Query("SELECT * FROM sessions WHERE sessionId = :sessionId")
    fun observeSession(sessionId: String): Flow<SessionEntity?>

    @Query("SELECT * FROM sessions WHERE sessionId = :sessionId")
    suspend fun session(sessionId: String): SessionEntity?

    @Upsert
    suspend fun upsertSessions(sessions: List<SessionEntity>)

    @Upsert
    suspend fun upsertSession(session: SessionEntity)

    @Query("SELECT * FROM timeline_events WHERE sessionId = :sessionId ORDER BY sequence ASC")
    fun observeTimeline(sessionId: String): Flow<List<TimelineEventEntity>>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertEvent(event: TimelineEventEntity): Long

    @Query(
        "UPDATE sessions SET lastSequence = :sequence, lastEventId = :eventId, " +
            "updatedAt = :updatedAt, status = :status, activeTurnId = :activeTurnId " +
            "WHERE sessionId = :sessionId",
    )
    suspend fun advanceSession(
        sessionId: String,
        sequence: Long,
        eventId: String,
        updatedAt: String,
        status: String,
        activeTurnId: String?,
    )

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun enqueue(message: PendingMessageEntity)

    @Query("SELECT * FROM pending_messages ORDER BY createdAtEpochMs ASC")
    suspend fun pendingMessages(): List<PendingMessageEntity>

    @Delete
    suspend fun deletePending(message: PendingMessageEntity)

    @Query(
        "DELETE FROM timeline_events WHERE sessionId NOT IN " +
            "(SELECT sessionId FROM sessions ORDER BY updatedAt DESC LIMIT :keepSessions)",
    )
    suspend fun trimTimeline(keepSessions: Int = 30)

    @Query("DELETE FROM timeline_events")
    suspend fun clearEvents()

    @Query("DELETE FROM pending_messages")
    suspend fun clearPending()

    @Query("DELETE FROM sessions")
    suspend fun clearSessions()
}

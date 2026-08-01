package com.routedev.remote.data.local

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RouteDevDatabaseTest {
    private lateinit var database: RouteDevDatabase

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            RouteDevDatabase::class.java,
        ).allowMainThreadQueries().build()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun duplicateSessionSequenceIsIdempotent() = runBlocking {
        val event = TimelineEventEntity(
            sessionId = "session",
            sequence = 1,
            eventId = "event-1",
            turnId = "turn",
            timestamp = "2026-07-30T00:00:00.000Z",
            type = "turn.started",
            payloadJson = "{}",
        )
        assertEquals(1L, database.routeDevDao().insertEvent(event))
        assertEquals(-1L, database.routeDevDao().insertEvent(event))
        assertEquals(1, database.routeDevDao().observeTimeline("session").first().size)
    }
}

package com.routedev.remote.ui

import com.routedev.remote.data.local.TimelineEventEntity
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TimelineRowsTest {
    @Test
    fun `keeps real chronological order and replaces older todo snapshots`() {
        val events = listOf(
            event(1, "assistant.reasoning.delta"),
            event(2, "todo.replaced"),
            event(3, "tool.started"),
            event(4, "assistant.reasoning.delta"),
            event(5, "todo.updated"),
            event(6, "assistant.progress"),
        )
        assertEquals(
            listOf(
                "assistant.reasoning.delta",
                "tool.started",
                "assistant.reasoning.delta",
                "todo.replaced",
                "assistant.progress",
            ),
            timelineRows(events).map { it.type },
        )
    }

    @Test
    fun `todo updates retain the complete current list`() {
        val events = listOf(
            event(1, "todo.replaced", """{"items":[{"id":"a","content":"先做","status":"pending"},{"id":"b","content":"再做","status":"pending"}]}"""),
            event(2, "todo.updated", """{"item":{"id":"a","content":"先做","status":"completed"}}"""),
        )
        val payload = timelineRows(events).single().payloadJson
        assertTrue(payload.contains("\"id\":\"a\""))
        assertTrue(payload.contains("\"id\":\"b\""))
        assertTrue(payload.contains("\"status\":\"completed\""))
    }

    private fun event(sequence: Long, type: String, payloadJson: String = "{}") = TimelineEventEntity(
        sessionId = "session",
        sequence = sequence,
        eventId = "event-$sequence",
        turnId = "turn",
        timestamp = "2026-07-30T00:00:00.000Z",
        type = type,
        payloadJson = payloadJson,
    )
}

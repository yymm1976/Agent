package com.routedev.remote.protocol

import java.nio.file.Files
import java.nio.file.Path
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class ProtocolFixtureTest {
    private val fixtures = Path.of("fixtures")
    private val json = RemoteProtocolCodec.json

    @Test
    fun `all event fixtures decode and retain strict sequence`() {
        val events = readArray("event-success.json").map {
            RemoteProtocolCodec.decodeEvent(it.toString())
        }

        assertEquals(RemoteEventType.entries.toSet(), events.map { it.type }.toSet())
        assertEquals(emptyList<String>(), RemoteProtocolCodec.validateSequence(events))
        assertEquals(
            listOf(
                RemoteEventType.ASSISTANT_REASONING_DELTA,
                RemoteEventType.ASSISTANT_PROGRESS,
                RemoteEventType.TOOL_STARTED,
                RemoteEventType.TOOL_OUTPUT_DELTA,
                RemoteEventType.TOOL_COMPLETED,
                RemoteEventType.ASSISTANT_REASONING_DELTA,
            ),
            events.slice(3..8).map { it.type },
        )
    }

    @Test
    fun `all REST fixtures decode while unknown fields stay forward compatible`() {
        readArray("rest-success.json").forEach { fixture ->
            val schema = fixture["schema"]!!.jsonPrimitive.content
            val value = fixture["value"]!!
            assertDoesNotThrow(
                { decodeRest(schema, value.toString()) },
                fixture["name"]!!.jsonPrimitive.content,
            )
        }
    }

    @Test
    fun `invalid fixtures reject missing fields protocol mismatch and unknown enums`() {
        readArray("invalid-fixtures.json").forEach { fixture ->
            val schema = fixture["schema"]!!.jsonPrimitive.content
            val value = fixture["value"]!!
            assertThrows(
                Exception::class.java,
                {
                    if (schema == "event") {
                        RemoteProtocolCodec.decodeEvent(value.toString())
                    } else {
                        decodeRest(schema, value.toString())
                    }
                },
                fixture["name"]!!.jsonPrimitive.content,
            )
        }
    }

    @Test
    fun `duplicate reversed and cross-session events are reported`() {
        val events = readArray("event-success.json").take(2).map {
            RemoteProtocolCodec.decodeEvent(it.toString())
        }
        val broken = listOf(
            events[1],
            events[0].copy(eventId = events[1].eventId, sessionId = "other"),
        )
        assertEquals(
            setOf(
                "duplicate eventId: event-2",
                "mixed sessionId: other",
                "sequence must increase: 2 -> 1",
            ),
            RemoteProtocolCodec.validateSequence(broken).toSet(),
        )
    }

    private fun decodeRest(schema: String, value: String) {
        when (schema) {
            "pairRequest" -> json.decodeFromString<RemotePairRequest>(value).also {
                require(it.protocolVersion == REMOTE_PROTOCOL_VERSION)
            }
            "createSessionRequest" -> json.decodeFromString<RemoteCreateSessionRequest>(value)
            "sendMessageRequest" -> json.decodeFromString<RemoteSendMessageRequest>(value)
            "stopTaskRequest" -> json.decodeFromString<RemoteStopTaskRequest>(value)
            "approvalResolveRequest" -> json.decodeFromString<RemoteApprovalResolveRequest>(value)
            else -> RemoteProtocolCodec.decodeResponse(value)
        }
    }

    private fun readArray(name: String): List<JsonObject> {
        val content = Files.readString(fixtures.resolve(name))
        return json.decodeFromString<JsonArray>(content).map { it.jsonObject }
    }
}

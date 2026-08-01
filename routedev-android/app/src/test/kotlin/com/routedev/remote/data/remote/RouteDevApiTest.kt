package com.routedev.remote.data.remote

import com.routedev.remote.domain.DeviceCredentials
import com.routedev.remote.domain.RemoteApiException
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class RouteDevApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: RouteDevApi

    @BeforeEach
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = RouteDevApi(OkHttpClient())
    }

    @AfterEach
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `accepts HTTPS and trusted LAN addresses but rejects public HTTP`() {
        org.junit.jupiter.api.Assertions.assertTrue(
            RemoteUrlPolicy.isSupported("https://desktop.example.ts.net", "https"),
        )
        org.junit.jupiter.api.Assertions.assertTrue(
            RemoteUrlPolicy.isSupported("http://192.168.1.20:43117", "lan"),
        )
        org.junit.jupiter.api.Assertions.assertTrue(
            RemoteUrlPolicy.isSupported("http://192.168.1.20:43117"),
        )
        org.junit.jupiter.api.Assertions.assertFalse(
            RemoteUrlPolicy.isSupported("http://203.0.113.20:43117", "lan"),
        )
    }

    @Test
    fun `decodes sessions and authenticates with device token`() = runBlocking {
        server.enqueue(
            MockResponse().setHeader("Content-Type", "application/json").setBody(
                """
                {
                  "protocolVersion": 1,
                  "requestId": "req-1",
                  "timestamp": "2026-07-30T00:00:00.000Z",
                  "sessionId": null,
                  "turnId": null,
                  "ok": true,
                  "payload": [{
                    "sessionId": "s-1",
                    "title": "真实任务",
                    "status": "running",
                    "createdAt": "2026-07-30T00:00:00.000Z",
                    "updatedAt": "2026-07-30T00:01:00.000Z",
                    "activeTurnId": "t-1",
                    "lastSequence": 8
                  }],
                  "error": null
                }
                """.trimIndent(),
            ),
        )
        val result = api.sessions(credentials())
        assertEquals("s-1", result.single().sessionId)
        assertEquals(8, result.single().lastSequence)
        assertEquals("Bearer secret-device-token", server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `maps stable error code instead of localized message`() {
        server.enqueue(
            MockResponse().setResponseCode(401).setHeader("Content-Type", "application/json").setBody(
                """
                {
                  "protocolVersion": 1,
                  "requestId": "req-2",
                  "timestamp": "2026-07-30T00:00:00.000Z",
                  "sessionId": null,
                  "turnId": null,
                  "ok": false,
                  "payload": null,
                  "error": {
                    "code": "AUTH_REVOKED",
                    "message": "设备已撤销",
                    "retryable": false
                  }
                }
                """.trimIndent(),
            ),
        )
        val error = assertThrows(RemoteApiException::class.java) {
            runBlocking { api.sessions(credentials()) }
        }
        assertEquals("AUTH_REVOKED", error.code)
        assertEquals(false, error.retryable)
    }

    @Test
    fun `maps a non-json unauthorized response to auth revoked`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("unauthorized"))
        val error = assertThrows(RemoteApiException::class.java) {
            runBlocking { api.sessions(credentials()) }
        }
        assertEquals("AUTH_REVOKED", error.code)
    }

    private fun credentials() = DeviceCredentials(
        baseUrl = server.url("/").toString().replace("localhost", "127.0.0.1").trimEnd('/'),
        deviceId = "device-1",
        desktopName = "电脑",
        token = "secret-device-token",
        scopes = setOf("sessions:read"),
    )
}

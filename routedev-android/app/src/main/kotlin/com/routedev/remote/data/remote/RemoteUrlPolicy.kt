package com.routedev.remote.data.remote

import java.net.URI

/**
 * HTTP is accepted only for an explicitly LAN pairing. HTTPS remains the
 * default for Tailscale and custom remote endpoints.
 */
object RemoteUrlPolicy {
    fun isSupported(baseUrl: String, transport: String? = null): Boolean {
        val uri = runCatching { URI(baseUrl.trim().trimEnd('/')) }.getOrNull() ?: return false
        return when (uri.scheme?.lowercase()) {
            "https" -> true
            "http" -> (transport == null || transport == "lan") && isPrivateHost(uri.host)
            else -> false
        }
    }

    private fun isPrivateHost(host: String?): Boolean {
        if (host == null) return false
        if (host == "localhost" || host == "127.0.0.1") return true
        val octets = host.split('.')
        if (octets.size != 4 || octets.any { it.toIntOrNull() == null }) return false
        val values = octets.map { it.toInt() }
        if (values.any { it !in 0..255 }) return false
        return values[0] == 10
            || values[0] == 192 && values[1] == 168
            || values[0] == 172 && values[1] in 16..31
            || values[0] == 169 && values[1] == 254
    }
}

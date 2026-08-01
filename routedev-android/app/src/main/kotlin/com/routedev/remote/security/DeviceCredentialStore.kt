package com.routedev.remote.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import com.routedev.remote.domain.DeviceCredentials
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

class DeviceCredentialStore(context: Context) {
    private val preferences = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    fun save(credentials: DeviceCredentials) {
        val payload = json.encodeToString(
            StoredCredentials.serializer(),
            StoredCredentials(
                credentials.baseUrl,
                credentials.deviceId,
                credentials.desktopName,
                credentials.token,
                credentials.scopes.toList(),
            ),
        ).encodeToByteArray()
        preferences.edit { putString(KEY_PAYLOAD, encrypt(payload)) }
    }

    fun load(): DeviceCredentials? {
        val encoded = preferences.getString(KEY_PAYLOAD, null) ?: return null
        return runCatching {
            val stored = json.decodeFromString(StoredCredentials.serializer(), decrypt(encoded).decodeToString())
            DeviceCredentials(
                stored.baseUrl,
                stored.deviceId,
                stored.desktopName,
                stored.token,
                stored.scopes.toSet(),
            )
        }.getOrNull()
    }

    fun clear() {
        preferences.edit { clear() }
        keyStore().deleteEntry(KEY_ALIAS)
    }

    fun notificationsEnabled(): Boolean =
        preferences.getBoolean(KEY_NOTIFICATIONS, false)

    fun setNotificationsEnabled(enabled: Boolean) {
        preferences.edit { putBoolean(KEY_NOTIFICATIONS, enabled) }
    }

    private fun encrypt(plain: ByteArray): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val combined = cipher.iv + cipher.doFinal(plain)
        return Base64.encodeToString(combined, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): ByteArray {
        val combined = Base64.decode(encoded, Base64.NO_WRAP)
        require(combined.size > IV_SIZE)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            secretKey(),
            GCMParameterSpec(128, combined.copyOfRange(0, IV_SIZE)),
        )
        return cipher.doFinal(combined.copyOfRange(IV_SIZE, combined.size))
    }

    private fun secretKey(): SecretKey {
        val store = keyStore()
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    }

    private fun keyStore(): KeyStore =
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @Serializable
    private data class StoredCredentials(
        val baseUrl: String,
        val deviceId: String,
        val desktopName: String,
        val token: String,
        val scopes: List<String>,
    )

    private companion object {
        const val FILE_NAME = "device_credentials"
        const val KEY_PAYLOAD = "payload"
        const val KEY_NOTIFICATIONS = "notifications_enabled"
        const val KEY_ALIAS = "routedev_remote_device_token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_SIZE = 12
    }
}

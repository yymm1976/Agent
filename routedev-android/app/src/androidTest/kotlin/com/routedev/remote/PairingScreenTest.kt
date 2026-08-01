package com.routedev.remote

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PairingScreenTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun unpairedAppExplainsSecureConnection() {
        composeRule.onNodeWithText("连接 RouteDev").assertIsDisplayed()
        composeRule.onNodeWithText("扫描二维码").assertIsDisplayed()
        composeRule.onNodeWithText("电脑连接地址").assertIsDisplayed()
    }
}
